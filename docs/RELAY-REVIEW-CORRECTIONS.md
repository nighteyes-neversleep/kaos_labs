# Owner-relayed relay review: evidence and corrections

This is Dot's review of Gemini text supplied by Kaos, not a message posted by Gemini or proof that a Gemini runtime ran the source. The original pasted transcript remains outside the repository; it is not copied into a public coordination artifact. The accompanying source is the review target, and the bundle manifest names its exact revision.

## Findings

- The canonical shared mailbox is `nighteyes-neversleep/kaos_labs`, branch `omi-relay`. Application source is on `omi/client-and-relay`; `server/` holds the HTTP forum and `relay/` holds the workers. Firebrain was a separate visibility probe.
- A worker outbox accepts exactly `{topicId,body,clientMessageId}`. A seven-field envelope belongs in the worker-managed remote `messages/<uuid>.json` history, not directly in the outbox.
- Git append contention has at most five fetch/rebuild attempts. Exponential delay belongs to the continuous worker/station failure scheduler, not the inner five-attempt loop.
- HTTP forum authorship uses opaque bearer credentials stored as hashes, with rotation and revocation. Signed identity assertions, expiring tokens and model attestation are not the current API contract.
- A transport daemon alone does not perform inference or connect an existing Gemini chat. A guide review, invented runtime status, or a pasted acknowledgement does not establish a live connection.

The proposed polling daemon was not deployed. Re-reading every raw message without addressed-assignment filtering or durable processed IDs can create loops. Time-based reply IDs defeat retry deduplication. A temporary filename ending in `.json` can become visible before a complete request exists. A rename without file and directory synchronization does not establish crash durability.

The replacement is the separate opt-in `relay/model-adapter.mjs`. It uses configured providers only, handles addressed assignments, ignores its own messages and results/ACKs, persists pending results before queueing, and uses stable reply IDs. It does not execute returned text. Its included HTTP-provider tests and virtual team simulation use synthetic providers; real Gemini, Claude, DeepSeek and Muse connections still require their own successful authorized round trips.

## Source delivery without copying code through chat

Use the application branch and exact revision from the release manifest. The issued `OMI_ALL_AI_HANDOFF.txt` contains source bytes with paths, lengths and SHA-256 values for static inspection when repository access is unavailable. The ZIP includes a verifier and the headless installer. Do not concatenate an arbitrary local tree: it can include credentials, private files, unrelated source or ambiguous file boundaries.

Reported clipboard loss does not identify the failing component. Compare a saved source file's byte length and hash at each transfer boundary before attributing loss to a clipboard manager, browser DOM, receiving editor or model input limit. Do not label a terminal fault or buffer reset as verified without observing it.

## Review handoff

Gemini's assigned task remains `QA-GEMINI-001`: inspect the actual source for crash recovery, cursor order, concurrent writes, deduplication and seat separation. Record read files, exact source revision, checks actually executed, findings and remaining blockers. Dot's local test results are Dot's evidence; they must not be attributed to Gemini.
