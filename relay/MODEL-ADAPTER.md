# Optional headless model task adapter

The Git worker transports messages. The mailroom sorts each seat's mail. This adapter is a separate, opt-in process that makes a **real inference request** to an operator-selected Ollama or OpenAI-compatible chat endpoint and queues the returned text as an advisory result.

It does not control an existing Gemini, Claude, Muse, ChatGPT, or DeepSeek chat window. A running relay or provisioned participant name does not establish a model connection. Each seat needs an installed local model server or a supported API, an explicitly selected model, and any required access binding. Connection is established only by a successful real request; the included tests use synthetic local HTTP providers.

## Configure one seat

Use Node 20 or newer for this standalone adapter; Node 24 is recommended for the full OMI bundle and managed proxy support. The seat must already have been initialized and sorted by the station/mailroom. Keep its state and this configuration outside the Git checkout, with owner-only directories and files (`0700` directories, `0600` files on POSIX). On Windows, configure equivalent owner-only ACLs; POSIX ownership checks are unavailable there.

Example private configuration, saved as `/private/omi/gemini-adapter.json` after replacing the paths and model:

```json
{
  "participantId": "gemini-station",
  "seatDirectory": "/private/omi/seats/gemini-station",
  "addresses": ["gemini"],
  "provider": {
    "kind": "ollama",
    "url": "http://127.0.0.1:11434/api/chat",
    "model": "OPERATOR_SELECTED_INSTALLED_MODEL"
  },
  "sourceRoot": "/absolute/path/to/kaos_labs",
  "sourceFiles": ["relay/advisory.mjs"],
  "timeoutMs": 30000,
  "maxResponseBytes": 1048576,
  "maxAttempts": 3,
  "intervalMs": 5000
}
```

The alternative provider uses `"kind": "openai-compatible"` and a complete endpoint such as `https://YOUR_AUTHORIZED_PROVIDER/v1/chat/completions`. If authentication is required, add `"apiKeyEnv": "OMI_MODEL_ACCESS"` under `provider` and inject that environment variable using the operator's private environment or service secret facility. The configuration contains the variable name, never its value. Do not put access values into mailbox messages or source files. Logs contain event names, IDs, counts, and sanitized failure codes only.

The adapter permits HTTP only on `localhost`, `127.0.0.1`, or `[::1]`; other providers require HTTPS. User information, query strings, URL fragments, and redirects are refused. No URL from a message selects a provider. A remote provider receives the assignment and every selected source file; choose that provider and allowlist deliberately.

Run one cycle, then keep it running if the result is satisfactory:

```bash
node relay/model-adapter.mjs --config /private/omi/gemini-adapter.json --once
node relay/model-adapter.mjs --config /private/omi/gemini-adapter.json
```

In a managed cloud environment requiring its configured proxy, use a supported Node 24 release and `node --use-env-proxy relay/model-adapter.mjs --config ...`. Retain the environment's CA trust and network restrictions. `SIGINT` and `SIGTERM` stop the continuous loop after the current bounded request and state write. Each request times out between 50 milliseconds and 120 seconds; intervals are between 500 milliseconds and 5 minutes. At most 1,000 inbox files are inspected in a cycle; a larger inbox requires operator housekeeping before further processing.

The first run binds the state to the exact participant, aliases, provider settings, source allowlist, and limits. An incompatible configuration is refused. To change those settings, stop the process and deliberately migrate or archive its private `adapter` state while preserving unsent outbox messages; review pending tasks before allowing inference again. Never erase state while another adapter is running.

## Mail and result behavior

Only valid raw Git message envelopes in `<seatDirectory>/mail/inbox/*.json` are candidates. Their body must be a valid `omi-advisory/1` advisory with `kind: "assignment"`, addressed explicitly to the seat ID or an alias. The inner sender must match the outer participant label. Own-sender assignments, results, acknowledgements, broadcasts, and ordinary forum text do not invoke a model. There are no automatic acknowledgements. Repository write permission authenticates the transport; a participant label is not proof of which model or person produced a message.

The request quotes the complete assignment and the selected source files as data. It makes a non-streaming chat POST. The adapter has no shell, JavaScript evaluation, tools, browser, code editor, or test runner. Model-requested tool calls are refused. Text suggesting a command is still text; the adapter never executes it.

Source files come only from `sourceRoot` plus exact relative `sourceFiles`; task-supplied paths are ignored. Hidden paths, escaping paths, common credential/private file names, final symlinks, and symlink escapes are refused. Files must be UTF-8, at most 64KiB each and 128KiB total; the reply records their SHA-256 hashes. This is an explicit allowlist, not secret detection: review those source files before selecting them. No files are included by default.

A successful response produces a `kind: "result"` advisory addressed to the original sender, preserving `taskId`, with `requiresAck: false`. It records `details.status: "model-output-unverified"`, the incoming message UUID, the original assignment ID, provider kind/model, exact output text, source hashes, and `checksExecutedByAdapter: []`. The provider may make incorrect claims; those claims remain unverified text. Independent tests and review establish build quality.

The result ID is deterministic from the incoming UUID and seat ID. A private pending result is fsynced before `enqueueAdvisory()` queues it. A receipt is written only after the queue operation is durable. Restarting with the same pending result reuses it, and a missing receipt cannot create a second queue file. A queue receipt means **queued locally**, not pushed to Git, received by another agent, or approved.

Private state is stored beneath `<seatDirectory>/adapter`:

| Path | Purpose |
| --- | --- |
| `binding.json` | Exact operator-selected configuration, without access values |
| `adapter.lock` | Per-seat process lock; dead process locks can be recovered |
| `attempts/<incoming-uuid>.json` | Durable attempt count and retry deadline |
| `responses/<incoming-uuid>.json` | Exact model text retained for operator review |
| `pending/<incoming-uuid>.json` | Immutable validated result, written before queueing |
| `receipts/<incoming-uuid>.json` | Local queue completion record |
| `blocked/<incoming-uuid>.json` | Permanent failure or exhausted-attempt code |

Keep pending results and receipts. They prevent repeated inference and duplicate delivery. Network/timeout failures retry after 500 milliseconds, doubling up to 60 seconds, with 1–5 attempts (3 by default). Persistent response-format, source-path, or transport-limit errors are blocked for operator review. A result exceeding the advisory's 12,000-character body limit is retained privately and refused; it is never silently truncated. No timeout, failure, or blocked task sends a fake result or completion acknowledgement.

There is an unavoidable boundary if the process dies after the provider responds but before durable pending state exists: a later attempt may repeat the provider request. A stable `Idempotency-Key` is sent, but provider support varies. Once pending state is durable, the adapter does not call the model again for that input. Outbound advisory IDs remain stable across this boundary.

## Validation and programmatic use

```bash
node --test relay/model-adapter.test.mjs
```

The tests use temporary owner-private state and mock loopback HTTP providers. They cover real request/response payloads, aliases, assignment-only dispatch, ACK-loop avoidance, retry bounds, timeouts, source hashes and path guards, injection-as-data, oversized responses, tool-call refusal, redirect refusal, immutable configuration, and crash recovery before and after queueing. They do not demonstrate an actual Gemini, Claude, or DeepSeek service connection.

`new ModelAdapter(config, {log, fetchImpl, clock, afterPendingResult})` supports `runOnce()` and `run({signal})`. `validateAdapterConfig()` and `loadAdapterConfig()` are exported. `runOnce()` reports `scanned`, `eligible`, `providerCalls`, `queued`, `skipped`, `blocked`, `failed`, and `deferred`. The optional `afterPendingResult` hook is for fault-injection tests after durable pending state and before queueing. A one-shot CLI run exits nonzero on failed or blocked tasks.
