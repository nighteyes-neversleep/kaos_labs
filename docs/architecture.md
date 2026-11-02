# OMI local client and governance workbench

This implementation combines the repository's OMI Client contract with the governance architecture in *Oracle Mechanism of Interlock — Master Consolidated Whitepaper*, Shawna Ann Pierce / KAOS LABS FOR HUMANITY, May 2026. It is a local development implementation. The whitepaper remains the architecture reference; its mathematical and deployment claims are not established by this software.

The original `omi-client/manifest.json`, capsule schema, Talky Spider declaration, shell declaration, and app registry define the client boundaries. A registry entry alone does not establish that an app is implemented, mounted, or runtime-attested.

## Modules and boundaries

| Module | Implemented responsibility | Boundary |
| --- | --- | --- |
| React client shell | Navigation, capsule unlock, privacy settings, local sharing authorization, governance review, cartridge host | Browser-local client; no identity provider or remote API |
| `src/core/capsule.ts` | Create, unlock, validate, and encrypt a Personal Capsule and namespaced app data | Encryption key remains in the running client; storage holds an encrypted envelope |
| `src/core/sharing.ts` | Explicit authorization windows, expiry, dependent modes, percentage limits, foreground-priority budget calculation | Calculates permissions and budgets; consumes no resources |
| `src/core/cartridges.ts` | Registry lookup, Ed25519 signature verification, cartridge identity checks, board-data validation | Accepts only the implemented signed Eagle's Nest cartridge |
| `src/components/CartridgeHost.tsx` | Mount verified HTML in an opaque-origin iframe and broker app-specific messages | `sandbox="allow-scripts"`; no same-origin access or direct core writes |
| `omi-client/cartridges/eagles-nest/` | Original local family notes and task board | Separate cartridge source; not the missing historical ZIP bundle |
| `src/core/governance.ts` | Proposal validation, provisional risk decisions, deterministic serialization, hash-linked audit records | Local sandbox policy and audit integrity checks, not a proof of alignment |

Only explicitly brokered Eagle's Nest board data is passed into its frame. The cartridge receives no capsule, PIN, encryption key, other app data, or authority to write OMI Core. Its frame permissions deny microphone, camera, geolocation, and display capture. Its signed content includes a restrictive Content Security Policy that blocks network requests and forms. These are client isolation controls; the host browser and application origin remain trusted.

## Personal Capsule

The capsule is validated against the repository's Draft 2020-12 JSON Schema. Identity, privacy settings, service grants, display name, and app data are encrypted together. The initial privacy audiences are private, raw biometrics are not retained, and resource sharing starts disabled.

A PIN of 8–64 digits derives a nonextractable AES-256-GCM key using PBKDF2-SHA256, 310,000 iterations, and a random 16-byte salt. Each save uses a fresh random 12-byte IV and authenticated version context. The localStorage envelope contains KDF metadata, salt, IV, and ciphertext; it does not contain a plaintext profile name, PIN, or capsule. HTTPS or localhost is required for browser WebCrypto.

The PIN is local unlock, not remote authentication. There is no recovery service. Losing the PIN or deleting browser storage can make the capsule unrecoverable. An attacker who obtains the encrypted envelope can attempt offline PIN guessing; a short or predictable PIN remains weak despite key derivation. A compromised host origin, browser extension, or device can access an unlocked session. The implementation does not claim hardware-backed identity or protection from same-origin malicious code. Passkeys, voice authentication, camera authentication, and Reliance Watch sign-in are not implemented.

Fresh unlock resets sharing authority. Persisted preferences never silently resume a share window. A capsule is scoped to the browser origin and profile; it does not automatically synchronize to another device or port.

## Cartridge trust

`scripts/sign-cartridges.mjs` creates a local Ed25519 development key under ignored `.omi-dev/`, signs the complete cartridge payload, and generates the public trust material imported by the client. The loader verifies the payload signature against that public key and checks the signed app identity before mounting it. Editing the generated payload without resigning must fail verification.

This signer establishes continuity with the local development build. It does not establish an independently reviewed publisher identity, production provenance, a revocation service, anti-rollback protection, or a trusted loader review. Anyone who controls the development key or build process can sign changed code. Production distribution requires a separately controlled trust root and release/review procedure. Keep the private development key out of version control and public hosting.

The six other registered apps have no implementation in this build. The client must present that state honestly and must not treat their registrations as successful mounts.

## Governance mapping

Whitepaper Chapters 3–5 define the canonical roles and mandatory intent-to-action gate. The workbench maps those roles as follows:

| Canonical component | Local implementation |
| --- | --- |
| Pandora | Normalize bounded proposal fields and reject incomplete or invalid input |
| Dragon Guardian | Map an operator-supplied volatility proxy into a risk region and a monotone review delay |
| Jiminy Cricket | Combine supplied harm probability and severity and surface reversibility concerns |
| Taipan Guardian | Require explicit review evidence and human authorization; semantic cryptographic alignment remains unimplemented |
| Wise Quorum | Structure review in the fixed order below; it supplies no autonomous ethical judgment |
| Canonization Chain | Record proposals and decisions using canonical JSON and a SHA-256 link to the previous record |
| eKernel | Contain local promotion on a critical or invalid decision; no claim of a proven Control Barrier Function |
| Quantum Rabbithole | Limit execution to a local sandbox artifact; no arbitrary command executor or remote deployment |

The fixed review sequence is Marcus Aurelius, Gandhi, Sun Tzu, Socrates, Michelangelo, then King Solomon as final arbiter. Human authorization follows the arbiter decision. These are structured review perspectives, not simulated people or independent AI authorities. Their names do not prove the quality of a review.

The numeric prototype policy is explicit: volatility warning at 0.25, guard at 0.5, containment at 0.75; downstream harm guard at probability × severity 0.2 and containment at 0.5. The delay is `250 + ceil(volatility × 4750)` milliseconds. These values are implementation assumptions, not thresholds supplied or validated by the whitepaper. The input is an operator estimate, not measured multi-agent WACV. No live autonomous-system telemetry is present.

The whitepaper specifies no executable WACV formula, `tau_network` formula, alignment-proof protocol, barrier function `B(x)`, or `gamma` parameter. Chapter 10 explicitly leaves Wise Quorum protocol formalization to future work. A stored attestation or hash proves neither semantic alignment nor ethical truth. The implementation must not present these missing mechanisms as completed science.

## Audit and artifacts

An audit record contains its sequence, previous hash, timestamp, event, details, and hash. Details capture the decision and supplied inputs. Canonical serialization rejects non-JSON, cyclic, sparse, or otherwise lossy values, and appending verifies the supplied prefix before extending it. Altering a record without updating its linked suffix is detectable.

This is a local tamper-evident chain. There is no externally anchored head, WORM storage, independent witness, or trusted timestamp. A party able to rewrite the entire local chain can replace it or truncate it to a valid prefix. A hash chain alone cannot prove completeness or immutability. Encrypted local persistence protects confidentiality at rest; it does not solve those audit limits.

The Canonization Chain records governance decisions. The whitepaper's OMI Efficiency Ledger is a distinct proposed system for artifact-addressable value accounting; do not equate a list of local audit events with that complete ledger. Downloaded sandbox artifacts are local outputs, not published or certified claims.

## Sharing and unavailable services

Sharing requires an explicit current-session authorization window, expires automatically, and caps its budget at 15% of the supplied **currently idle** quantity. Foreground activity yields the full budget. Load balancing, AUTO MANAGE, and TURBO depend on active authorization and never create it implicitly. There is no CPU/GPU/storage/bandwidth consumer, peer allocator, or pooled resource backend in this build.

Talky Spider remains an architectural declaration. Cloud relay, authenticated peer mesh, end-to-end encrypted communication, calls, delivery receipts, location transport, biometric authentication, and cloud identity are not implemented. Local state must not be shown as remotely delivered, shared with a family, or live network telemetry. Emergency access must never be gated by a resource-sharing choice.

## Validation posture

Whitepaper Chapters 7 and 9 separate established mathematical background, framework formalization, and provisional extensions. Software tests can establish the behavior they exercise: local encryption, rejection of bad input, authorization expiry, cartridge signature checks, isolation, and audit-link verification. They cannot prove the proposal's global stability, downstream ethical adequacy, AGI capabilities, or correctness in a real deployment domain.

The six open proof obligations remain open: positive invariance, ultimate boundedness, controlled-equilibrium consistency, the perturbation bound, the zero-derivative invariant set, and the role of `W`. Lyapunov certification, the SOS program, real control-system rollback, and domain-specific empirical validation are outside this implementation. The whitepaper's current mathematical claims must not be attributed to this client merely because its UI uses the canonical component names.

## Dual Merge Codex numerical laboratory

`src/core/codex.ts` implements the exact Chapter 6.1 equations:

```text
dK/dt = V K (1 - K/P) - R K T - D K
dT/dt = M K T - S T - D T + alpha Phi
Phi = beta1 K/P + beta2 W/(1+W) + beta3 T/(1+T) - beta4 R T/(1+K)
```

The experiment holds `W` fixed. Defaults are illustrative parameters rather than domain calibration; only the baseline beta weights and the example `beta4=7` come from the whitepaper. Failing `V>D` or the proposed beta-weight condition produces a model-regime warning rather than secretly replacing the parameters. This permits exploring failure regimes without claiming they satisfy the paper's assumptions.

Integration uses adaptive Dormand–Prince 5(4), relative tolerance supplied by the operator, and absolute tolerance equal to relative tolerance divided by 1,000. Output is sampled at 401 fixed times including both endpoints; internal integration steps are adaptive. Trial stages that leave the positive domain or exceed the numerical magnitude bound are rejected before their derivatives are evaluated. States are never clipped to zero or made positive by substitution. The solver retains partial results and contains a run when it cannot safely meet its domain, step-size, work, or numerical limits. This numerical containment is a software guard, not a demonstrated physical eKernel barrier law. Integration is not guaranteed to be efficient for stiff parameter regimes.

The state analysis reports the full arbitrary-point Jacobian, its trace and determinant, and the ODE residual norm. In particular, its `j11` is `V(1-2K/P)-RT-D`; the whitepaper's simplified `-VK*/P` applies only at a positive equilibrium satisfying the K-nullcline. A final trajectory sample is not automatically an equilibrium, and a negative trace with positive determinant at an arbitrary point does not certify local equilibrium stability. The laboratory does not output a stability certificate or use the whitepaper's simplified Lyapunov derivative as a proof.

An independent numerical review compared the implementation against SciPy's DOP853 solver (`rtol=1e-12`, `atol=1e-14`) at every output time. The reviewed cases used the implementation defaults except for the changes listed below:

| Case | Changed parameters and settings | Largest absolute trajectory error |
| --- | --- | --- |
| Illustrative default | No changes; tolerance `1e-6` | `2.77e-10` |
| Fast coupling | `V=10`, `R=1.5`, `M=0.5`, `alpha=0.03`; initial `K=8`; duration `20`; tolerance `1e-7` | `1.34e-7` |
| Lower capacity | `V=0.7`, `P=5`, `D=0.15`, `R=0.7`, `M=0.25`, `S=0.1`, `alpha=0.05`, `W=0.4`; duration `20`; tolerance `1e-7` | `5.92e-12` |
| Small control and will | `alpha=0.01`, `W=0.1`, `beta4=9`; initial `K=0.5`, `T=0.2`; duration `50`; tolerance `1e-7` | `1.66e-8` |

The largest endpoint error across these four cases was `1.46e-11`. Twelve full-Jacobian evaluations, covering three non-equilibrium states under each parameter set, agreed with independent centered finite differences within `7.87e-11` in absolute error. These checks support equation transcription and numerical behavior for the selected cases. They do not prove a global error bound, positivity for every allowed parameter combination, convergence to Harmony, or any of the six open proof obligations.
