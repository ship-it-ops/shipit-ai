# ADR-010: Identity Resolution Phasing

## Status

Accepted

## Date

2026-02-28

## Context

ShipIt-AI ingests entity data from multiple connectors (GitHub, Kubernetes, Backstage, Datadog, PagerDuty), and the same real-world entity often appears in multiple sources under different names. For example:

- GitHub repo: `acme-org/payment-service`
- Kubernetes Deployment: `payment-svc` in namespace `payments`
- Backstage catalog: `payment-service` with annotation `github.com/project-slug: acme-org/payment-service`
- Datadog service: `payment-service-prod`

The Core Writer must determine that these four records represent the same logical entity and merge them into a single node in the knowledge graph. This is the **identity resolution** problem.

The v0.2 design document specified a full identity resolution engine with fuzzy matching, vector embedding similarity, and a Reconciliation UI. Building this entire system in Phase 1 is excessive given that Phase 1 has only two connectors (GitHub and Kubernetes) and the matching signals available are limited.

### Resolution complexity spectrum

Identity resolution ranges from trivial to hard:

1. **Primary key match** (trivial): Two records share the same `canonical_id`. This is a direct merge with no ambiguity.
2. **Linking key match** (easy): A Kubernetes Deployment has annotation `shipit.ai/github-repo: acme-org/payment-service`, directly linking it to the GitHub entity. Each schema node type declares `linking_keys` that map to properties from specific sources.
3. **Fuzzy name match** (moderate): The GitHub repo is `payment-service` and the K8s Deployment is `payment-svc`. These are probably the same entity but require a similarity score to confirm.
4. **Semantic match** (hard): The GitHub repo is `billing-engine` and the Backstage entry is `Payment Processing Service`. These are the same entity but require understanding of the domain to match them.

Phase 1 connectors (GitHub + Kubernetes) provide sufficient signal for Steps 1-2. Kubernetes annotations and GitHub topics/descriptions provide explicit linking keys. Fuzzy matching and semantic matching become valuable when Phase 2 connectors (Backstage, Datadog, PagerDuty) introduce entities with inconsistent naming conventions.

## Decision

Identity resolution will be implemented in two phases, with a clear boundary between deterministic matching and probabilistic matching.

### Phase 1: Deterministic Matching (Steps 1-2)

The Core Writer applies two resolution steps in order:

**Step 1: Primary Key Match**

- When a connector emits an entity event, the Core Writer checks if a node with the same `canonical_id` already exists in Neo4j.
- `canonical_id` format: `{source}:{entity_type}:{source_specific_id}` (e.g., `github:Repository:acme-org/payment-service`).
- If a match is found, the existing node is updated (properties merged, claims updated per ADR-002).
- If no match is found, proceed to Step 2.

**Step 2: Linking Key Match**

- The Core Writer checks the entity's properties against the `linking_keys` defined in the schema (ADR-006) for all existing nodes of compatible types.
- Example: A Kubernetes Deployment with annotation `shipit.ai/github-repo: acme-org/payment-service` matches the GitHub Repository with `github_slug: acme-org/payment-service`.
- Linking key matches result in a merge: the two nodes are combined into a single entity node with claims from both sources.
- If multiple linking keys match different existing nodes, the Core Writer logs a conflict warning and does not merge automatically. The conflict is surfaced via the MCP response envelope warnings (ADR-008, code: `CONFLICTING_CLAIMS`).

**Cross-label matching restriction:** In Phase 1, identity resolution only matches entities of the same label (e.g., Service-to-Service) or entities with a declared linking key relationship across labels. Arbitrary cross-label matching (e.g., determining that a Repository and a Deployment represent the same logical service) is handled by explicit relationship creation in connectors, not by identity resolution.

**Entity rename detection:** When a connector reports an entity with a known `source_specific_id` but a different `name`, the Core Writer treats this as a rename. The `canonical_id` remains stable (it uses `source_specific_id`, not `name`), the `name` property is updated, and a `RENAMED_FROM` claim is added to `_claims` for audit purposes.

### Phase 2: Probabilistic Matching (Steps 3-4)

**Step 3: Fuzzy Matching**

When deterministic matching (Steps 1-2) fails, the Core Writer computes a similarity score using weighted features:

| Feature        | Weight | Method                                          |
| -------------- | ------ | ----------------------------------------------- |
| Name           | 0.5    | Normalized Levenshtein distance + token overlap |
| Namespace/Org  | 0.2    | Exact or prefix match                           |
| Tags/Labels    | 0.2    | Jaccard similarity of tag sets                  |
| Labels (Neo4j) | 0.1    | Same node label bonus                           |

The composite score is computed as: `score = sum(weight_i * similarity_i)`.

- **Score >= 0.85:** Automatic merge. The entities are combined with a `LOW_CONFIDENCE` warning if score < 0.90.
- **Score 0.70 - 0.84:** Candidate match. Queued for human review in the Reconciliation UI.
- **Score < 0.70:** No match. The entity is created as a new node.

**Step 4: Vector Embedding Similarity (Phase 2, requires ADR-005 vector DB)**

When the vector database is available (Phase 2+), the Core Writer also computes embedding similarity:

- Generate an embedding for the entity's combined text (name + description + tags).
- Query Weaviate for the nearest neighbors among existing entities.
- Embedding similarity is added as an additional feature with weight 0.3 (other weights are proportionally reduced).

This improves matching for semantically similar but lexically different entities (e.g., `billing-engine` vs. `Payment Processing Service`).

**Reconciliation UI (Phase 2)**

A web interface where operators can:

- Review candidate matches (score 0.70-0.84) and approve or reject them.
- View the evidence (which features matched, which diverged).
- Force-merge or force-split entities that were incorrectly resolved.
- Set permanent "do not merge" rules for entities that are frequently confused.

## Consequences

### Positive

- **Phase 1 is deterministic and predictable.** Primary key and linking key matches produce no false positives. Users can trust that merged entities are genuinely the same entity.
- **No human review burden in Phase 1.** Without fuzzy matching, there are no candidate matches to review. The system is fully automated for the Phase 1 use case.
- **Linking keys leverage connector knowledge.** Kubernetes annotations and GitHub topics provide high-confidence linking signals that connectors can explicitly emit. This is more reliable than heuristic name matching.
- **Clear upgrade path.** Phase 2 adds probabilistic matching on top of the deterministic foundation. The Phase 1 merge logic is not replaced -- it is extended.
- **Entity rename handling preserves graph stability.** Canonical IDs are based on source-specific IDs, not names, so renames do not create duplicate entities.

### Negative

- **Phase 1 misses some valid matches.** If a GitHub repo is named `payment-service` and the K8s Deployment is named `payment-svc` with no linking annotation, Phase 1 will create two separate entities. **Mitigation:** Users can add Kubernetes annotations (`shipit.ai/github-repo`) to create explicit links. Documentation will recommend this practice.
- **Linking key dependency.** Phase 1 resolution quality depends on connectors emitting linking keys. If a connector does not emit linking keys, its entities will not be matched to entities from other sources. **Mitigation:** The GitHub and Kubernetes connectors are designed to emit linking keys. The Connector SDK documentation emphasizes linking key emission as a best practice.
- **Phase 2 fuzzy matching introduces false positives.** The 0.85 threshold for automatic merge may occasionally merge distinct entities with similar names (e.g., `auth-service` and `auth-service-v2`). **Mitigation:** The threshold is configurable. The Reconciliation UI allows operators to split incorrectly merged entities. The `LOW_CONFIDENCE` warning in MCP responses alerts AI agents to potentially unreliable merges.

### Neutral

- The weighted feature model (name=0.5, namespace=0.2, tags=0.2, labels=0.1) is a starting point. Weights will be tuned based on real-world matching results in Phase 2 deployments.
- Cross-label matching (e.g., matching a Repository to a LogicalService) is always handled via explicit linking keys, never via fuzzy matching. This is a deliberate constraint to avoid the combinatorial explosion of cross-label similarity comparisons.

## Alternatives Considered

### Alternative 1: Full Fuzzy Matching in Phase 1

- **Pros:** Catches more valid matches from day one. Better graph completeness without requiring linking annotations.
- **Cons:** False positives erode trust. Requires a Reconciliation UI for human review, which is a significant frontend effort. Weighted scoring model needs tuning data that does not exist yet in Phase 1.
- **Why rejected:** The risk of false positives in a Phase 1 system with no review UI outweighs the benefit of catching additional matches. Deterministic matching with linking keys is sufficient for GitHub + Kubernetes.

### Alternative 2: External Identity Resolution Service (e.g., Senzing, Zingg)

- **Pros:** Mature, well-tested identity resolution algorithms. Handles complex matching scenarios. Reduces custom development.
- **Cons:** Additional infrastructure dependency. Licensing costs. Integration overhead. These tools are designed for customer/person matching, not infrastructure entity matching. The entity matching problem in ShipIt-AI is domain-specific (naming conventions, annotations, labels) and benefits from custom logic.
- **Why rejected:** The matching signals for infrastructure entities (canonical IDs, annotations, naming conventions) are well-understood and domain-specific. A general-purpose identity resolution engine adds complexity without proportional benefit.

### Alternative 3: Let Users Manually Link All Entities

- **Pros:** Zero false positives. No matching algorithm to maintain. Users have full control.
- **Cons:** Scales poorly. A deployment with 500 services across 3 connectors could require 1,500+ manual linking decisions. Defeats the automation purpose of ShipIt-AI.
- **Why rejected:** Manual linking is acceptable as an override mechanism (Phase 2 Reconciliation UI) but not as the primary resolution strategy. ShipIt-AI's value proposition is automated knowledge graph construction.
