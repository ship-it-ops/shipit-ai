# ADR-012: Accessibility Standards

## Status

Accepted

## Date

2026-02-28

## Context

ShipIt-AI includes a web-based UI for onboarding, schema exploration, entity browsing, claim inspection, and graph visualization. As a developer productivity tool used during incident response, the UI must be usable by all team members regardless of ability. Accessibility is not an afterthought or a compliance checkbox -- it is a core requirement because:

1. **Incident response is high-stress.** During incidents, operators are under cognitive load. Accessibility features (keyboard shortcuts, clear contrast, screen reader support) benefit all users, not just those with disabilities.
2. **Diverse teams.** Engineering teams include members with visual impairments, motor disabilities, color vision deficiency, and temporary disabilities (e.g., broken arm, migraine). Excluding any team member from incident response tooling is unacceptable.
3. **Regulatory and procurement requirements.** Enterprise customers may require WCAG compliance for procurement approval. Meeting accessibility standards early avoids costly retrofitting.
4. **Graph visualization is inherently challenging.** The Graph Explorer -- a key UI component -- uses a canvas-based force-directed graph layout. Canvas rendering is opaque to screen readers, and force-directed layouts produce unpredictable node positions. The Graph Explorer requires specific accessibility provisions that go beyond standard web form accessibility.

## Decision

All ShipIt-AI web UI components will conform to **WCAG 2.1 Level AA** standards. The following specific requirements apply:

### Keyboard Navigation

- All interactive elements (buttons, links, form fields, tabs, modals, dropdowns) must be reachable and operable via keyboard alone.
- Focus order must follow a logical reading sequence.
- Focus indicators must be visible (minimum 2px outline, contrast ratio >= 3:1 against adjacent colors).
- Custom keyboard shortcuts must not conflict with browser or screen reader shortcuts. All custom shortcuts must be documented and discoverable via a keyboard shortcut help dialog (`?` key).
- Modal dialogs must trap focus (Tab cycles within the modal, Escape closes it).
- The Graph Explorer must support keyboard navigation: arrow keys to move between nodes, Enter to select a node, Escape to deselect, Tab to move between the graph and the side panel.

### Screen Reader Support

- All interactive elements must have accessible names via visible labels, `aria-label`, or `aria-labelledby`.
- Dynamic content updates (e.g., sync progress, entity count changes) must use ARIA live regions (`aria-live="polite"` for non-urgent updates, `aria-live="assertive"` for errors).
- The Graph Explorer must provide screen reader descriptions of the current graph state: number of nodes, number of edges, currently selected node, and adjacent nodes. This is exposed via an ARIA live region that updates on navigation.
- Data tables (entity lists, claim tables) must use semantic `<table>`, `<thead>`, `<tbody>`, `<th>` markup with `scope` attributes.
- Form validation errors must be associated with their fields via `aria-describedby` and announced via live regions.

### Color and Contrast

- Text contrast ratio must meet WCAG AA minimums: 4.5:1 for normal text, 3:1 for large text (18px+ or 14px+ bold).
- UI component and graphical object contrast must be at least 3:1 against adjacent colors.
- Color must never be the sole indicator of meaning. All color-coded information (e.g., service tier badges, health status indicators, relationship types in the graph) must also have a text label, icon, or pattern differentiator.
- The Graph Explorer must use distinct shapes or patterns in addition to color to distinguish node types (e.g., circles for Services, squares for Repositories, diamonds for Deployments, hexagons for Teams).
- A high-contrast mode must be available as a user preference.

### Graph Explorer Accessible Alternative

Because canvas-based graph visualization is inherently inaccessible to screen readers and difficult for keyboard-only users, the Graph Explorer must provide an **alternative tabular view**:

- A table listing all nodes in the current view with columns: Name, Type, Tier, Owner, Connection Count.
- A table listing all edges with columns: Source, Relationship Type, Target.
- Sorting and filtering on all columns.
- Selecting a row in the node table highlights the corresponding node in the graph view (and vice versa).
- The tabular view is the default for screen reader users (detected via `prefers-reduced-motion` or an explicit user setting).

This tabular view is not a lesser experience -- it provides information density and filterability that the graph view does not. Some users will prefer it regardless of accessibility needs.

### Responsive Design

ShipIt-AI's UI is designed for the following viewport priorities:

| Priority  | Viewport | Min Width | Notes                                                                                                                                            |
| --------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary   | Desktop  | 1280px    | Full-featured experience. Graph Explorer, side panels, multi-column layouts.                                                                     |
| Secondary | Tablet   | 1024px    | Usable but with layout adjustments. Graph Explorer may use a simplified layout. Side panels become collapsible.                                  |
| Tertiary  | Mobile   | 320px     | Read-only access. Entity details, search results, and status views are available. Graph Explorer and schema editing are not available on mobile. |

- All touch targets on tablet and mobile must be at least 44x44px (WCAG 2.5.5).
- No horizontal scrolling on any supported viewport.
- The Graph Explorer is not available below 1024px width. On mobile viewports, the tabular alternative view is used exclusively.

### Implementation Standards

- Use semantic HTML elements (`<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<button>`, `<table>`) instead of generic `<div>` elements with ARIA roles.
- Heading hierarchy must be sequential (`h1` -> `h2` -> `h3`, no skipping).
- Images must have `alt` text. Decorative images use `alt=""`.
- Animations must respect `prefers-reduced-motion`. No auto-playing animations that cannot be paused.
- The Graph Explorer's force-directed layout animation must pause after initial render or on `prefers-reduced-motion`.
- Form elements must have associated `<label>` elements (not placeholder-only labels).

### Testing Requirements

- Automated accessibility testing via axe-core integrated into the CI/CD pipeline. All pages must pass axe-core with zero violations at the "critical" and "serious" levels.
- Manual keyboard navigation testing for all new features before merge.
- Screen reader testing (VoiceOver on macOS, NVDA on Windows) for major feature releases.

## Consequences

### Positive

- **Inclusive by design.** All team members can use ShipIt-AI during incident response, regardless of ability.
- **Better UX for everyone.** Keyboard shortcuts, clear contrast, logical focus order, and visible focus indicators improve the experience for all users, not just those with disabilities.
- **Enterprise procurement readiness.** WCAG 2.1 AA compliance is a common procurement requirement. Meeting it from the start avoids a costly retroactive accessibility audit and remediation.
- **Tabular alternative is genuinely useful.** The alternative table view for the Graph Explorer provides information density and filterability that benefits all users. It is an additional feature, not a compromise.
- **Reduced legal risk.** WCAG compliance reduces the risk of accessibility-related legal challenges under ADA, Section 508, or equivalent international regulations.

### Negative

- **Development overhead.** Accessibility-compliant components take 10-20% longer to build than non-compliant ones. Semantic HTML, ARIA attributes, focus management, and keyboard handlers add code. **Mitigation:** Using an accessible component library (e.g., Radix UI, React Aria) provides these features out of the box for standard components. The overhead is primarily in custom components (Graph Explorer).
- **Graph Explorer complexity.** The alternative tabular view and keyboard navigation for the canvas-based Graph Explorer is a significant implementation effort. **Mitigation:** The tabular view is a standard data table, which is straightforward to build. Keyboard navigation for the graph can use a simplified grid model (arrow keys move to adjacent nodes) rather than a full spatial navigation system.
- **Testing overhead.** Automated accessibility testing (axe-core) adds CI/CD time. Manual screen reader testing requires access to screen reader software and training. **Mitigation:** axe-core runs in under 5 seconds per page. Screen reader testing is required only for major releases, not every PR.
- **Design constraints.** Some visual designs that look good (low-contrast text, color-only indicators, thin focus outlines) are not WCAG-compliant. Designers must work within accessibility constraints. **Mitigation:** Accessible design is good design. Constraints produce clearer, more usable interfaces.

### Neutral

- WCAG 2.1 AA is the target, not AAA. AAA compliance has requirements (e.g., 7:1 contrast ratio for all text, sign language interpretation for all audio) that are disproportionate for a developer tool. AA is the industry standard for web applications.
- Mobile is read-only. This is a pragmatic decision based on the use case: platform engineers configuring infrastructure schemas or exploring blast radius graphs during incidents are not using phones. Mobile read-only access to entity details and status is sufficient.

## Alternatives Considered

### Alternative 1: WCAG 2.1 Level A Only

- **Pros:** Lower implementation effort. Level A is the minimum conformance level and covers the most critical accessibility requirements.
- **Cons:** Level A does not require sufficient color contrast (1.4.3 is AA), text resizing support (1.4.4 is AA), or focus visible indicators (2.4.7 is AA). These are essential for a usable developer tool.
- **Why rejected:** Level A is insufficient for a professional tool used during incident response. The gap between A and AA is modest in implementation effort but significant in usability.

### Alternative 2: Accessibility as a Phase 2 Concern

- **Pros:** Phase 1 moves faster without accessibility constraints. Accessibility is retrofitted after the core features are stable.
- **Cons:** Retrofitting accessibility is 3-5x more expensive than building it in from the start. Inaccessible patterns become embedded in the codebase and component library. Semantic HTML and focus management are foundational -- adding them later requires rewriting components.
- **Why rejected:** The cost of retrofitting is well-documented and universally exceeds the cost of building accessibility in from the start. Phase 1's UI scope (onboarding wizard, basic entity views) is small enough that the overhead is minimal.

### Alternative 3: Graph Explorer Only (No Tabular Alternative)

- **Pros:** Less development effort. The Graph Explorer is the flagship visualization.
- **Cons:** Canvas-based graph visualization is inaccessible to screen readers. Keyboard navigation on a force-directed graph is disorienting (nodes have no stable positions). Users with motor disabilities may struggle with the precision required to click small nodes.
- **Why rejected:** A graph visualization without an accessible alternative excludes users who cannot see or interact with the canvas. The tabular view is a genuine feature that adds value for all users, not just an accessibility workaround.
