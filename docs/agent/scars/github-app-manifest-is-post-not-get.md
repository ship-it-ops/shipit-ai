---
type: scar
status: active
created: 2026-05-22
updated: 2026-05-22
author: claude-opus-4-7
tags: [github, manifest, api]
importance: core
incident-date: 2026-05-21
tripwire: "if a github.com/.../settings/apps/new page renders without your manifest fields prefilled, you are using `manifest_url=` (which doesn't exist) instead of a POST form with `manifest=<json>` in the body"
---

# GitHub App manifests are transported via POST form body, not a `manifest_url` query param

## What Happened

First implementation of the wizard's "Create App on GitHub" button sent the user to a URL of the form:

```
https://github.com/organizations/<org>/settings/apps/new?manifest_url=<our-instance>/api/connectors/github/manifest&state=<token>
```

The intent was for GitHub to fetch the `manifest_url`, parse the JSON, and pre-fill the App-creation form. **GitHub does not do this.** The `manifest_url` query parameter does not exist in GitHub's API. The page rendered with an empty App-creation form — no name, no permissions checked, no events checked, no webhook URL filled. The user dutifully clicked through the wizard expecting the auto-fill to happen and only realized something was wrong when they saw the blank form on GitHub.

## Tripwire

**If a `github.com/.../settings/apps/new` page renders without your manifest's fields prefilled, you are using the wrong transport.** GitHub's manifest mechanism requires an HTML form POST whose body carries a `manifest` field with the JSON-stringified spec. See [the official docs](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) for the canonical form structure.

## Why It Hurt

- One full round of implementation, tests, docs, and a docs/agent decision note all built on a misreading of the GitHub docs.
- The user spent time clicking through the wizard, walking the GitHub flow, and discovering at the end that the App had been created without any of the right permissions or events.
- Reverse-engineering "what went wrong" required reading GitHub's docs much more carefully — searching for `manifest_url` returns zero results in the actual GitHub docs, because the parameter doesn't exist.

## Don't Do This

- Don't pass `manifest_url=...` as a query parameter to `github.com/settings/apps/new`. GitHub silently ignores it.
- Don't try to "simplify" the manifest service back to a GET-with-query-string approach. The auto-submitting HTML form at `/api/connectors/github/manifest/launch` is the correct shape and exists specifically because the cross-origin form-POST pattern is otherwise awkward to do from a click handler.
- Conversely: the `GET /api/connectors/github/manifest` endpoint returns the manifest as JSON for inspection, but is NOT what you point GitHub at. The launch endpoint is.

## Related

- [github-app-manifest-flow](../decisions/github-app-manifest-flow.md) — the corrected design, now reflects the POST-form transport
