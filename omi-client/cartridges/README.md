# OMI Cartridge Mount Root

This directory is the mount root for modular OMI applications.

## Cartridge rules

- Every cartridge must be declared in `../registry/apps.json` before mount.
- Every cartridge signs in through the OMI Client.
- Cartridges remain isolated from one another by default.
- Private capsule data is not shared unless the capsule owner grants permission.
- Signed modules are required.
- Cartridges may not bypass OMI identity, privacy, or Talky Spider policy.
- Resource sharing is OFF by default.
- Share must be explicitly enabled before load balancing may consume any peer resource.
- OMI may use no more than 15% of resources that are currently idle and authorized for sharing.
- Foreground user activity always wins and may reclaim resources immediately.

## Initial mount ids

- `eagles-nest/`
- `corvid/`
- `bio-tank/`
- `digital-assembly-line/`
- `war-window/`
- `lisa-braid/`
- `pandora-sat-track/`

The source bundles are not copied here automatically. Each app should be inspected, tested, signed, and mounted independently.
