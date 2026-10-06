# SkillDecision

An experimental **TensorFold resource selector for Pi 1.0.0**. It selects local skills and tool recommendations before Pi answers each user task.

**It extends Pi. It does not replace Pi, execute the task, or restrict Pi's tools.** No fork, separate service, or Pi Durable dependency.

```text
User task → TensorFold POST /v1/decisions → validate → load selected skills → ordinary Pi
                                         failure ──────────────────────→ ordinary Pi
```

Pi already advertises skills and can load them itself. This extension tests proactive loading of relevant instructions. **No improvement in task success, speed, or total cost has been demonstrated.**

## Install

Requires Pi 1.0.0. Development tests use Node 22.19+ or Node 24.

```sh
pi install git:github.com/mikolaj92/SkillDecision
```

Or try the checkout without changing Pi settings:

```sh
git clone https://github.com/mikolaj92/SkillDecision.git
export TENSORFOLD_BASE_URL='http://127.0.0.1:8080/v1'
export TENSORFOLD_MODEL='<served-model-id>'
export TENSORFOLD_API_KEY='<key>'   # omit for an unauthenticated endpoint
pi -e ./SkillDecision/src/pi.ts
```

The package has no runtime dependencies. The selector reads only its own flags and the `TENSORFOLD_*` environment variables. Pi's ordinary model and credential configuration is untouched. Review the source before installing any extension.

## Configure the decision endpoint

The selector calls one TensorFold endpoint directly. It does not read Pi's model registry, `/login` credentials, provider metadata, or `models.json` in any form. Pi's ordinary main-model configuration is never consulted for selection and is left unchanged.

| Setting | CLI flag | Environment default |
| --- | --- | --- |
| Base URL | `--decide-url` | `TENSORFOLD_BASE_URL` |
| Model ID | `--decide-model` | `TENSORFOLD_MODEL` |
| Bearer key | none | `TENSORFOLD_API_KEY` |

```sh
pi --decide-url 'http://127.0.0.1:8080/v1' --decide-model '<served-model-id>'
```

- `--decide-url` is an exact HTTP or HTTPS base URL ending in `/v1`. Trailing slashes are accepted. URL credentials, query strings, and fragments are rejected (`INVALID_DECISION_ENDPOINT`), and redirects are not followed.
- `--decide-model` is the exact model ID TensorFold serves. It is sent verbatim on the wire and may contain slashes, as Hugging Face-style IDs do. There is no `provider/` prefix and no registry lookup.
- `--decide-model auto` is rejected as `INVALID_MODEL_ADDRESS`. `auto` was a v0.1 alias and is no longer special.
- A CLI flag wins over its environment default. A missing URL or model records `DECISION_NOT_CONFIGURED` and leaves ordinary Pi behavior intact.

**Authentication is the environment only.** `TENSORFOLD_API_KEY` is read at request time and sent as one `Authorization: Bearer` token. A comma-separated value is still one token, not a key list. There is no key flag, no key storage, and no `!command` or `$ENV` interpolation: the selector never resolves Pi configuration values. Without the variable the request carries no `Authorization` header — correct for a deliberately unauthenticated local server. Use HTTPS for credentials sent across untrusted networks.

**Proxies are not supported for the selector.** The selector uses Node's native `http`/`https` request transport and does not use Pi's `httpProxy` setting or any other agent proxy configuration. If your network requires a proxy, expose the endpoint through a local reverse proxy and point `--decide-url` at it.

## Decision protocol

One accepted user message makes **one POST** containing the full catalog and one `yes_no` question per resource:

```json
{
  "model": "<served-model-id>",
  "prompt_format_version": 1,
  "input": {
    "task": "Extract obligations from the PDF",
    "context": [],
    "skills": [{"id":"pdf","description":"Process PDF documents"}],
    "tools": [{"id":"read","description":"Read files"}]
  },
  "questions": [
    {
      "id": "skill_0",
      "type": "yes_no",
      "question": "Does the user's task need skill pdf?",
      "yes": "Directly useful for this task: Process PDF documents",
      "no": "Unrelated, merely optional, or not needed to answer the user."
    },
    {
      "id": "tool_0",
      "type": "yes_no",
      "question": "Does the user's task need tool read?",
      "yes": "Directly useful for this task: Read files",
      "no": "Unrelated, merely optional, or not needed to answer the user."
    }
  ]
}
```

This is a shortened wording example. Actual questions quote IDs and tell the model to treat descriptions as data.

TensorFold returns `object: "decisions"`, `prompt_format_version: 1`, and `answers` keyed by question ID. Each answer contains `type: "yes_no"`, `probabilities: {yes, no}`, and `label_mass`.

- Probability `yes ≥ 0.5` selects the corresponding catalog ID. This fixed threshold is a policy, not a calibrated guarantee.
- Every expected answer must appear. Unknown IDs, incomplete answers, invalid types, non-finite or out-of-range probabilities, and inconsistent probability sums are rejected.
- `label_mass` is validated, but it does not gate selection. It measures answer-label mass in the full vocabulary, not task correctness.
- No text is generated. Thinking remains off. TensorFold's current endpoint does not support `thinking: "auto"`.
- No chat LLM or alternate classifier is used as a selector on failure. The ordinary main agent may still discover and load resources itself.

**One HTTP request does not mean one internal model operation.** TensorFold's MLX implementation submits one prompt-lane prefill per question. CUDA behavior depends on its engine. Reported prompt tokens sum across question prompts; neither parallel inference nor constant catalog cost is assumed.

## Controls

```text
/decide on
/decide off
/decide status
/decide stats
```

Disable selection at startup:

```sh
pi --decide-disabled
```

`--decide-disabled` takes precedence over `/decide on`. Controls last for the loaded extension instance; they are not saved to configuration.

## What changes

- `before_agent_start` captures Pi's discovered skill catalog, excluding manual-only skills.
- The cancellable `context` hook selects before the first main-model request for each accepted user message.
- Input contains the task, up to four recent text messages or summaries, and resource IDs/descriptions.
- Selected skill files are loaded in full. Their frontmatter is removed. File paths and base directories accompany the instructions.
- A hidden, request-local context message supplies selected resources. Relative skill references resolve from `baseDir`.
- Pi's original user messages, system prompt, and active tools remain unchanged. Tool selections are recommendations, not permissions.
- Decisions attach to source message IDs on the active branch. Steering and follow-up messages get their own decisions.
- Tool continuations, main-model retries, reloads, and compaction reuse saved decisions. Existing v0.1 audits also remain reusable; changing the backend does not rerun an old task.

A queued batch can require several decisions before one main-model request. This is one decision per message, not per tool call. Blank tasks and empty catalogs skip selection.

## JSON contract v1

The portable core is [`src/decision.ts`](src/decision.ts). [`src/tensorfold.ts`](src/tensorfold.ts) translates the TensorFold protocol; only [`src/pi.ts`](src/pi.ts) knows about Pi.

Schemas live in [`contracts/decision-input.v1.schema.json`](contracts/decision-input.v1.schema.json) and [`contracts/decision-output.v1.schema.json`](contracts/decision-output.v1.schema.json). The portable result stays:

```json
{"skills":["pdf"],"tools":["read"]}
```

Both arrays may be empty. Unknown IDs, duplicate IDs, wrong types, and extra keys are rejected. TensorFold probabilities normalize to this object; the decision endpoint is not asked to generate JSON text.

No Durable, Goose, Buzz, Hermes, or other harness adapter is included.

## Failure behavior and limits

A **30-second timer per user message** bounds asynchronous selection, the HTTP request, response reading, and file loading, while the event loop remains responsive. Aborting Pi cancels the selector's HTTP request and prevents the main-model request for that aborted run. Late asynchronous work cannot inject context or append a second audit. This is not a hard deadline for synchronous host code: a synchronous callback on the event loop can still delay the timer.

| Limit | Value |
| --- | --- |
| Recent context | 4 items, 2,000 characters each; summaries carry an explicit label |
| Serialized decision input | 131,072 characters |
| TensorFold response | 1,048,576 bytes, both encoded and decoded |
| One selected skill file | 65,536 bytes, regular files only |
| Combined enrichment | 131,072 characters |

The selector uses Node's standard `http`/`https` request transport, not `fetch`, so HTTP 421 cannot secretly replay its JSON POST. There are no selector retries, redirects, split catalog requests, or alternate selector calls. Provider failure and unreadable files leave ordinary Pi behavior intact. Loading is all-or-nothing: one failed selected file discards enrichment.

Named reasons include `DECISION_NOT_CONFIGURED`, `INVALID_MODEL_ADDRESS`, `INVALID_DECISION_ENDPOINT`, `DECISION_HTTP_FAILED`, `DECISION_NETWORK_FAILED`, `INVALID_TENSORFOLD_JSON`, `INVALID_TENSORFOLD_RESULT`, `DECISION_RESPONSE_TOO_LARGE`, `INVALID_DECISION`, `DECISION_TIMEOUT`, `ABORTED`, `CATALOG_TOO_LARGE`, `SKILL_TOO_LARGE`, and `ENRICHMENT_TOO_LARGE`. Unexpected exceptions use `DECISION_FAILED`. Raw provider or credential errors never enter audits.

Fallback is saved for that message too. Continuing it does not silently attempt selection again. Client cancellation stops waiting; it does not guarantee TensorFold stopped internal inference work.

## Counters, cost, and privacy

**Pi's footer and `/session` totals exclude the selector.** `/decide stats` reports separate active-branch counters:

- `decisions`, `selected`, `fallback`, `unknownUsage`, `unknownCost`;
- `usage.input`, `usage.output`, `usage.totalTokens`;
- `footerIncludesDecisionCost: false`.

TensorFold reports prompt tokens and zero completion tokens. Missing usage is unknown, not evidence of a free request. Malformed usage rejects the result. `unknownUsage` also includes local fallbacks that made no inference request.

**Decision cost is unknown.** TensorFold's decisions response has no monetary or cache accounting. SkillDecision does not apply chat prices or invent zero cache/cost values. `unknownCost` conservatively counts every audit, including local fallbacks and reused v0.1 entries. Token totals can include v0.1 usage, but legacy cost/cache fields are no longer aggregated. Tool continuations can also increase the main model's token use by resending enrichment.

Each new audit records `backend: "tensorfold"` and `provider: "tensorfold"`, target message ID, outcome, response `model`, elapsed `durationMs`, usage when validated, and successful decision/enrichment. The response `model` echoes what was requested; it is not independent proof of the loaded checkpoint. Enrichment includes full skill text and local paths and persists with the session. Treat session files as private.

TensorFold receives task text, bounded recent text/summaries, and resource IDs/descriptions. Full skill instructions go to the main model, not the selector. The selector does not independently inspect attachments, images, tool results, or repository files. MCP tools that have not connected yet may be missing from the catalog.

Skills remain trusted local inputs, not a sandbox. Resource selection is not an operating-system permission boundary.

## Development and verification

```sh
npm ci
npm run verify
npm audit --omit=dev
npm pack --dry-run
```

`verify` runs strict TypeScript checking and the complete Node suite. Tests run real Pi SDK sessions with a localhost TensorFold-shaped decisions endpoint and main-model SSE fixtures. They cover direct URL/model and environment configuration, bearer keys, cancellation, queued tasks, tool continuations, retries, branch totals, compaction, reloads, file limits, validation, and failure without chat selection. A real `models.json` `!command` provider is never resolved while `/v1/decisions` executes.

[`test/fixtures/tensorfold-decisions.v1.json`](test/fixtures/tensorfold-decisions.v1.json) was produced by TensorFold's real `build_response()` at commit `609ca419abecebdc5a059498a613680bd3aa847f`, using synthetic prompt IDs and logits. It checks protocol translation, not real-model selection quality.

**No live TensorFold endpoint or real-weight selection has been qualified.** A paired evaluation must still measure task success, missed resources, latency, and total baseline-versus-extension cost. Passing fixtures do not establish deployment or savings.

## License

[MIT](LICENSE).
