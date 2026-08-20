# CLAUDE.md — KAOS LABS OMI Client Working Contract

You are working inside the KAOS LABS OMI Client seed repository.

Read these files first, in order:

1. `omi-client/manifest.json`
2. `omi-client/registry/apps.json`
3. `omi-client/capsules/schema.json`
4. `omi-client/mesh/talky-spider.json`
5. `omi-client/shell/shell.json`
6. `omi-client/cartridges/README.md`

## Architecture

- OMI Client is the universal cross-platform seat.
- Personal Capsules hold identity, privacy, permissions, preferences, and personalized services.
- Talky Spider is the shared authenticated communications/mesh fabric.
- Pandora and mini-apps remain isolated modular cartridges.
- HoneycombMesh -> CartridgeArm -> SegmentNode -> Digital Brain Cell is the distributed work structure.
- VGPU/CPU/storage resources may be pooled only from user-authorized shares.
- Load balancing may begin only after Share is explicitly enabled.

## OMI Sharing Law

- Sharing defaults OFF.
- User authorization and an active share window are required.
- OMI may consume at most 15% of CURRENTLY IDLE resources, never 15% of total resources.
- Foreground user activity always wins and OMI yields immediately when demand rises.
- Private user data is never part of the shared resource pool.
- AUTO MANAGE may manage an authorized share window.
- TURBO is the manual user-triggered share mode and remains subject to the same 15%-of-idle ceiling.

## Hard Rules

Preserve the governing rules in `omi-client/manifest.json`:

- foreground user wins
- private data is not shared
- apps remain isolated
- signed modules only

Do not merge applications into a monolith.
Do not grant apps direct write access to OMI Core.
Do not infer runtime validation from registration or manifests.
Do not silently redesign OMI terminology or architecture.
Do not weaken privacy, sharing, or cartridge boundaries.

## Current Registered App Families

The registry currently contains declarations for:

- Eagle's Nest
- CORVID
- Bio-Tank
- Digital Assembly Line
- War Window
- LISA Braid
- Pandora Sat-Track

Registration does not mean runtime-attested or mounted.

## Working Method

When asked to continue work:

1. Inspect the repository first.
2. State the exact current files/structure.
3. Check requested work against `omi-client/manifest.json`.
4. Prefer the smallest reversible change.
5. Preserve modular cartridge boundaries.
6. Validate JSON/schema references after changes.
7. Report exactly what changed and what remains unverified.

If asked to inspect only, do not write.
If asked to write, do not redesign unrelated architecture.

## Immediate Build Direction

The next intended work is to mount and smoke-test actual cartridges through the OMI Client, beginning with family/private apps such as Eagle's Nest, while keeping each app separately deployable and testable.
