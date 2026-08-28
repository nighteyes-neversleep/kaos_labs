# KAOS Family Dock

Private family launcher for isolated OMI Client cartridges.

## Purpose

Family Dock is a thin front door. It does not merge applications, own private app data, or bypass OMI identity/privacy rules.

Each family member gets a private runtime profile that controls which apps are visible. Real names, contact details, travel details, PINs, biometrics, tokens, and private permissions MUST NOT be committed to this public repository.

## Runtime model

1. User authenticates through the local/private family identity layer.
2. Family Dock loads `config.json` from the deployed private runtime directory.
3. Dock shows only apps allowed for that profile.
4. Selecting an app launches that isolated cartridge at its configured route.
5. App data remains inside that app's governed storage boundary.

## Initial family lanes

- Eagle's Nest: private workshop / contractor / design assistant.
- War Window: travel-aware conflict, contacts, and support information.
- Future family cartridges may be added without changing the Dock architecture.

## Privacy rule

The committed `config.example.json` contains placeholders only. Production `config.json` is private and must be provisioned on the serving host.

## Suggested serving route

`https://family.kaoslabs.cloud/`

The route is only a suggestion. Deployment and Cloudflare policy remain separate from this repository scaffold.

## Hard rules

- apps remain isolated
- private data is not shared by default
- no cross-profile reads without explicit permission
- no secret/token storage in browser code
- no family personal data in the public repo
- no app receives another app's files by implication
- offline/unavailable apps fail independently; Dock remains usable
