# Infra brief — read-only ClusterRole for the Kubernetes connector + demo annotations

**For:** `Ship-It-Ops/shipit-ai-infra` (Helm chart `charts/shipit-ai`).
**From:** app repo, 2026-09-16.
**Status (2026-09-24):** DELIVERED AND VERIFIED on portal-demo (`ship-it-ai-portal` /
`shipit-demo`). Checked from the app side with kubectl:

- `ClusterRole/shipit-reader` exists with exactly the three rule groups below, and
  `ClusterRoleBinding/shipit-reader` binds it to `ServiceAccount shipit:api-server`.
- `kubectl auth can-i list <res> --as=system:serviceaccount:shipit:api-server
--all-namespaces` returns `yes` for all eight: namespaces, nodes, pods,
  deployments, replicasets, statefulsets, daemonsets, cronjobs.
- All five workloads carry `shipit.ai/github-repo: Ship-It-Ops/ShipIt-AI` — the four app
  Deployments plus the Redis StatefulSet.

STILL UNPROVEN end-to-end: no `k8s-demo` connector has been created on portal-demo, so the
graph half of §Verification (5 workload nodes + one `shipit-ai` LogicalService linked to the
repository) has not been observed. RBAC and annotations are proven; the sync is not. **Enables:** the in-cluster Kubernetes connector
(`docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md`, success criterion 1).

## What the app does

The api-server's scheduler runs a `kubernetes` connector that lists namespaces, nodes, pods,
deployments, replicasets, statefulsets, daemonsets and cronjobs — read-only — using the
pod's ServiceAccount when `access.mode: in-cluster`. It links workloads to GitHub repositories
via the `shipit.ai/github-repo` annotation. No new secrets: uploaded credentials ride in the
existing `shipit-connector-apps` GSM container.

## What infra needs to add

1. `charts/shipit-ai/templates/clusterrole-shipit-reader.yaml`:
   - `ClusterRole shipit-reader` with `get, list, watch` on core `namespaces, nodes, pods`;
     apps `deployments, replicasets, statefulsets, daemonsets`; batch `cronjobs`.
   - `ClusterRoleBinding shipit-reader` → `ServiceAccount {{ .Values.apiServer.serviceAccountName }}`
     in the release namespace.
2. Annotation `shipit.ai/github-repo: Ship-It-Ops/ShipIt-AI` on the four app Deployments and the
   Redis StatefulSet (pod-template annotations are not needed; the connector reads the
   workload's own metadata).
3. Nothing else: no new GSM container, no env vars, no Terraform IAM.

## Verification

After deploy: `POST /api/connectors/probe` with `{ "type": "kubernetes", "access": { "mode": "in-cluster" } }`
returns `ok: true` with every kind `ok`; create the `k8s-demo` instance and confirm 5 workload
nodes plus one `shipit-ai` LogicalService linked to the `ShipIt-AI` repository.
