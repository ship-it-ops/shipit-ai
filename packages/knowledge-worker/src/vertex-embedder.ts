// Embeddings through Vertex AI with Application Default Credentials. The AI
// SDK call is behind `embed` so tests pass a fake. The installed provider
// reports maxEmbeddingsPerCall = 1 for embedContent models, so `embedMany`
// issues one request per value; `maxParallelCalls` caps how many run at once
// (the SDK's default is unbounded). Names checked against
// @ai-sdk/google-vertex 5.0.101: `embeddingModel(id)` and provider options
// under the `vertex` key.
import { createVertex } from '@ai-sdk/google-vertex';
import { embedMany } from 'ai';
import { assertDimensions, type Embedder } from '@shipit-ai/knowledge';

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbedCall {
  model: string;
  values: string[];
  taskType: EmbeddingTaskType;
  outputDimensionality: number;
  title?: string;
  /** Upper bound on simultaneous requests for this call. */
  maxParallelCalls: number;
  /** Aborts at the call's deadline, or when the caller's own signal does. */
  signal: AbortSignal;
}

export interface VertexEmbedderOptions {
  project: string;
  location: string;
  model: string;
  dimensions: number;
  /** Simultaneous embedding requests per call. Default 4. */
  maxParallelCalls?: number;
  /** How long a call embedding this many texts may take. Default: `defaultTimeoutMs`. */
  timeoutMs?: (texts: number) => number;
  /** Test seam. Defaults to the AI SDK. */
  embed?: (call: EmbedCall) => Promise<number[][]>;
}

export const DEFAULT_MAX_PARALLEL_CALLS = 4;

/**
 * A call makes one request per text, a few at a time. A minute plus three
 * seconds a text is far more than a model that is answering needs, and it ends
 * a request that has stopped answering; never more than ten minutes, which
 * stays under the index loop's stall threshold.
 */
export const defaultTimeoutMs = (texts: number): number =>
  Math.min(10 * 60_000, 60_000 + 3_000 * texts);

export class VertexEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly maxParallelCalls: number;
  private readonly timeoutMs: (texts: number) => number;
  private readonly embed: (call: EmbedCall) => Promise<number[][]>;

  constructor(opts: VertexEmbedderOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.maxParallelCalls = opts.maxParallelCalls ?? DEFAULT_MAX_PARALLEL_CALLS;
    this.timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
    this.embed = opts.embed ?? makeAiSdkEmbed(opts.project, opts.location);
  }

  async embedDocuments(
    texts: string[],
    options?: { title?: string; signal?: AbortSignal },
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors = await this.call(
      {
        model: this.model,
        values: texts,
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: this.dimensions,
        title: options?.title,
        maxParallelCalls: this.maxParallelCalls,
      },
      options?.signal,
    );
    assertDimensions(vectors, this.dimensions);
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.call({
      model: this.model,
      values: [text],
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: this.dimensions,
      maxParallelCalls: this.maxParallelCalls,
    });
    assertDimensions([vector!], this.dimensions);
    return vector!;
  }

  // Every call gets a deadline. Without one a request the model never answers
  // holds its document, and a slot of the index loop, for as long as the HTTP
  // client waits, while the worker still looks healthy.
  private async call(input: Omit<EmbedCall, 'signal'>, caller?: AbortSignal): Promise<number[][]> {
    const texts = input.values.length;
    const ms = this.timeoutMs(texts);
    const deadline = AbortSignal.timeout(ms);
    const signal = caller ? AbortSignal.any([deadline, caller]) : deadline;
    try {
      return await this.embed({ ...input, signal });
    } catch (err) {
      // The caller's own abort keeps its reason; a spent deadline says what happened.
      if (caller?.aborted) throw caller.reason instanceof Error ? caller.reason : err;
      if (deadline.aborted) {
        throw new Error(
          `Embedding ${texts} ${texts === 1 ? 'text' : 'texts'} took longer than ${ms} ms`,
        );
      }
      throw err;
    }
  }
}

function makeAiSdkEmbed(
  project: string,
  location: string,
): (call: EmbedCall) => Promise<number[][]> {
  const vertex = createVertex({ project, location });
  return async (call) => {
    const { embeddings } = await embedMany({
      model: vertex.embeddingModel(call.model),
      values: call.values,
      maxParallelCalls: call.maxParallelCalls,
      abortSignal: call.signal,
      providerOptions: {
        vertex: {
          outputDimensionality: call.outputDimensionality,
          taskType: call.taskType,
          ...(call.title ? { title: call.title } : {}),
        },
      },
    });
    return embeddings.map((e) => Array.from(e));
  };
}
