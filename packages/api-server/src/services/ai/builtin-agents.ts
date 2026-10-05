// Agents every instance has (design §Built-in agent). Seeded by the api-server
// at boot rather than by a migration, because the definition depends on the
// instance's model catalog. An admin may edit and republish one; it cannot be
// archived (AgentStore refuses), and the seed never overwrites an edit.
import { AgentSlugTakenError, type AgentDefinition, type AgentStore } from '@shipit-ai/agents';
import type { AiConfig } from '@shipit-ai/shared';

export const GRAPH_ASSISTANT_SLUG = 'graph-assistant';

const GRAPH_ASSISTANT_INSTRUCTIONS = `You answer questions about this organisation's software catalog, which is stored in a knowledge graph: services, repositories, teams, people, pipelines, deployments and how they relate.

Use the graph tools to look things up. Never guess an owner, a dependency or any other fact: if the graph does not say, say so.

Entities have canonical ids such as shipit://repository/default/<org>/<repo>. When you only know a name, find the id with search_entities first, then use the dedicated tools (find_owners, blast_radius, dependency_chain, entity_detail).

Answer briefly and directly. Name the entities you relied on, with their canonical ids, so the reader can check them.`;

// Kept well under the default ceilings: an assistant answering questions
// should not need a long run.
const LIMITS = { maxSteps: 12, maxTokens: 200_000, timeoutSeconds: 300, dailyTokens: 2_000_000 };

/**
 * Makes sure the built-in agents exist and are published. Returns false when
 * it cannot yet (no model configured); the caller tries again later.
 */
export async function ensureBuiltinAgents(
  store: AgentStore,
  ai: AiConfig,
  log: (message: string) => void,
): Promise<boolean> {
  const existing = await store.getBySlug(GRAPH_ASSISTANT_SLUG);
  if (existing) {
    // An earlier boot created it but stopped before publishing.
    if (existing.builtin && existing.publishedVersion === null) {
      await store.publish(existing.id, undefined, 'Built-in agent', 'system');
    }
    return true;
  }
  const model = ai.defaultModel || ai.models[0]?.key;
  if (!model) {
    log('Built-in Graph assistant not created yet: the instance offers no model (ai.models).');
    return false;
  }
  const definition: AgentDefinition = {
    instructions: GRAPH_ASSISTANT_INSTRUCTIONS,
    model,
    limits: {
      maxSteps: Math.min(LIMITS.maxSteps, ai.limits.maxSteps),
      maxTokens: Math.min(LIMITS.maxTokens, ai.limits.maxTokens),
      timeoutSeconds: Math.min(LIMITS.timeoutSeconds, ai.limits.timeoutSeconds),
      dailyTokens: Math.min(LIMITS.dailyTokens, ai.limits.dailyTokens),
    },
    grants: { services: { graph: { read: 'allow', write: 'off', delete: 'off' } }, tools: {} },
    output: { schema: null },
  };
  try {
    const agent = await store.create({
      slug: GRAPH_ASSISTANT_SLUG,
      name: 'Graph assistant',
      description: 'Answers questions about the catalog from the knowledge graph. Read-only.',
      definition,
      builtin: true,
      actor: 'system',
    });
    await store.publish(agent.id, undefined, 'Built-in agent', 'system');
    log(`Created the built-in Graph assistant on model ${model}.`);
  } catch (err) {
    // Another api-server replica created it first.
    if (!(err instanceof AgentSlugTakenError)) throw err;
  }
  return true;
}
