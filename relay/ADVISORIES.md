# Headless team advisories

`advisory.mjs` validates a coordination packet and places it in an existing seat's private relay outbox. The Git or HTTP worker then carries it using the same stable request-ID rules as other messages. The queue command makes no network request, invokes no model, and never executes the packet's contents.

The canonical shared mailbox is [kaos_labs, branch omi-relay](https://github.com/nighteyes-neversleep/kaos_labs/tree/omi-relay). The Firebrain `omi-relay-dot-probe` branch is a connection probe, not a second authoritative task ledger. See [the transport guide](GIT-MAILBOX.md) and [the multi-seat launcher](STATION.md).

## Packet format

Use a private UTF-8 JSON file. This is an example assignment, not a claim that the example participant has connected:

```json
{
  "protocol": "omi-advisory/1",
  "id": "dot-relay-review-001",
  "kind": "assignment",
  "from": "dot",
  "to": ["review-seat"],
  "taskId": "QA-RELAY-001",
  "summary": "Review duplicate-delivery recovery and return reproducible findings.",
  "details": {
    "sourceRevision": "replace-with-the-exact-reviewed-commit",
    "ownedPaths": ["relay/git-worker.mjs"],
    "doneWhen": [
      "Acknowledge the assignment and actual interface used.",
      "Separate reproduced bugs from unverified risks.",
      "Report only tests that were actually run."
    ]
  },
  "createdAt": "2026-11-02T20:00:00.000Z",
  "requiresAck": true
}
```

Required fields are `protocol`, `id`, `kind`, `from`, `to`, `summary`, `details`, `createdAt`, and `requiresAck`. `taskId` is optional. Unknown top-level fields are refused.

- `protocol` is exactly `omi-advisory/1`.
- `kind` is `plan`, `assignment`, `progress`, `blocker`, `result`, or `ack`.
- `id`, `from`, `taskId`, and recipient IDs are 1–100 ASCII letters, digits, `_`, or `-`, beginning with a letter or digit. The `id` is the stable retry key; do not reuse it for changed content.
- `to` contains 1–32 recipient IDs, unique even after case folding.
- `summary` contains 1–600 readable characters. It keeps human-facing context available when the details use compact machine-readable data.
- `details` contains JSON data, including `null` if there are no details. Functions, getters, cycles, sparse arrays, nonfinite numbers, and non-JSON objects are refused. Structural bounds are 24 nested levels and 4,096 visited values.
- `createdAt` is a canonical ISO timestamp, including milliseconds and timezone, as produced by `new Date().toISOString()`.
- `requiresAck` is a boolean. It requests a response; it does not manufacture an acknowledgement.

The complete serialized advisory must fit the existing transport's 12,000-character body limit. Details are copied and object keys sorted before serialization, so an equivalent JSON key order does not create a conflicting retry.

## Queue without a browser

Use the outbox already prepared by the station or one-seat worker. Both the outbox and advisory input below are example paths:

```sh
node relay/advisory.mjs \
  --outbox /private/station/dot/outbox \
  --file /private/advisories/relay-review.json
```

PowerShell:

```powershell
node relay/advisory.mjs --outbox 'C:\Private\OMI\dot\outbox' --file 'C:\Private\OMI\advisories\relay-review.json'
```

The outbox must be an existing real directory outside the checkout. POSIX ownership and private permissions are checked; use `0700` directories. Windows uses the account's private directory ACL instead of POSIX mode bits. Direct symlink outboxes, symlink files, and paths resolving into the checkout are refused. New files use `0600` where supported. Input files must be bounded regular files containing valid UTF-8 JSON.

Successful console output includes only the event, queue status, advisory ID, and queue file path. It does not print the advisory body. `queued` means the local file is durable; it does not mean a remote participant received it. `already-queued` means an identical request is still present locally.

The resulting transport envelope is:

```text
topicId: coordination-advisory
body: canonical JSON advisory
clientMessageId: advisory.id
```

The tool writes a private temporary non-JSON file, flushes it, renames it into the queue, and flushes the directory where supported. Relay readers ignore the temporary file. A producer lock prevents normal simultaneous writes to the same advisory ID; an abandoned lock is reclaimed only when its recorded process no longer exists. Keep the spool local to one host rather than sharing it as a multi-host filesystem lock service.

An identical queued ID is reused, including when another producer used a different filename. Different content under the same ID fails without replacing the existing item. If the worker has already consumed the file, the tool can queue it again; remote deduplication and the worker's sent archive remain the final authority for that retry. Outbox inspection is bounded to 10,000 entries and 32 MiB.

## Ownership, acknowledgements, and evidence

Use a `plan` to state current work and dependencies. Give each `assignment` one owner and explicit paths or outputs so parallel agents do not silently edit the same component. Send `progress` and `blocker` packets with the affected `taskId`. A `result` should name the exact reviewed revision, changes, executed checks, and remaining limits.

Keep a task awaiting acknowledgement until its participant replies. A useful `ack` records the actual host, interface, source revision, and what the participant can read and write. An acknowledgement relayed by the owner must say so in `details`; it is not proof of a direct model connection. In particular, an owner-relayed Muse acknowledgement or read-only observation does not establish Muse's write access. Never infer that Claude, DeepSeek, Gemini, Muse, or any other external model received work merely because a local queue write or transport cycle succeeded.

Logical sender names are routing metadata under repository access controls. They are not independent cryptographic proof of a model's identity. An advisory is coordination data, not authority to bypass OMI permissions, execute arbitrary commands, share private capsule contents, or change resource-sharing authorization.

The owner approved compact machine-readable inter-agent messages. Keep decisions, evidence, results, and user-facing progress in plain English as well, so the coordination remains auditable and usable without visual output.

## Keep credentials out

Common credential-shaped keys such as `token`, `apiKey`, `password`, `PIN`, `secret`, and `privateKey` are rejected recursively, including common normalized variants. This is a bounded key-name heuristic, not a general secret detector. It cannot recognize every credential hidden in prose or arbitrary code. Do not place credentials, private capsule data, or key material anywhere in an advisory.

## Verify

```sh
node --test relay/advisory.test.mjs
```

The suite exercises schema and size limits, canonical snapshots, ID conflicts, concurrent producers, private paths and symlinks, lock recovery, real CLI input handling, and metadata-only output. It uses temporary local files and synthetic data; it makes no model or remote-service call.
