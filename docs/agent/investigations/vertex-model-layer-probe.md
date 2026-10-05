---
type: investigation
status: active
created: 2026-10-03
updated: 2026-10-03
author: claude-session-2026-10-02
tags: [ai, agents, vertex, model-layer, spike]
importance: core
---

# Vertex model-layer probe: does the AI SDK Vertex provider support our run loop?

## Symptoms

Not a bug hunt. The design (`docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md`
§Model layer) rested on facts read from docs and SDK source. This probe ran them live
(foundation plan Task 9, `docs/superpowers/plans/2026-10-01-agents-foundation.md`).

## Root Cause

Results on 2026-10-03, with `ai@7.0.126` and `@ai-sdk/google-vertex@5.0.101`, project
`ship-it-ai-portal`, location `global`, the owner's ADC:

| Check                                                     | Claude (all three families)      | Gemini (`gemini-3.8-flash`, `gemini-3.1-pro-preview`) |
| --------------------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| One call, tools without executors, returns tool calls     | **Not reached: 429, zero quota** | Pass, both. One `graph__find_owners` call each.       |
| Assistant message types returned                          | —                                | `['tool-call']` (no separate `reasoning` part)        |
| Transcript survives JSON and is accepted on the next call | —                                | Pass, both. `thoughtSignature` is in the stored JSON. |
| Usage reported per call                                   | —                                | Yes, per step, with `reasoningTokens` split out.      |

Claude: `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-haiku-4-5@20251001` all answer
`429 RESOURCE_EXHAUSTED`, "Quota exceeded for
aiplatform.googleapis.com/global_online_prediction_requests_per_base_model with base model:
anthropic-claude-{sonnet,opus,haiku-4-5}. Please submit a quota increase request." The
endpoint and model ids resolve (no 404), so the models are enabled; the per-model quota on
`global` is zero. **The Claude half of this probe is still owed** once quota is granted.

Gemini usage examples (step 1 / step 2):

- `gemini-3.8-flash`: `{"inputTokens":61,"outputTokens":67,"reasoningTokens":47}` then
  `{"inputTokens":145,"outputTokens":49,"reasoningTokens":29}`
- `gemini-3.1-pro-preview`: `{"inputTokens":61,"outputTokens":135,"reasoningTokens":115}` then
  `{"inputTokens":213,"outputTokens":95,"reasoningTokens":81}`

**The finding that matters for the runner:** Gemini 3's thought signature rides on the
`tool-call` part as `providerOptions` (key `thoughtSignature`), not as a `reasoning` part. A
negative control that deleted every `providerOptions` block before replay still **passed**:
the SDK logged "Replayed 1 `functionCall` part(s) for a Gemini 3 model without a
`thoughtSignature` … Injected the documented `skip_thought_signature_validator` sentinel".
So a serialiser that drops `providerOptions` does not fail; it silently replays without the
model's reasoning context.

Open models (`/maas`): not run.

Model ids are from `GET v1beta1/publishers/google/models` on 2026-10-03; the
`gemini-3.8-flash` limits (1,048,576 input, 65,536 output, function calling and thinking
supported) are from its model card at
https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash.

## Fix

- Gemini passed: its model layer is the AI SDK Vertex provider, as designed.
  `gemini-3.8-flash` is in the `ai.models` catalog as `gemini`.
- Claude is undecided until quota exists. If its round trip then fails, Claude's model
  layer uses `@anthropic-ai/vertex-sdk` behind the same `ModelClient` interface.
- The runner must persist assistant messages **verbatim, including every
  `providerOptions` block**, and its tests must assert the stored transcript still holds
  `thoughtSignature`, because the SDK will not fail when it is missing.

### Further findings while building the runner (2026-10-03, `ai@7.0.127`, Gemini)

- **The SDK answers some tool calls itself.** For a call to a tool that was not declared,
  `generateText` returns the call in `toolCalls` and also appends a `tool` message with an
  `error-text` result (`AI_NoSuchToolError`). A runner that stores `responseMessages` as-is
  lets that call bypass its gateway and audit. The model client keeps only the assistant
  message and sends every call to the gateway.
- **`toolChoice: 'none'` removes the tools from the request** for the Google provider
  (`tools` and `toolConfig` absent). Gemini, with earlier tool calls in the transcript, then
  invents tool names: 5 of 5 calls did. Removing the tools has the same effect.
- **Asking for a final answer:** with the tools still declared, a note in the system
  instructions worked on a short transcript (5/5) but failed on a real 14-message one (0/4
  answered). The same note as a trailing user message worked 4/4 on that transcript. The
  runner's last step uses both, with the tools declared.
- **Real runs:** the Graph assistant on `gemini-3.8-flash` answered catalog questions in 3 to
  8 steps against the local graph, 5k to 30k input tokens per run.

## Prevention

The runner plan adds an opt-in live suite gated on `VERTEX_TEST_PROJECT` that repeats these
checks, so an SDK upgrade that breaks the round trip is caught before release. It should
also treat the SDK's "without a `thoughtSignature`" warning as a failure.

## Related

- [agent-platform-v1-foundations](../decisions/agent-platform-v1-foundations.md)
- [ai-agents-and-workflows](../plans/ai-agents-and-workflows.md)
