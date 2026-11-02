# Shared Lantern handoff

## Verified working mailbox

Dot's cloud task can read and write the selected GitHub repository through its existing authenticated Git connection. The [omi-relay mailbox branch](https://github.com/nighteyes-neversleep/kaos_labs/tree/omi-relay) is live: Dot posted and fetched a real connection-check message, then the actual Git worker fetched it, posted an acknowledgement, and fetched that acknowledgement. A repeated worker cycle delivered no duplicate messages.

Use [the Git mailbox startup guide](../relay/GIT-MAILBOX.md) for an outward worker. Logical participant IDs are `dot`, `deepseek`, `claude`, and `muse`; each needs a separate private state directory. Other cloud models may join with their own ID when their host has authorized repository read/write access. Repository access authenticates the Git transport; logical labels alone do not independently prove a model identity.

Only Dot's side has been verified. Route66, DeepSeek, Claude, and Muse must each acknowledge a real message before being reported connected. The worker stores incoming bodies as data and never executes them. Keep credentials and private capsule data out of the mailbox.

The owner also identified the private Firebrain repository as accessible to the other side. Dot independently verified Firebrain Git read access, a write dry run, and a real posted/read-back probe on [omi-relay-dot-probe](https://github.com/nighteyes-neversleep/Firebrain/tree/omi-relay-dot-probe). The initial probe commit is `724e05a8d11c0c50674ef776b98f21584dc1de2d`; its topic is `connection-check`. GitHub REST API access returned Forbidden from this cloud, so issue/comment access is not claimed. This probe does not move OMI's application or existing mailbox. A cross-participant acknowledgement is still required before adopting it as the common workbench.

The separate HTTP forum API has per-participant bearer credentials and a tested outward worker. It requires an actual HTTPS deployment before remote use. Preparing its participant identities does not establish a remote model connection.

The owner supplied [Chat and Claude — Shared Lantern Workbench Scratchpad](https://docs.google.com/document/d/1biBnaiW0xiZZhd6NgGozYcsWNOjgjenG_ozBnlaG6Y8/edit) for shared Chat, Claude, and DeepSeek notes.

The owner reports that its latest entries identify the Route66 forum at `http://127.0.0.1:18888/` and the local operating guide. That loopback address refers to **Route66**, not this cloud workspace. The guide name has not yet been read or verified here. Claude CLI is running on the owner's computer. The official Claude CLI was also installed in this cloud at `/workspace/omi-tools/node_modules/.bin/claude`; its status reported no authentication. No Claude, DeepSeek, or Muse model session has been invoked by this task.

The first attempt to read the Google document was blocked by the cloud HTTPS proxy. A `docs.google.com` allowlist addition is saved in the environment draft; it was not active at the last runtime check. Preserve existing network settings and use the supported environment settings flow to apply it. Do not use alternative proxy routes to bypass a denial. Authentication or document-sharing access, if required after network access is restored, remains separate.

The owner later supplied a [Drive forum copy](https://drive.google.com/file/d/1m4uEi1a228WvmTv3VoWlGYsqtUocvF-7/view), reportedly containing six topics and 23 replies. Its request was also blocked before content was read; no conversations have been imported or invented. A `drive.google.com` addition is saved in the draft. A requested unauthenticated Discord gateway probe was likewise blocked by the proxy with HTTP 403; no Discord message was sent and no bot was configured. These failures do not affect the separately verified Git mailbox.

## Current implementation handoff

- Working OMI client: encrypted local capsule, namespaced signed Eagle's Nest board, explicit sharing authorization, governance review/containment, hash-linked audit history, and governed local JSON artifacts.
- Dual Merge Codex laboratory: exact Chapter 6.1 equations, bounded adaptive RK45 integration, plots, full arbitrary-state Jacobian, and audited JSON/CSV exports. Defaults are illustrative; formal proofs remain open.
- Validation: `npm test`, `npm run build`, and `npm run test:browser` (after build). See [README](../README.md) for requirements and [architecture](architecture.md) for boundaries and independent numerical checks.
- Development: `npm run dev`. Review current Git changes before editing; cloud files are not automatically synchronized into another computer's checkout.
- Actual peer transport, production identity/signing, resource consumption, and semantic alignment proofs remain outside this local implementation. Registrations alone do not establish cartridge readiness.
