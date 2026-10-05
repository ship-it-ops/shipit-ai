// Opt-in checks against real models on Vertex AI. Not run in CI. They repeat
// the Milestone 1 probe (docs/agent/investigations/vertex-model-layer-probe.md)
// through the real ModelClient, so an SDK upgrade that breaks the round trip
// fails here first.
//
//   VERTEX_TEST_PROJECT=ship-it-ai-portal \
//   VERTEX_TEST_MODELS=gemini:gemini-3.8-flash,anthropic:claude-sonnet-5-5 \
//     pnpm --filter @shipit-ai/agent-runner test:live
//
// Needs Application Default Credentials (`gcloud auth application-default login`).
import { describe, it, expect } from 'vitest';
import type { StoredMessage } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import { VertexModelClient } from '../model/vertex-model-client.js';
import { toolResultMessage, userMessage } from '../model/messages.js';

const project = process.env.VERTEX_TEST_PROJECT ?? '';
const models: AiModelConfig[] = (process.env.VERTEX_TEST_MODELS ?? 'gemini:gemini-3.8-flash')
  .split(',')
  .map((entry) => {
    const [family, modelId] = entry.split(':') as [AiModelConfig['family'], string];
    return { key: modelId, label: modelId, family, modelId, contextWindow: 200_000, tools: true };
  });

const tools = [
  {
    name: 'graph__find_owners',
    description: 'Find the owners of an entity in the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: { entity: { type: 'string', description: 'Entity name or canonical id' } },
      required: ['entity'],
      additionalProperties: false,
    },
  },
];

describe.skipIf(!project)('VertexModelClient — live', () => {
  const client = new VertexModelClient({
    project,
    location: process.env.VERTEX_TEST_LOCATION ?? 'global',
  });
  const instructions =
    'You answer questions about a software knowledge graph. Always use the tools; never guess an owner.';

  it.each(models.map((m) => [`${m.family} ${m.modelId}`, m] as const))(
    '%s: calls the tool, survives a JSON round trip, and uses the result',
    async (_name, model) => {
      const signal = new AbortController().signal;
      const opening: StoredMessage[] = [userMessage('Who owns payments-api?')];
      const first = await client.step({ model, instructions, messages: opening, tools, signal });
      expect(first.finish).toBe('tool_calls');
      expect(first.toolCalls.map((c) => c.name)).toEqual(['graph__find_owners']);
      expect(first.usage.input).toBeGreaterThan(0);

      // The round trip a stored run makes: transcript -> JSON -> transcript.
      const stored = JSON.parse(JSON.stringify([...opening, ...first.messages])) as StoredMessage[];
      if (model.family === 'gemini') {
        // Without it the SDK silently injects a skip sentinel instead of failing.
        expect(JSON.stringify(stored)).toContain('thoughtSignature');
      }
      const results = toolResultMessage(
        first.toolCalls.map((c) => ({
          callId: c.callId,
          name: c.name,
          output: { owners: ['team-payments'], source: 'CODEOWNERS' },
        })),
      );
      const second = await client.step({
        model,
        instructions,
        messages: [...stored, results],
        tools,
        signal,
      });
      expect(second.finish).toBe('stop');
      expect(second.text).toContain('team-payments');
    },
    120_000,
  );
});
