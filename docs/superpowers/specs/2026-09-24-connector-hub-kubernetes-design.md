# Connector Hub — Kubernetes wizard and type-aware hub surfaces — design

**Date:** 2026-09-24
**Status:** Approved (design), pending implementation plan
**Scope split:** this is **Spec 2** of the Kubernetes connector work. Spec 1 (backend core +
infra brief) is `2026-09-16-kubernetes-connector-design.md` and shipped in PR #113.
**Deviation from Spec 1's outline:** Spec 1 §"Spec 2 outline" sketched a wider surface than this
document covers. §Non-goals records every sketched item this spec deliberately leaves out, so
nothing is lost by omission.

## Problem

The Kubernetes connector works end to end — poll, absence sweep, tiered repository linking,
`LogicalService` emission — but there is no way to create one from the product. The only paths
are hand-editing `shipit.config.local.yaml` or three sequenced `curl` calls
(`POST /kubernetes/credentials` → `POST /probe` → `POST /connectors`), with the credential-file
paths copied by hand between them. The Connector Hub lists Kubernetes as "Coming soon".

Two smaller problems fall out of the same gap:

- The hub's identity line is GitHub-shaped. `ConnectorCard` renders `connector.org` as the
  subtitle when `type === 'github'` and nothing otherwise; `ConnectorDetailDrawer` renders
  `{count} entities · {connector.org}` unconditionally, so a Kubernetes connector shows
  `entities · undefined`.
- The probe's per-kind RBAC verdict has no consumer. A cluster that denies `cronjobs` produces a
  connector that warns on every single sync, forever, with nothing at creation time having said so.

## Goal

An admin with cluster access can add a Kubernetes connector from the Connector Hub without
touching YAML or curl, and the hub renders it as honestly as it renders GitHub.

## Non-goals

These are out of scope, each with the reason:

- **ClusterRole YAML display + re-probe button.** Considered and declined during brainstorming
  (it was the third scope option). Partial access is _reported_ (§Step 2) and _acted on_ by
  preselecting kinds (§Step 3); teaching the UI to remediate RBAC is separate work.
- **`lib/entity-types.ts` registration for `Cluster`, `Namespace`, `BuildArtifact`,
  `Environment`** — sketched in Spec 1's outline. These are catalog/entity-page concerns, not
  hub surfaces, and the catalog already degrades gracefully for unregistered labels. Deferred to
  its own change.
- **Absent pill on catalog rows and an "include absent" toggle** — also from Spec 1's outline,
  also a catalog surface. The API and MCP layers already support `include_absent`; only the UI
  is missing, and it applies to every connector type, not just Kubernetes.
- **`dryRun` in the Review step.** Spec 1's outline suggested summarising the run via the SDK's
  `dryRun`. Rejected for v1: `dryRun` would need a new endpoint to be reachable from the browser,
  and the probe already answers the question the user has at that moment ("can ShipIt see my
  cluster?"). Revisit if users report surprise at what the first sync produced.
- **Watch / live updates, and more than one cluster per connector.** Both are Spec 1 decisions
  (poll on the existing scheduler; one instance per cluster) and unchanged here.
- **Editing access mode after creation.** The drawer stays read-only for credentials; changing
  access means deleting and re-adding. `PATCH /api/connectors/:id` already accepts an `access`
  block for API callers.

## Architecture

One new wizard component plus one small shared helper. No new backend endpoints — every call the
wizard makes already exists and shipped in #113.

**But the web-ui's own API layer is GitHub-shaped and has to be widened first.** Today
`lib/api.ts` declares `export type Connector = GitHubConnector`, `CreateConnectorInput.type` is
the literal `'github'`, `ProbeInput` requires `installationId`, and there is no function for the
credentials-upload route at all. None of the wizard's calls are expressible until that changes,
so it is the first unit of work, not an afterthought.

The ripple is small and bounded: exactly three places read a GitHub-only field off a `Connector`
(`connector-card.tsx:44`, and `connector-detail-drawer.tsx:175` and `:202`), and the first two
are already being rewritten here. `settings/webhooks-tab.tsx` looks like a fourth but takes
`WebhookConnectorStatus`, a different type, and is unaffected.

| File                                                        | Change                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/api.ts`                                                | Add `KubernetesConnector`; make `Connector` a discriminated union on `type`; widen `CreateConnectorInput` and `ProbeInput` to unions; add `uploadKubernetesCredentials()`. |
| `lib/hooks/use-connectors.ts`                               | Add `useUploadKubernetesCredentials()`.                                                                                                                                    |
| `components/connectors/add-kubernetes-connector-wizard.tsx` | **New.** Four-step `WizardDialog`.                                                                                                                                         |
| `components/connectors/add-connector-picker.tsx`            | `kubernetes` status `coming-soon` → `available`.                                                                                                                           |
| `app/(app)/connectors/page.tsx`                             | Render the new wizard on `activeWizard === 'kubernetes'`.                                                                                                                  |
| `lib/connector-subtitle.ts`                                 | **New.** Type-aware identity line, one source of truth.                                                                                                                    |
| `components/connectors/connector-card.tsx`                  | Use the helper instead of the `type === 'github'` ternary.                                                                                                                 |
| `components/connectors/connector-detail-drawer.tsx`         | Use the helper instead of bare `connector.org`; narrow the GitHub-only "Installation" row.                                                                                 |

The wizard follows `add-github-connector-wizard.tsx` exactly in its mechanics: `useState` per
field (not React Hook Form — see that file's header comment for why), `WizardStep[]` with
`canAdvance` gates, one-word step labels because `WizardDialog` allocates fixed-width indicator
slots.

### Why a separate wizard rather than one generic wizard

The GitHub wizard is 1592 lines, almost all of it GitHub App specifics (manifest flow, per-org
vs shared App forking, installation picker). Kubernetes shares none of it. `AddConnectorPicker`'s
header comment already anticipates this: "a future Kubernetes / Datadog wizard can be added
behind its own button without re-touching the GitHub flow." A generic wizard would need a
step-schema abstraction that two connector types cannot justify.

## Step model: Access · Connect · Configure · Review

Spec 1's outline named the steps Access · Scope · Configure · Review. This spec splits the probe
into its own **Connect** step and folds Scope into Configure, mirroring the GitHub wizard's
`App · Connect · Configure · Review`. The probe earns a step because it is where credentials are
validated before anything is persisted, and where the user learns their RBAC is incomplete —
both need room to render results, not a button tucked into a form.

### Step 1 — Access

A **cluster name** field (validated against `^[a-z0-9][a-z0-9-]{0,62}$`; required in every mode —
see the subsection below for why it lives here), then three selectable mode cards reusing the
GitHub wizard's `AppModeCard` visual pattern. `in-cluster` is selected by default.

- **`in-cluster`** — no fields. Copy states that it uses the ShipIt pod's ServiceAccount and needs
  the `shipit-reader` ClusterRole; links to `docs/connectors.md`. Availability is **not**
  pre-checked — the probe in step 2 is the check, and its `IN_CLUSTER_UNAVAILABLE` code carries a
  precise message already.
- **`kubeconfig`** — a textarea for the pasted kubeconfig. A context picker appears only when the
  upload response reports more than one context.
- **`token`** — `server` (https), `token`, optional CA PEM.

`canAdvance` requires a valid cluster name in every mode, plus: nothing further for in-cluster;
non-empty kubeconfig text for kubeconfig; `server` matching `^https://` and a non-empty token for
token mode.

**On Next**, the two credential modes `POST /api/connectors/kubernetes/credentials` with
`{ connectorId, mode, ... }`. The response's `kubeconfigPath` / `tokenPath` / `caDataPath` are
held in wizard state and become the `access` block in step 4. For kubeconfig the response also
carries `contexts` and `currentContext`, which seed the context picker.

#### Cluster name lives in this step, because the connector id is derived from it

The credentials route is keyed by `connectorId`, and it runs _before_ `POST /api/connectors`.
So the id must exist before the upload, which means the field it derives from must be collected
before the upload too. **Cluster name is therefore a step 1 field**, alongside access mode — the
step answers "which cluster, and how do I reach it":

```
id = `k8s-${clusterName}`   // clusterName already matches ^[a-z0-9][a-z0-9-]{0,62}$
```

with a numeric suffix on collision against `GET /api/connectors`. Deriving it here (rather than
from a placeholder, with a re-derive on submit) is what keeps the stored credential filenames
readable — `kubeconfig-k8s-prod-eu.yaml`, not a nonce — which matters when someone is looking at
the key dir during an incident. `canAdvance` gates on a valid cluster name in every mode.

This ordering is load-bearing and was the reason a review suggestion to make the credentials
route require an existing connector was rejected (see
`docs/agent/plans/kubernetes-connector-v1-followups.md` §"Deliberately not done").

**Re-entering step 1** after an upload (user goes back and switches mode) leaves the previous
credential file on disk. Acceptable: a subsequent upload for the same id overwrites it, and
`DELETE /api/connectors/:id` now removes credential files no surviving connector references.

### Step 2 — Connect

`POST /api/connectors/probe` with `{ type: 'kubernetes', access }` — the same access block the
connector will use, so what is validated is what will run.

On `ok: true`, render:

- **Cluster** — `cluster.version`.
- **Namespaces in scope** — the `namespaces` array, as chips. Empty is a warning, not an error:
  the default scope excludes `kube-*`, so an empty list means nothing else exists yet.
- **Per-kind access** — one row per kind with `ok` / `forbidden` / `error` / `skipped`.
- **The `probedNamespace` caveat** — an explicit line: _"Access measured against namespace
  `<probedNamespace>`. A namespace-scoped RoleBinding elsewhere can still fail at sync time."_
  Without it an all-green probe reads as a cluster-wide guarantee, which it is not.

`canAdvance` requires a successful probe. Forbidden kinds do **not** block (per the partial-RBAC
decision) — they raise a warning banner and feed step 3's preselection.

On `ok: false`, the step shows the failure and stays put. Probe codes map to human sentences
rather than raw codes:

| Code                                            | Message                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `IN_CLUSTER_UNAVAILABLE`                        | This ShipIt instance is not running inside a cluster. Use kubeconfig or token access.                                                        |
| `CREDENTIALS_UNREADABLE`                        | ShipIt cannot read the stored credential file. Re-upload it.                                                                                 |
| `UNAUTHORIZED`                                  | The cluster rejected these credentials.                                                                                                      |
| `API_UNREACHABLE`                               | ShipIt cannot reach the API server from its network.                                                                                         |
| `TIMEOUT`                                       | The cluster did not answer in time.                                                                                                          |
| `KUBECONFIG_INVALID`, `UNSUPPORTED_AUTH_PLUGIN` | Surface the validator's own message verbatim — it already names the offending field (`exec`, `auth-provider`, `proxy-url`, file references). |

### Step 3 — Configure

Fields, with the schema defaults from `kubernetesScopeSchema` / `kubernetesMappingSchema`:

- **Display name** — defaults to the cluster name collected in step 1. Stored **bare**, never
  `"Kubernetes · <name>"`: `connector-identity.ts` composes the type prefix at render time, and a
  pre-composed name is exactly the double-prefix bug (`connector-name-double-type-prefix`).
- **Namespaces** — include (default `['*']`) and exclude (default
  `['kube-system', 'kube-public', 'kube-node-lease']`) as editable chip lists, seeded from the
  probe's observed namespaces for discoverability.
- **Workload kinds** — checkboxes, **preselected to exactly the kinds that probed `ok`**. If none
  did, all four are selected and the warning from step 2 persists; the schema requires at least one.
- **Schedule** — reuse `schedule-field.tsx` (default `*/5 * * * *`).
- **Advanced** (collapsed by default) — `mapping.repoLink.githubOrg`, defaulted from the single
  existing GitHub connector's `org` when exactly one exists, else blank;
  `mapping.environment.label` (default `environment`); `mapping.ownership.teamLabel` (default
  `team`). The annotation key is shown read-only as guidance
  (`shipit.ai/github-repo`) since changing it is rare and the default is what the infra chart annotates.

Everything else in `kubernetesMappingSchema` (service `nameFrom`, `includeComponent`,
environment `namespaceRules`) keeps its schema default and is not exposed. YAML remains the
escape hatch, as it is for the GitHub connector's deeper knobs.

### Step 4 — Review

A read-only summary: cluster, access mode (never the credential _values_), namespace scope,
kinds, schedule, repo-link org. Submit `POST /api/connectors` with the full instance. On success,
close and let the hub's existing revalidation surface the new card.

On failure, stay on Review and show the error. `409`/`VERSION_CONFLICT` is not reachable here
(create, not update); a duplicate id surfaces as a validation error, and the id derivation's
collision suffix makes that unlikely.

## Type-aware hub surfaces

`lib/connector-subtitle.ts` exports one function:

```ts
// The line that tells a user WHICH instance this is, given its type.
// github → org; kubernetes → cluster name; unknown type → null (render nothing).
export function connectorSubtitle(connector: Connector): string | null;
```

- `ConnectorCard` replaces `connector.type === 'github' ? connector.org : undefined`.
- `ConnectorDetailDrawer` replaces `{count} entities · {connector.org}` with the helper, omitting
  the separator when it returns `null`.

A new connector type then needs one line here rather than an audit of every render site. This is
the narrow, two-consumer version of the `summarize` adapter Spec 1's outline anticipated; the
broader adapter can grow from it when a third type arrives and actually needs more than a subtitle.

**Entity counts and absent nodes:** `connectorInfo`'s count comes from existing API data and
excludes absent nodes, matching default reads everywhere else. No change; noted so the next reader
does not mistake a post-sweep dip for data loss.

## Testing

- **`add-kubernetes-connector-wizard.test.tsx`** (new), mirroring the GitHub wizard's test:
  mode switching; that `kubeconfig` mode posts to the credentials route and carries the returned
  path into the create payload; that `in-cluster` posts no credentials; that a probe failure
  blocks advancing; that `probedNamespace` is rendered.
- **Forbidden-kind preselection** — a probe returning `CronJob: 'forbidden'` leaves `CronJob`
  unchecked in step 3 and the other three checked. This is the one behaviour with no server-side
  counterpart, so it is the test most worth having.
- **`connector-subtitle.test.ts`** — github → org, kubernetes → cluster name, unknown → `null`.
- **Existing suites** must stay green; `connector-identity.test.ts` already covers the
  double-prefix rule the display-name default depends on.

No new backend tests: this spec adds no backend behaviour.

## Success criteria

1. From the Connector Hub, an admin creates a working Kubernetes connector for a cluster reachable
   by pasted kubeconfig, without YAML or curl, and the first scheduled sync succeeds.
2. On portal-demo (in-cluster, once the `shipit-reader` ClusterRole is deployed), the in-cluster
   mode probes all-`ok` and creates a connector that produces the Spec 1 success-criterion graph.
3. A cluster denying one kind produces a connector scoped to the other three, and its sync logs
   carry no recurring warning _for the denied kind_. (A pod/ReplicaSet rollup denial warns
   independently of kind selection — that is the `FORBIDDEN:pods` path, not this one.)
4. A Kubernetes card and its drawer both show the cluster name; neither renders `undefined`.

## Related

- `2026-09-16-kubernetes-connector-design.md` — Spec 1; §"Spec 2 outline" is the sketch this
  document supersedes.
- `docs/agent/decisions/kubernetes-connector-v1-design.md` — the decision record.
- `docs/agent/plans/kubernetes-connector-v1-followups.md` — post-merge follow-ups, including the
  credentials-route ordering constraint this wizard depends on.
- `docs/agent/briefs/infra-k8s-reader-clusterrole.md` — the ClusterRole that success criterion 2
  depends on.
- `docs/agent/scars/connector-name-double-type-prefix.md` — why the display name is stored bare.
