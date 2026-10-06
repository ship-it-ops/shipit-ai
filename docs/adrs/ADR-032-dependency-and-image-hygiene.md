# ADR-032: Dependency and Image Hygiene — Overrides, Direct Bumps, and Hardened Runtime Stages

## Status

Accepted

## Date

2026-05-24 (runtime image: 2026-09-15)

## Context

Dependabot reported dozens of advisories at once, spread over direct dependencies and transitive ones several levels deep. The sibling infrastructure repository scans every image with a vulnerability scanner before it is pushed; findings in the base image's bundled npm CLI and OS packages blocked all images although nothing in the application reached them.

## Decision

- **Advisories are resolved in rounds**, each one pull request: bump direct dependencies where the project declares the vulnerable package; use `pnpm.overrides` in the root `package.json` to force patched versions of transitives; keep the override list short (a long list means a parent is stuck); run `pnpm audit` right before the image build, where the scanner's database is freshest. Fastify was migrated to v5 rather than its advisories dismissed.
- **Runtime image stages** of every service Dockerfile run `apk upgrade` and remove the base image's bundled npm CLI immediately after `FROM`; every runtime command is plain `node` against a deployed tree, so nothing needs npm at run time.

## Consequences

### Positive

- The scanner gate stays green without path-scoped ignores for packages that are not reachable.
- Each round is reviewable; the decision note records every round.

### Negative

- Overrides can conflict with a later direct bump and fail `pnpm install` loudly; that is intended.
- `apk upgrade` at build time means reproducibility is per image tag, not per Dockerfile.

### Neutral

- A distroless or slim runtime base would retire the `apk` step; tracked on the infrastructure side.

## Alternatives Considered

### Bump every parent until the transitive is patched

- **Cons:** Forces majors across the toolchain for one advisory.

### Wait for a rebuilt base image

- **Cons:** The bundled npm's dependencies lag upstream fixes for months.

## References

- `docs/agent/decisions/dependabot-resolution-strategy.md`, `fastify-v5-migration.md`, `runtime-image-strips-bundled-npm-and-apk-upgrades.md`
