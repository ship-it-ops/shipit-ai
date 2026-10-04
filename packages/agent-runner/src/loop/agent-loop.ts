// The run loop: the one AgentRuntime implementation (design §Run lifecycle).
//
// It works as a state machine over the stored transcript. Each pass reads the
// last message and does the one thing that state needs:
//   - a user or tool message: call the model for the next step;
//   - an assistant message with tool calls: settle those calls (decide, run,
//     record) and append their results as one tool message;
//   - an assistant message without tool calls: end the run, or the chat turn.
// Because the decision is made from Postgres every time, resuming after a
// crash is the same code path as running normally.
import {
  RunLeaseLostError,
  resolveTools,
  type AgentLimits,
  type ResolvedTool,
  type RunErrorCode,
  type RunEvent,
  type RunRecord,
  type RunStore,
  type StartToolCallInput,
  type StoredMessage,
  type ToolCallRecord,
} from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import { ModelCallError, type ModelClient, type ModelStepResult } from '../model/model-client.js';
import {
  STEP_LIMIT_NOTE,
  isStepLimitNote,
  stepLimitNote,
  toolResultMessage,
} from '../model/messages.js';
import type { RunnerTool } from '../tools/runner-tool.js';

export type ProcessOutcome = 'finished' | 'waiting' | 'not_claimed' | 'lease_lost';

/** The seam the worker depends on; a hosted runtime could implement it later. */
export interface AgentRuntime {
  /** Claims the run and works on it until it ends, parks, or another worker takes it. */
  process(runId: string): Promise<ProcessOutcome>;
}

export interface AgentLoopOptions {
  runs: RunStore;
  model: ModelClient;
  /** Every tool the runner can offer; each run sees the ones its grants allow. */
  tools: RunnerTool[];
  /** The instance's model catalog (ai.models). */
  models: AiModelConfig[];
  /** Instance ceilings (ai.limits). The lower of these and the agent's own apply. */
  ceilings: AgentLimits;
  /** A tool result longer than this, as JSON, is truncated in the model's context. */
  toolResultChars: number;
  /** Identifies this worker in run leases. */
  owner: string;
  leaseSeconds?: number;
  renewEveryMs?: number;
  now?: () => Date;
  publish?: (event: RunEvent) => void;
  log?: (message: string) => void;
}

interface ToolCallRequest {
  callId: string;
  name: string;
  input: unknown;
}

interface Offered {
  resolved: ResolvedTool;
  tool: RunnerTool;
}

type AbortReason = 'cancelled' | 'lease_lost';

/** Steps and tokens counted against the limits: the run's, or a chat turn's. */
interface Usage {
  steps: number;
  tokens: number;
}

// A finished run's outcome, or a reason to stop without touching the run.
type Stop = { kind: 'end'; outcome: ProcessOutcome };

const LIVE_CALL: ReadonlySet<ToolCallRecord['status']> = new Set(['pending', 'executing']);

export class AgentLoop implements AgentRuntime {
  private readonly leaseSeconds: number;
  private readonly renewEveryMs: number;
  private readonly now: () => Date;

  constructor(private readonly opts: AgentLoopOptions) {
    this.leaseSeconds = opts.leaseSeconds ?? 60;
    this.renewEveryMs = opts.renewEveryMs ?? 5_000;
    this.now = opts.now ?? (() => new Date());
  }

  async process(runId: string): Promise<ProcessOutcome> {
    const run = await this.opts.runs.claim(runId, this.opts.owner, this.leaseSeconds);
    if (!run) return 'not_claimed';
    this.publish({ runId, status: 'running' });

    // The lease heartbeat doubles as the cancel check: a cancel request or a
    // takeover aborts whatever the run is waiting on.
    const control = new AbortController();
    const heartbeat = setInterval(() => {
      this.opts.runs.renewLease(runId, this.opts.owner, this.leaseSeconds).then(
        (lease) => {
          if (!lease.held) control.abort('lease_lost' satisfies AbortReason);
          else if (lease.cancelRequested) control.abort('cancelled' satisfies AbortReason);
        },
        (err: Error) => this.log(`run ${runId}: lease renewal failed: ${err.message}`),
      );
    }, this.renewEveryMs);

    try {
      return await this.drive(run, control.signal);
    } catch (err) {
      if (err instanceof RunLeaseLostError) return 'lease_lost';
      throw err;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async drive(claimed: RunRecord, signal: AbortSignal): Promise<ProcessOutcome> {
    const { runs } = this.opts;
    let run = claimed;
    const definition = run.definition;
    const model = this.opts.models.find((m) => m.key === definition.model);
    if (!model) {
      return this.fail(
        run,
        'MODEL_ERROR',
        `Model ${definition.model} is not offered on this instance.`,
      );
    }
    const limits = lowest(definition.limits, this.opts.ceilings);
    const offered = await this.offerTools(run, model);
    // A task run's limits cover the whole run. A chat run's step, token and
    // time limits cover one turn (from a user message to the answer): counted
    // over the whole conversation they would end every chat after a few
    // questions, since each step resends the transcript. The daily cap still
    // bounds what a conversation spends.
    const chat = run.mode === 'chat';
    const clockStart = chat ? this.now() : new Date(run.startedAt ?? Date.now());
    const base = chat ? { steps: run.steps, tokens: run.inputTokens + run.outputTokens } : null;
    const used = (r: RunRecord): Usage => ({
      steps: r.steps - (base?.steps ?? 0),
      tokens: r.inputTokens + r.outputTokens - (base?.tokens ?? 0),
    });

    for (;;) {
      const messages = await runs.listMessages(run.id);
      const last = messages.at(-1);
      if (last?.role === 'assistant') {
        const calls = toolCallsOf(last.content);
        if (calls.length > 0) {
          const results = await this.settleCalls(run, last.seq, calls, offered);
          const stopped = this.stopFor(signal);
          if (stopped === 'lease_lost') return 'lease_lost';
          await this.append(run, [toolResultMessage(results)]);
          continue;
        }
        if (run.mode === 'chat') {
          await runs.waitForInput(run.id, this.opts.owner);
          this.publish({ runId: run.id, status: 'waiting_input' });
          return 'waiting';
        }
        return this.end(run, { status: 'succeeded', output: { text: textOf(last.content) } });
      }

      const blocked = await this.checkBeforeStep(run, used, limits, clockStart, signal);
      if (blocked) return blocked.outcome;
      if (isLastStep(used(run), limits) && !isStepLimitNote(last?.content)) {
        await this.append(run, [stepLimitNote()]);
        continue;
      }

      const step = await this.callModel(
        run,
        used(run),
        model,
        definition,
        messages,
        offered,
        limits,
        clockStart,
        signal,
      );
      if ('kind' in step) return step.outcome;
      if (step.finish === 'refusal') {
        await runs.recordStep(run.id, step.usage);
        return this.fail(run, 'MODEL_REFUSED', step.text || 'The model declined to answer.');
      }
      if (step.messages.length === 0 || (step.finish === 'error' && step.toolCalls.length === 0)) {
        await runs.recordStep(run.id, step.usage);
        return this.fail(run, 'MODEL_ERROR', 'The model stopped without an answer.');
      }
      const lastStep = isLastStep(used(run), limits);
      await this.append(run, step.messages);
      run = await runs.recordStep(run.id, step.usage);
      if (lastStep && step.toolCalls.length > 0) {
        // Asked to answer, the model called a tool anyway. Nothing runs past
        // the limit: the call stays in the transcript, unrun.
        return this.fail(
          run,
          'STEP_LIMIT',
          `The run reached its limit of ${limits.maxSteps} model steps.`,
        );
      }
      if (step.finish === 'length' && step.toolCalls.length === 0) {
        await runs.addWarning(run.id, "The answer was cut off at the model's output limit.");
      }
    }
  }

  /** The tools this run may offer, with a warning for each grant it cannot honour. */
  private async offerTools(run: RunRecord, model: AiModelConfig): Promise<Map<string, Offered>> {
    const byId = new Map(this.opts.tools.map((t) => [t.descriptor.id, t]));
    const { tools, warnings } = resolveTools(
      run.definition,
      this.opts.tools.map((t) => t.descriptor),
      run.writePolicy,
    );
    const notes = [...warnings];
    let allowed = tools.filter((t) => t.policy === 'allow');
    for (const t of tools.filter((t) => t.policy === 'ask')) {
      // Approvals arrive with Milestone 3. Until then a tool that must ask is
      // not offered at all, rather than offered and then refused.
      notes.push(
        `${t.id} needs approval before it runs. Approvals are not available yet, so it was not offered.`,
      );
    }
    if (!model.tools && allowed.length > 0) {
      notes.push(`Model ${model.key} cannot call tools, so none were offered.`);
      allowed = [];
    }
    if (run.definition.output.schema) {
      notes.push('Structured output is not available yet; the run returns text.');
    }
    for (const note of notes) await this.opts.runs.addWarning(run.id, note);
    return new Map(allowed.map((t) => [t.modelName, { resolved: t, tool: byId.get(t.id)! }]));
  }

  /** Cancel, limits and the daily cap, checked before every model step. */
  private async checkBeforeStep(
    run: RunRecord,
    used: (run: RunRecord) => Usage,
    limits: AgentLimits,
    clockStart: Date,
    signal: AbortSignal,
  ): Promise<Stop | null> {
    const stopped = this.stopFor(signal);
    if (stopped === 'lease_lost') return { kind: 'end', outcome: 'lease_lost' };
    const current = (await this.opts.runs.get(run.id)) ?? run;
    if (stopped === 'cancelled' || current.cancelRequested) {
      return { kind: 'end', outcome: await this.end(run, { status: 'cancelled' }) };
    }
    const failWith = async (code: RunErrorCode, message: string): Promise<Stop> => ({
      kind: 'end',
      outcome: await this.fail(run, code, message),
    });
    const spent = used(current);
    if (spent.steps >= limits.maxSteps) {
      return failWith('STEP_LIMIT', `The run reached its limit of ${limits.maxSteps} model steps.`);
    }
    if (spent.tokens >= limits.maxTokens) {
      return failWith(
        'BUDGET_EXCEEDED',
        `The run used ${spent.tokens} tokens, over its limit of ${limits.maxTokens}.`,
      );
    }
    if (this.now().getTime() - clockStart.getTime() >= limits.timeoutSeconds * 1000) {
      return failWith('TIMEOUT', `The run passed its timeout of ${limits.timeoutSeconds} seconds.`);
    }
    const today = await this.opts.runs.tokensSince(run.agentId, startOfUtcDay(this.now()));
    if (today >= limits.dailyTokens) {
      return failWith(
        'DAILY_LIMIT',
        `The agent used ${today} tokens today, over its daily limit of ${limits.dailyTokens}.`,
      );
    }
    return null;
  }

  private async callModel(
    run: RunRecord,
    spent: Usage,
    model: AiModelConfig,
    definition: RunRecord['definition'],
    messages: Array<{ content: StoredMessage }>,
    offered: Map<string, Offered>,
    limits: AgentLimits,
    clockStart: Date,
    signal: AbortSignal,
  ): Promise<ModelStepResult | Stop> {
    // The step may run until the run's timeout, and no longer.
    const remainingMs = clockStart.getTime() + limits.timeoutSeconds * 1000 - this.now().getTime();
    // On the last step the run may take, ask for an answer: a model still
    // exploring would otherwise spend the whole budget and end with nothing.
    // The note is in the instructions and (stepLimitNote) at the end of the
    // transcript. The tools stay declared: with them gone from a transcript
    // that used them, Gemini invents tool names instead of answering (seen live).
    const instructions = isLastStep(spent, limits)
      ? `${definition.instructions}\n\n${STEP_LIMIT_NOTE}`
      : definition.instructions;
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(remainingMs, 1))]);
    try {
      return await this.opts.model.step({
        model,
        instructions,
        messages: messages.map((m) => m.content),
        tools: [...offered.values()].map(({ resolved }) => ({
          name: resolved.modelName,
          description: resolved.description,
          inputSchema: resolved.inputSchema,
        })),
        ...(definition.effort ? { effort: definition.effort } : {}),
        signal: stepSignal,
      });
    } catch (err) {
      if (!(err instanceof ModelCallError)) throw err;
      if (err.code !== 'ABORTED') {
        return { kind: 'end', outcome: await this.fail(run, err.code, err.message) };
      }
      const stopped = this.stopFor(signal);
      if (stopped === 'lease_lost') return { kind: 'end', outcome: 'lease_lost' };
      if (stopped === 'cancelled') {
        return { kind: 'end', outcome: await this.end(run, { status: 'cancelled' }) };
      }
      return {
        kind: 'end',
        outcome: await this.fail(
          run,
          'TIMEOUT',
          `The run passed its timeout of ${limits.timeoutSeconds} seconds.`,
        ),
      };
    }
  }

  /**
   * Resolves every call of one model step and returns their results in call
   * order. A call with a finished audit row reuses that row's result (the
   * runner stopped after recording it). Reads run in parallel; writes and
   * deletes run one at a time, after the reads.
   */
  private async settleCalls(
    run: RunRecord,
    messageSeq: number,
    calls: ToolCallRequest[],
    offered: Map<string, Offered>,
  ): Promise<Array<{ callId: string; name: string; output: unknown }>> {
    const { runs } = this.opts;
    const recorded = new Map((await runs.listToolCalls(run.id)).map((c) => [c.callId, c]));
    const outputs: unknown[] = new Array(calls.length);
    const reads: Array<() => Promise<void>> = [];
    const writes: Array<() => Promise<void>> = [];

    calls.forEach((call, i) => {
      const prior = recorded.get(call.callId);
      if (prior && !LIVE_CALL.has(prior.status)) {
        outputs[i] = this.resultOf(prior);
        return;
      }
      const entry = offered.get(call.name);
      if (!entry) {
        reads.push(async () => {
          const error = {
            code: 'UNKNOWN_TOOL',
            message: `There is no tool named ${call.name}. Use only the tools you were given.`,
          };
          await runs.startToolCall({
            runId: run.id,
            callId: call.callId,
            messageSeq,
            toolId: call.name,
            service: null,
            effect: null,
            policy: 'off',
            decision: 'deny',
            status: 'denied',
            input: call.input ?? null,
            error,
          });
          outputs[i] = { error };
        });
        return;
      }
      const { resolved, tool } = entry;
      const base = {
        runId: run.id,
        callId: call.callId,
        messageSeq,
        toolId: resolved.id,
        service: resolved.service,
        effect: resolved.effect,
        policy: resolved.policy,
        decision: 'allow' as const,
        input: call.input ?? null,
      };
      // A write or delete that was running when the runner stopped is never
      // repeated (design decision 13): the model is told to check first.
      if (prior?.status === 'executing' && resolved.effect !== 'read') {
        writes.push(async () => {
          const error = {
            code: 'OUTCOME_UNKNOWN',
            message:
              'The runner stopped while this call was running, so it may or may not have taken effect. Check its result before trying again.',
          };
          await runs.finishToolCall(prior.id, { status: 'outcome_unknown', error });
          outputs[i] = { error };
        });
        return;
      }
      const parsed = tool.parse(call.input);
      if (!parsed.ok) {
        reads.push(async () => {
          const error = { code: 'INVALID_INPUT', message: parsed.message };
          await runs.startToolCall({ ...base, status: 'failed', error });
          outputs[i] = { error };
        });
        return;
      }
      (resolved.effect === 'read' ? reads : writes).push(async () => {
        outputs[i] = await this.execute(base, tool, parsed.value);
      });
    });

    await Promise.all(reads.map((task) => task()));
    for (const task of writes) await task();
    return calls.map((call, i) => ({ callId: call.callId, name: call.name, output: outputs[i] }));
  }

  /** Runs one call with its audit row written before and after. */
  private async execute(
    base: Omit<StartToolCallInput, 'status'>,
    tool: RunnerTool,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const { runs } = this.opts;
    const row = await runs.startToolCall({ ...base, status: 'executing' });
    try {
      const output = await tool.execute(input);
      const fitted = this.fit(output);
      await runs.finishToolCall(row.id, {
        status: 'succeeded',
        output: output ?? null,
        outputTruncated: fitted.truncated,
      });
      return fitted.value;
    } catch (err) {
      const error = { code: 'TOOL_ERROR', message: (err as Error).message };
      await runs.finishToolCall(row.id, { status: 'failed', error });
      return { error };
    }
  }

  /** The result a recorded call gives the model. */
  private resultOf(call: ToolCallRecord): unknown {
    if (call.status === 'succeeded') return this.fit(call.output).value;
    return { error: call.error };
  }

  /** A result too long for context is cut, with a note; the audit row keeps it whole. */
  private fit(output: unknown): { value: unknown; truncated: boolean } {
    const text = JSON.stringify(output ?? null);
    const limit = this.opts.toolResultChars;
    if (text.length <= limit) return { value: output ?? null, truncated: false };
    return {
      value: {
        truncated: true,
        note: `Result truncated to ${limit} of ${text.length} characters.`,
        content: text.slice(0, limit),
      },
      truncated: true,
    };
  }

  private async append(run: RunRecord, messages: StoredMessage[]): Promise<void> {
    const appended = await this.opts.runs.appendMessages(run.id, messages, this.opts.owner);
    const last = appended.at(-1);
    if (last) this.publish({ runId: run.id, seq: last.seq });
  }

  private async end(
    run: RunRecord,
    outcome: { status: 'succeeded'; output: unknown } | { status: 'cancelled' },
  ): Promise<ProcessOutcome> {
    const done = await this.opts.runs.finish(run.id, outcome, this.opts.owner);
    if (done) this.publish({ runId: run.id, status: done.status });
    return 'finished';
  }

  private async fail(run: RunRecord, code: RunErrorCode, message: string): Promise<ProcessOutcome> {
    const done = await this.opts.runs.finish(
      run.id,
      { status: 'failed', error: { code, message } },
      this.opts.owner,
    );
    if (done) this.publish({ runId: run.id, status: done.status });
    return 'finished';
  }

  private stopFor(signal: AbortSignal): AbortReason | null {
    return signal.aborted ? (signal.reason as AbortReason) : null;
  }

  private publish(event: RunEvent): void {
    try {
      this.opts.publish?.(event);
    } catch (err) {
      this.log(`run ${event.runId}: publish failed: ${(err as Error).message}`);
    }
  }

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }
}

function isLastStep(spent: Usage, limits: AgentLimits): boolean {
  return spent.steps + 1 >= limits.maxSteps;
}

function lowest(own: AgentLimits, ceilings: AgentLimits): AgentLimits {
  return {
    maxSteps: Math.min(own.maxSteps, ceilings.maxSteps),
    maxTokens: Math.min(own.maxTokens, ceilings.maxTokens),
    timeoutSeconds: Math.min(own.timeoutSeconds, ceilings.timeoutSeconds),
    dailyTokens: Math.min(own.dailyTokens, ceilings.dailyTokens),
  };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The tool calls in a stored assistant message, in order. */
function toolCallsOf(message: StoredMessage): ToolCallRequest[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } =>
        (part as { type?: string })?.type === 'tool-call',
    )
    .map((part) => ({ callId: part.toolCallId, name: part.toolName, input: part.input }));
}

/** The text of a stored assistant message. */
function textOf(message: StoredMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        (part as { type?: string })?.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}
