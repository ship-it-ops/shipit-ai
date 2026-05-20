# ADR-006: Schema Configuration Phasing -- YAML First, Visual Editor Later

## Status

Accepted

## Date

2026-02-28

## Context

ShipIt-AI's ontology schema defines entity types, properties, relationships, and resolution strategies. Platform engineers need to customize this schema to match their organization's infrastructure topology. The v0.2 design document specified a full interactive visual Schema Editor UI as a Phase 1 deliverable, with drag-and-drop node creation, relationship drawing, and live graph preview.

### Why a visual editor is premature in Phase 1

1. **UX complexity.** A drag-and-drop schema editor that supports node types, properties with data types and resolution strategies, relationships with cardinality constraints, and validation feedback is a multi-month UX design and implementation effort. Building it well requires user research, iterative design, and accessibility considerations (see ADR-012).

2. **Target audience.** Phase 1 users are platform engineers who are comfortable with YAML, JSON, and configuration files. They already manage Kubernetes manifests, Helm charts, Terraform configs, and Backstage catalog-info.yaml files in YAML. A YAML schema file is a familiar format, not a barrier.

3. **Schema changes are infrequent.** The ontology schema is modified during initial setup and when new connectors are added. It is not a daily editing task. The edit frequency does not justify a rich visual editor in Phase 1.

4. **Scope discipline.** Phase 1 is already scoped tightly (see ADR-003). Adding a visual editor would consume 2-4 weeks of frontend development that could be spent on the onboarding wizard, MCP tools, or connector quality.

## Decision

Schema configuration will follow a three-phase progression:

### Phase 1: YAML/JSON Configuration File

The ontology is defined in a YAML file (`schema/ontology.yaml`) checked into the application repository. The file defines node types, properties, relationships, and resolution strategies.

Example structure:

```yaml
version: 1
node_types:
  LogicalService:
    description: 'A logical service representing a business capability'
    properties:
      name:
        type: string
        required: true
        description: 'Human-readable service name'
      tier_effective:
        type: string
        required: true
        default: 'tier-3'
        resolution_strategy: highest_tier_wins
        valid_values: ['tier-1', 'tier-2', 'tier-3']
      owner:
        type: string
        required: false
        resolution_strategy: priority_source
    linking_keys:
      - github_slug
      - backstage_name
      - k8s_app_label

  Repository:
    description: 'A source code repository'
    properties:
      name:
        type: string
        required: true
      url:
        type: string
        required: true
      default_branch:
        type: string
        default: 'main'

relationships:
  IMPLEMENTED_BY:
    from: LogicalService
    to: Repository
    cardinality: one-to-many
    required: true
    description: 'Links a service to its source repositories'

  OWNS:
    from: Team
    to: LogicalService
    cardinality: one-to-many
    required: false
```

The Core Writer validates this file on startup using a Zod schema and creates/updates the corresponding meta-nodes in Neo4j (see ADR-009).

A CLI command (`shipit schema validate`) checks the YAML file for errors without starting the server.

### Phase 2: Form-Based Schema Editor UI with Read-Only Preview

A web-based form UI that allows users to:

- Add, edit, and delete node types via form fields (not drag-and-drop).
- Define properties with dropdowns for data type and resolution strategy.
- Define relationships by selecting source and target node types.
- See a read-only visual preview of the schema as a graph diagram (rendered via a layout library, not interactive).
- Export the schema as YAML for version control.

The form-based editor is simpler to build and more accessible than a drag-and-drop canvas. The read-only preview provides visual feedback without the complexity of interactive graph editing.

### Phase 3: Full Interactive Visual Editor

A canvas-based visual editor where users can:

- Drag and drop node types onto a canvas.
- Draw relationship lines between nodes.
- Click on nodes to edit properties inline.
- See real-time validation feedback.
- Undo/redo changes.
- Export to YAML or apply directly to the running instance.

This requires significant frontend investment (canvas rendering, hit testing, layout algorithms, undo/redo state management) and is justified only when the user base includes non-technical users who cannot work with YAML.

## Consequences

### Positive

- **Phase 1 delivers faster.** No frontend development for schema editing. The YAML file approach is implemented as part of the Core Writer startup logic, which is already needed.
- **Familiar to the target audience.** Platform engineers work with YAML daily. The format, validation, and version control workflow are well-understood.
- **Version-controllable.** The YAML file lives in the repository, can be reviewed in pull requests, and has full Git history. This is better than a visual editor for auditing schema changes.
- **CLI-friendly.** Schema validation can be run in CI/CD pipelines, pre-commit hooks, or local development without a running server.

### Negative

- **Not accessible to non-technical users.** Business stakeholders or managers who want to understand or modify the schema cannot use a YAML file. **Mitigation:** The `schema_info` MCP tool provides a human-readable representation. Phase 2's form-based editor addresses this gap.
- **Error-prone YAML editing.** YAML syntax errors (indentation, quoting) can break the schema. **Mitigation:** The Zod validation on startup and the `shipit schema validate` CLI command catch errors before they affect the running system. Providing a well-commented default schema reduces copy-paste errors.
- **No visual overview in Phase 1.** Users cannot see the schema as a graph diagram until Phase 2. **Mitigation:** The `schema_info` MCP tool returns a structured representation that AI agents can describe narratively. A Cypher query against the meta-nodes (ADR-009) can also produce a textual overview.

### Neutral

- The YAML file remains the canonical source for schema definitions even after the visual editor ships. The UI reads from and writes to Neo4j meta-nodes, but the YAML export provides a portable, version-controlled backup.

## Alternatives Considered

### Alternative 1: Build the Full Visual Editor in Phase 1

- **Pros:** Best user experience from day one. Differentiator from competitors that offer only config-file approaches.
- **Cons:** 2-4 weeks of frontend development. Requires canvas rendering library, layout algorithms, accessibility compliance. Delays the walking skeleton.
- **Why rejected:** The engineering cost is disproportionate to the Phase 1 value. Platform engineers (the Phase 1 audience) prefer YAML. The visual editor becomes valuable when non-technical users are part of the audience (Phase 3).

### Alternative 2: JSON Schema File Instead of YAML

- **Pros:** JSON is more widely supported by tooling (JSON Schema validators, IDE auto-complete). No indentation sensitivity issues.
- **Cons:** JSON is more verbose than YAML. No comments. Less readable for human editing. Platform engineers are more accustomed to YAML for configuration.
- **Why rejected:** YAML is the standard for infrastructure configuration (Kubernetes, Helm, Backstage, Docker Compose). Using YAML aligns with the target audience's expectations. The Core Writer supports both YAML and JSON parsing, so JSON is available as an alternative if users prefer it.

### Alternative 3: GUI-Only Configuration (No YAML)

- **Pros:** Forces a consistent editing experience. No YAML syntax issues.
- **Cons:** Cannot be version-controlled in Git. Cannot be validated in CI/CD. Cannot be edited in a text editor. Not accessible via CLI. Blocks Phase 1 delivery on UI development.
- **Why rejected:** Eliminates the version control, CI/CD, and CLI benefits that platform engineers expect. A GUI-only approach is appropriate for end-user applications but not for infrastructure configuration tools.
