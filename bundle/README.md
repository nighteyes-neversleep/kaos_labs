# Build the headless all-AI bundle

This builder packages an explicit public-code allowlist into an extracted kit, deterministic ZIP, SHA-256 records, and a standalone `OMI_ALL_AI_HANDOFF.txt` containing actual source for AI review. It performs no network calls, account login, model invocation, browser work, or license activation.

Build requirements are Node 24, Git and Python 3. The recipient kit uses Bash, Git and Node; Python is needed only to construct the ZIP. See `node/README.md` for agent-only compatibility. The kit has no runtime npm dependencies.

For an issued release:

1. Finish and commit the code.
2. Run `node scripts/virtual-team-sim.mjs` successfully.
3. Run `node bundle/build.mjs --output /absolute/new/release-directory --simulation-report /absolute/path/test-results/simulation-report.json`.

Supplying a simulation report requires a passing `omi-virtual-team-sim/1` report with explicit `simulatedProvider:true`, the same clean source commit, and exact current executable/test file hashes. Changed files, a dirty source tree, a different commit, failed checks, or stale reports stop the release. A build without a report is marked **unverified developer package**, not a tested release.

The output contains:

- `kit/`: installer, headless relay/mailroom/adapter/station modules, guides, safe disabled-seat example, verification script and source-review material.
- `omi-agent-kit.zip` and `omi-agent-kit.zip.sha256`.
- `manifest.json` and its separate SHA-256 record.
- `OMI_ALL_AI_HANDOFF.txt`: plain text instructions followed by exact public code sections with file hashes.

Archive entries have sorted paths, fixed timestamps and fixed executable modes for Bash scripts. Identical source/report bytes and build toolchain produce identical archives. An existing output directory is never overwritten. The builder refuses symlinks in selected source paths and uses no shell-interpolated archive commands.

The manifest covers payload files and excludes itself to avoid a recursive hash. The archive checksum covers everything inside the archive, including the manifest. `node VERIFY.mjs` checks the listed payload bytes; compare the separately distributed archive hash through a trusted channel. Checksums do not establish publisher identity, ethical adequacy, model connectivity, or confidentiality.

The explicit allowlist excludes `.git`, `.omi-dev`, dependencies, private data directories, credentials, environment files, license files, browser state and model weights. Public source tests may contain synthetic fixture values; those are test inputs, not real credentials. The source-review directory is inspection material and is not advertised as the complete runnable web application.

Run the builder tests with `node --test bundle/build.test.mjs`. They verify manifest hashes, extracted verification, archive reproducibility, private-file exclusion, symlink refusal, output preservation, and simulation-release gating.
