# ADR-013: Adopt `@ship-it-ui/*` as the Web Design System

## Status

Accepted

## Date

2026-05-13

## Context

ShipIt-AI's Phase 1 scope (ADR-003) includes several user-facing surfaces — an onboarding wizard, a Graph Explorer, a Catalog browser, and a small set of dashboard / inspector views. ADR-012 commits the product to WCAG 2.1 AA accessibility from day one. To meet both the velocity expectations of Phase 1 and the accessibility floor in ADR-012, the web app needs:

1. A component library covering the primitive set used across the product (Buttons, Inputs, Tabs, Tables, Dialogs, Tooltips, Popovers, Filter panels, Empty states, Toasts, Skeletons, Sidebar / Topbar chrome, etc.).
2. A theming primitive that supports light / dark / high-contrast modes without per-component CSS forks (ADR-012 requires a high-contrast mode preference).
3. A graph rendering layer that already understands the entity-type registry the rest of the product needs (node glyphs, tone colors, per-type styling).
4. A typed surface (TypeScript) consistent with ADR-001's TS-first commitment.

The realistic options at the start of the UI redesign were:

- **Build everything from primitives** (Radix + Tailwind directly, or HeadlessUI). Maximum flexibility, maximum cost. Phase 1 cannot absorb that build.
- **Pick a generic library** (shadcn/ui, MUI, Mantine). Accelerates non-graph chrome, but graph visualization, entity-type theming, and ShipIt-specific patterns (`GraphInspector`, `EntityCard`, `ConnectorCard`, `CommandPalette`, etc.) still need to be hand-rolled and kept consistent with the rest of the design language.
- **Use `@ship-it-ui/*`** — a sibling design system maintained in lockstep with the ShipIt design language. It ships:
  - `@ship-it-ui/tokens` — design tokens (colors, spacing, type, motion) as CSS variables with theme switching built in.
  - `@ship-it-ui/ui` — primitive and pattern components (Buttons, Inputs, FilterPanel, DataTable, Dialog, Tabs, Sidebar, NavItem, Topbar, EmptyState, Skeleton, Toast, Tooltip, Popover, plus utilities like `formatRelative`, `cn`, `useTheme`).
  - `@ship-it-ui/icons` — the glyph registry used by every surface.
  - `@ship-it-ui/shipit` — domain components (`GraphInspector`, `GraphLegend`, `EntityBadge`, `EntityCard`, `ConnectorCard`, `AskBar`, `CopilotMessage`) and the shared entity-type registry (`registerEntityTypes`, `getEntityTypeMeta`, `listEntityTypes`).
  - `@ship-it-ui/cytoscape` — Cytoscape wrapper preconfigured with the ShipIt node / edge styling, hooked into the entity-type registry.
  - `@ship-it-ui/next` — Next.js-specific helpers (theme provider, font setup, SSR-safe primitives).

The packages are versioned together, share a single token surface, and are built specifically around the data shapes ShipIt-AI uses (entity types, claim badges, graph inspectors). The accessibility primitives (focus rings, keyboard handling, ARIA, `prefers-reduced-motion` support) are baked into the library.

## Decision

The ShipIt-AI web UI (`packages/web-ui`) standardizes on `@ship-it-ui/*` as its design system. Concretely:

- All primitive components (Button, Input, Card, Dialog, Tabs, Tooltip, Popover, FilterPanel, EmptyState, Spinner, Skeleton, Toast, Sidebar, NavItem, NavSection, Topbar, Badge, etc.) are sourced from `@ship-it-ui/ui`. We do not introduce a second primitive library (no shadcn, no MUI, no Mantine) alongside it.
- All iconography goes through `@ship-it-ui/icons` (`IconGlyph` + the unicode glyph map). Connector logos use `connectorGlyphs`. We do not introduce an icon font.
- The graph canvas uses `@ship-it-ui/cytoscape`'s `GraphCanvas` wrapper, configured at the app level with the engine, theme tokens, and the shared entity-type registry. We do not call `cytoscape` directly from app code except for layout config and the live `cy` handle.
- The entity-type registry is initialized once at app boot via `registerEntityTypes` in `src/lib/entity-types.ts`. Every UI surface that needs a glyph, label, tone, or badge variant for a node type reads it from `getEntityTypeMeta`. No surface maintains its own type → presentation mapping.
- Theme switching uses `@ship-it-ui/ui`'s `useTheme` hook and the CSS-variable token surface from `@ship-it-ui/tokens`. Custom CSS may only set values on these tokens; component-level color hex codes are not allowed.
- Tailwind is permitted for layout (flex, grid, spacing, sizing), but color, typography, and motion classes resolve to design tokens via the configured Tailwind theme — not raw values.

Custom components are written when a ShipIt-specific concern is not in the library (e.g., the `Sidebar` composition with grouped nav sections and a collapsed-rail mode in `src/components/layout/sidebar.tsx`, the `Catalog` table at `src/app/catalog/page.tsx`). When we do this, we compose the library's primitives — we don't reimplement them.

Version management: `@ship-it-ui/*` packages share a release train and are upgraded together via a single pnpm bump. The peer-dep rule in the root `package.json` allows the design system to track newer React / Next majors than its own peer ranges declare.

## Consequences

### Positive

- **Accessibility floor inherited.** Focus management, ARIA wiring, keyboard handling, and `prefers-reduced-motion` are implemented once in the library. Meeting ADR-012's WCAG 2.1 AA target becomes a question of using the components correctly, not building accessibility from scratch per surface.
- **Theming is unified.** Light / dark / high-contrast modes flip via a single token surface. We never need to audit the codebase for "did we use the right shade of grey here" — the variable is the only correct answer.
- **Domain components save weeks.** `GraphInspector`, `GraphLegend`, `EntityBadge`, `EntityCard`, `ConnectorCard`, and the Cytoscape wrapper are pre-aligned with our data model. Building these in-house against a generic library would be a multi-week effort each.
- **Single source of truth for entity-type presentation.** The `registerEntityTypes` registry means a glyph or color change for `Deployment` propagates to the graph canvas, the catalog table, the inspector panel, and the legend without per-surface edits.
- **Lower bus factor on UI consistency.** The library enforces consistency by construction. Engineers can ship a new screen without re-litigating spacing, type scale, or focus-ring style.

### Negative

- **External coupling.** The web UI's velocity is tied to the `@ship-it-ui/*` release cadence. A bug in a primitive blocks our work until it's fixed upstream or worked around locally. **Mitigation:** `@ship-it-ui/*` is a sibling repository under our control; upstream fixes are cheap. Where we need to ship before an upstream change lands, we wrap (not fork) the offending component.
- **Version lockstep.** All `@ship-it-ui/*` packages move together. A version bump touches every UI surface. **Mitigation:** The packages are small and the release cadence is intentional; this is a routine maintenance task, not an emergent risk.
- **Custom needs require careful composition.** The library's `DataTable` does not currently support row-click handlers, so the Catalog page renders a small bespoke table that composes the library's `Badge`, `EmptyState`, and `FilterPanel`. Every such case is a tax we'd pay anyway with any pre-built table library; the cost is bounded because we already own the primitives. **Mitigation:** When we hit a gap twice, the right answer is an upstream contribution back to `@ship-it-ui/ui`, not a permanent local component.
- **React + Next major version coupling.** `@ship-it-ui/*` declares peer ranges. Adopting a new React major requires an upstream release first. **Mitigation:** The `pnpm.peerDependencyRules.allowedVersions` config lets us run ahead of the published peer ranges when we've validated compatibility manually, which is the standard pattern for monorepo-adjacent libraries.

### Neutral

- The library does not aim to be a generic design system. It is opinionated about the ShipIt aesthetic, the entity-type registry, and the graph canvas. We treat that opinionation as a feature: it removes design decisions per screen, not flexibility we wanted.

## Alternatives Considered

### Alternative 1: shadcn/ui + Radix + Tailwind

- **Pros:** Largest ecosystem. Copy-paste model means no version lockstep. Strong accessibility primitives via Radix.
- **Cons:** No graph rendering layer. No entity-type registry. No `GraphInspector` / `EntityBadge` / `ConnectorCard` patterns — every domain component is a from-scratch build. Every screen rewrites focus rings, badges, empty states. The aesthetic drift problem moves from "library version" to "every PR".
- **Why rejected:** The non-domain primitives are not where the cost lives. The cost lives in the ShipIt-specific compositions, which `@ship-it-ui/shipit` already ships.

### Alternative 2: MUI (Material UI)

- **Pros:** Comprehensive component coverage. Mature accessibility. Stable theming.
- **Cons:** Strongly Material-flavored visual design — fights the ShipIt brand at every screen. Theming is heavy and bundle-large. No graph rendering or entity-aware components. Tailwind interop is awkward.
- **Why rejected:** Brand fit is poor and the customization tax negates the velocity benefit.

### Alternative 3: Build from primitives (Radix + Tailwind, no design system)

- **Pros:** Maximum control. No external dependency to track.
- **Cons:** Multi-month effort to reach feature parity with what `@ship-it-ui/*` ships out of the box. Inconsistency across surfaces is a function of how many engineers build the primitives. Accessibility becomes a per-component audit rather than an inherited property.
- **Why rejected:** Phase 1 cannot afford it, and there is no version of "we'll build it properly later" that survives shipping deadlines.
