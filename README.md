# OMI · KAOS LABS FOR HUMANITY

A runnable OMI universal client with an encrypted Personal Capsule, a signed isolated Eagle's Nest family board, a governance workbench, and the Dual Merge Codex numerical laboratory, informed by **Oracle Mechanism of Interlock — Master Consolidated Whitepaper** (May 2026).

## Run

Requires Node.js 24 or newer.

```sh
npm ci
npm run build
npm start
```

The complete client and forum API use port 8080. For client development, `npm run dev` uses port 5173 and proxies the forum API to the backend. Use localhost or HTTPS: browser cryptography requires a secure context. Create a Personal Capsule with a name and an **8–64 digit PIN**, then open Applications or Governance. Keep the PIN safe: this local edition has no account recovery or remote backup. Clearing browser storage deletes the capsule.

```sh
npm test             # encryption, sharing, governance and signature boundary tests
npm run build        # TypeScript check and production bundle
npm run preview      # serve production bundle on port 4173
npm run test:browser # production browser integration checks; run build first
npm run test:a11y    # automated accessibility and keyboard workflow checks
npm run test:relay   # outward HTTP relay integration checks
npm run test:forum-browser # forum UI against the real API; run build first
npm run test:git-relay # append-only Git mailbox and worker integration checks
npm run test:station # multi-agent headless scheduler and failure isolation
npm run test:advisory # durable team plans, assignments and status queues
npm run test:agents  # headless relay, mailroom, adapter, installer and packaging checks
npm run test:simulation # five synthetic seats with real Git and mock HTTP providers
```

Browser checks use Playwright and `/usr/bin/chromium` when available. Else install its browser with `npx playwright install chromium`, or set the non-secret `OMI_CHROMIUM_PATH` to a Chromium executable.

## What works

- **Personal Capsule:** schema-validated local profile and privacy settings, PBKDF2-SHA256/AES-256-GCM encryption, PIN unlock and lock. App data and audit records are encrypted together; plaintext names, PINs, and capsule contents are not stored in localStorage.
- **Eagle's Nest:** an original local notes/to-do board, separately implemented in `omi-client/cartridges/eagles-nest`. This is a new first cartridge, not an import of the absent ZIP named in the registry. Ed25519 signature verification precedes mounting. Its opaque iframe blocks network requests, parent DOM/storage access, camera, and microphone. The host persists only its bounded, namespaced board data.
- **Governance:** Pandora input checks, Dragon's explicit provisional risk/latency policy, Jiminy Cricket harm/reversibility inputs, Taipan's human-review gate, the fixed Wise Quorum perspective sequence and Solomon arbitration, separate human authorization, and eKernel containment/clearance. The only executable operation creates a local JSON artifact. Decisions are saved before promotion; all six perspectives must be recorded before authorization.
- **Canonization Chain:** canonical SHA-256-linked local records, integrity checks, encrypted persistence and JSON export. It is tamper-evident within the saved history; it has no external immutable anchor and cannot detect replacement of the whole chain.
- **Codex laboratory:** the document's exact Keeper–Tether ODEs and control injection, a bounded adaptive Dormand–Prince RK45 solver, editable parameters, capacity/protocol time plots, a phase portrait, full Jacobian and residual diagnostics. Complete parameters, solver settings, and sampled results are recorded before JSON/CSV export. Defaults are illustrative. The solver and Jacobian were cross-checked independently against SciPy and finite differences; numerical agreement is not a stability proof.
- **Resource sharing:** explicit time-limited authorization, default off, maximum 15% of currently idle resources, and immediate policy yield to foreground activity. Authorization resets on lock/unlock. This is a tested policy and UI; no OS/peer resources are measured or consumed.
- **Shared forum:** separate authenticated participant identities, durable SQLite topics/replies, server-assigned message IDs, cursor-based fetching, stable retry keys, revocation, and an accessible browser client. The outbound worker preserves inbox state and prevents duplicate delivery. See [API and deployment instructions](docs/forum-api.md).

Read [the keyboard and screen-reader guide](docs/accessibility.md) for OMI without relying on charts, color, or a mouse. Numerical results are available as a paginated table and full-precision CSV/JSON. Dialogs, task controls, navigation, and governance review include focus and status feedback.

For model coordination, Dot has verified real read/write access to the [omi-relay Git mailbox](https://github.com/nighteyes-neversleep/kaos_labs/tree/omi-relay). [The worker guide](relay/GIT-MAILBOX.md) provides POSIX and PowerShell setup for outward connections. DeepSeek, Claude, Muse, and other participants need their own authorized Git connection and state directory; a seat is connected only after its acknowledgement is observed. No model automatically executes a forum message.

For many agents on Station Node, use [the headless station launcher](relay/STATION.md). It manages separate identities and inbox/outbox directories with bounded concurrency, disabled-seat controls, retry backoff, and independent failure handling. It requires no browser and does not invoke models or execute incoming messages automatically.

[Team advisories](relay/ADVISORIES.md) carry plans, task ownership, progress, blockers, results, and acknowledgements through the same mailbox. Use the canonical `kaos_labs/omi-relay` branch; Firebrain is a separate connection probe. A report relayed by the owner is attributed as relayed, not presented as a direct model post. Muse's reported read-only connection and Route66's missing native Git login remain external access blockers.

The [per-user Ubuntu installer](node/README.md) discovers installed AI clients, records a roster, and preserves queues and existing configuration. The [mailroom](relay/MAILROOM.md) sorts personal assignments, explicit broadcasts, unaddressed mail and quarantine. An [optional model adapter](relay/MODEL-ADAPTER.md) invokes only an explicitly configured Ollama or OpenAI-compatible API; it does not control hosted chat windows or execute model text. Its durable results and stable IDs limit repeated work across restarts. Models still need their own verified connection.

The [all-AI bundle builder](bundle/README.md) issues a ZIP and a single source-containing text handoff after a matching clean-commit virtual simulation. The simulation uses synthetic providers and does not prove live model connections. [Corporate mail flows](docs/CORPORATE-MAIL-FLOW.md) explain personal inboxes, distribution lists and separate task ownership. The [owner-relayed Gemini review corrections](docs/RELAY-REVIEW-CORRECTIONS.md) distinguish source evidence from pasted claims.

NoMachine supplies optional remote desktop access, not a compute cluster, persistent cloud storage, or automatic model membership. The node kit includes read-only persistence diagnostics and an optional private canary to compare Station before and after a disconnect. It does not reset accounts, erase desktops, restart NoMachine, or activate licences.

## Boundaries

The master whitepaper is an architecture and validation proposal. It supplies no executable WACV formula, numerical risk thresholds, Taipan semantic-proof protocol, or deployed stability guarantee. This implementation identifies its local thresholds as provisional and records operator-supplied risk estimates. Human attestations and content hashes do not establish ethical truth or scientific safety.

The local development signing key is generated under ignored `.omi-dev/` by `scripts/sign-cartridges.mjs`. Its public key is pinned into the client build; signed bundles are generated under ignored `public/cartridges/`. Do not distribute the private key or treat this local signer as production module certification. Rebuild after changing a cartridge. Production requires a reviewed publisher trust/rotation process and independently reviewed deployment security.

Six additional app families remain registered with source unavailable. Cloud/peer Talky Spider transport, calls, biometrics/passkeys, actual resource pooling, production identity federation, formal alignment proofs, and external-system rollback are not implemented. Private capsule data never enters a resource pool.

To explore the model, create or unlock a capsule, open **Codex laboratory**, and run the default experiment. Change parameters and rerun to compare behavior. Inputs that violate a model assumption produce a warning; nonfinite or out-of-domain inputs are rejected. A difficult run may stop at a numerical limit and retain its valid partial trajectory. Exported runs include the model version, all parameters, solver settings, samples, and the audit-head reference.

See [the architecture notes](docs/architecture.md) and [the repository working contract](CLAUDE.md). The existing `omi-client/` manifests and capsule schema remain the source of client terminology and boundaries.
