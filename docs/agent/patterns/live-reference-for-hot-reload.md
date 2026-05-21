---
type: pattern
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [config, hot-reload, services]
importance: standard
---

# Pass live config object references between services so writes propagate without a restart

## When to Use

When a service needs to read mutable config that another service can update at runtime, AND a process restart is unacceptable for that update path. Today: the global GitHub App config — `GitHubAppService.update()` writes to disk **and** to the in-memory config, and the `SyncScheduler` + probe endpoint pick up the new credentials on their next read.

## Implementation

The trick is that JS object references are shared by default. The Zod-validated `Config` object loaded at boot is one tree; every service that needs to read `config.connectors.github.app` gets the **same object** — not a copy.

```ts
// index.ts (boot)
const config = loadConfig();
const gh = config.connectors.github.app;          // reference into the loaded tree

const githubAppService = new GitHubAppService({
  localConfigPath,
  appConfig: gh,                                  // same reference
});

const scheduler = new SyncScheduler({
  /* … */,
  globalApp: gh,                                  // same reference
});
```

Now when `GitHubAppService.update()` does:

```ts
this.appConfig.id = id;
this.appConfig.privateKeyPath = privateKeyPath;
```

…the scheduler's `this.globalApp.id` and the probe endpoint's `cfg.connectors.github.app.id` see the new value on the **next read**. No restart, no event bus, no observer.

The route handler reads via `(server as unknown as { config?: Config }).config?.connectors.github.app` — same reference too.

## Examples

- `packages/api-server/src/services/github-app-service.ts:73-87` — mutates `this.appConfig` after a successful disk write.
- `packages/api-server/src/index.ts:50-80` — boot wires the same `gh` reference into both services.
- `packages/api-server/src/routes/connectors.ts` (probe handler) — reads `cfg?.connectors.github.app` on every probe call.

## Gotchas

- **Don't snapshot at the boundary**. `globalApp: { id: gh.id, privateKeyPath: gh.privateKeyPath }` creates a new object — same fields, different identity. The scheduler would keep using the boot-time values. Pass the reference directly.
- **Don't replace the reference**. `this.appConfig = { id, privateKeyPath }` breaks the link. Always mutate fields on the existing object (`this.appConfig.id = id`).
- **The pattern doesn't survive process boundaries**. Multi-process deployments need a real propagation mechanism (Redis pub/sub, file-watcher reload, signal handler) — the live-reference trick is single-process only. Document the constraint anywhere it's used.
- **Cached derived state must be invalidated**. The scheduler's `privateKeyCache: Map<path, contents>` keys on the file path; if a global-App update changes the path, the new path automatically misses the cache and the file is re-read. Good. But a future cache keyed on `appId` would silently serve stale key material — be careful what you cache.
