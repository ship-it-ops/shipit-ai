// Embeddings through Vertex AI with Application Default Credentials. The AI
// SDK call is behind `embed` so tests pass a fake; the default sends one
// request per batch of values (`embedMany` itself splits by the model's
// maxEmbeddingsPerCall). Names checked against @ai-sdk/google-vertex 5.0.101:
// `embeddingModel(id)` and provider options under the `vertex` key.
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
}

export interface VertexEmbedderOptions {
  project: string;
  location: string;
  model: string;
  dimensions: number;
  /** Test seam. Defaults to the AI SDK. */
  embed?: (call: EmbedCall) => Promise<number[][]>;
}

export class VertexEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly embed: (call: EmbedCall) => Promise<number[][]>;

  constructor(opts: VertexEmbedderOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.embed = opts.embed ?? makeAiSdkEmbed(opts.project, opts.location);
  }

  async embedDocuments(texts: string[], options?: { title?: string }): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors = await this.embed({
      model: this.model,
      values: texts,
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: this.dimensions,
      title: options?.title,
    });
    assertDimensions(vectors, this.dimensions);
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed({
      model: this.model,
      values: [text],
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: this.dimensions,
    });
    assertDimensions([vector!], this.dimensions);
    return vector!;
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
