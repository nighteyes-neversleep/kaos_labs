# OMI source payload for Claude

Full tracked `kaos_labs` source at commit `112f946d9e4f4301c58e1081612ab28db945f698`. The archive extracts into `kaos_labs/`.

Code branch: `omi/client-and-relay`. ZIP: `OMI_DUAL_FORK_PAYLOAD.zip`. Compare its SHA-256 with the sidecar and manifest. The source is suitable for inspection and development; it is not a claim of live browser installation or external AI connectivity.

Node 24 is required for the full application. The repository README describes setup, build, API and worker use. Tests already run for this source: 101 client/API tests, 114 headless tests, production build, and 13 synthetic team checks. The synthetic checks do not establish actual model connections.

Ignored signing keys, credentials, dependencies, private state and Git history are excluded. The separate PromptStamp browser patch remains local as Kaos requested.

Archive SHA-256: `af0dd14c084ad755392f7154446b50bf2b797a9bfafcd332f8705eceaa4608af`
