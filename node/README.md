# OMI node kit: Ubuntu, Bash, and private state

Use a Bash terminal on each Ubuntu Desktop computer. The kit needs Git and Node.js 20 or newer; Node 24 LTS is recommended. The separate SQLite forum backend needs Node 24. This installer does not replace an existing Node installation or install global AI clients. If a prerequisite is absent, it explains what to install. No browser is needed for discovery, installation, or node control.

```bash
bash node/install.sh --prefix "$HOME/.local/share/omi-node" --check
bash node/install.sh --prefix "$HOME/.local/share/omi-node" --dry-run
bash node/install.sh --prefix "$HOME/.local/share/omi-node" --agents claude-station,codex-station,deepseek-station
bash node/nodectl.sh status --prefix "$HOME/.local/share/omi-node"
```

Run these commands from the extracted kit or the source repository. The installer creates owner-only directories and files under the absolute prefix. Keep this prefix on persistent storage outside the checkout. Temporary paths under `/tmp`, `/var/tmp`, `/run`, or `/dev/shm` are refused for installation unless `--allow-temporary-prefix` is explicitly supplied for testing. Checks and dry runs make no changes. They include a temporary-storage warning when relevant. An overlay filesystem can also be ephemeral; use the diagnostics below to investigate it.

The installation saves code in immutable, hash-verified runtime directories, a new roster snapshot, and an installer-owned `installation.json` pointer. It creates `station.json` only when absent. Every newly created participant is disabled. Reinstallation preserves an existing station configuration, queues, cursors, credentials, and prior roster snapshots. It never copies login files, scans your home directory, enables resource sharing, or starts a model.

Discovery checks only known executable names on `PATH`, standard NoMachine paths, bounded `--version` commands, and the NoMachine service state. Installed clients are candidates for the roster; authentication, model availability, and connection to the team remain unverified. Ollama model names can be inventoried only when you request a loopback endpoint:

```bash
node node/discover.mjs --ollama-url http://127.0.0.1:11434
```

No remote model endpoint is probed. An installed model runner and a downloaded model do not prove successful inference. Additional simple executable names can be checked with repeated `--extra-command NAME` flags, up to eight.

Configure each real participant's identity, addresses, local adapter, and existing Git credential helper using `relay/STATION.md`, `relay/MAILROOM.md`, and the bundle's adapter guide. Never put tokens in the station config or remote URL. Enable the selected seat in the private `station.json` only after that participant is ready. Then:

```bash
bash node/nodectl.sh start --prefix "$HOME/.local/share/omi-node"
bash node/nodectl.sh status --prefix "$HOME/.local/share/omi-node"
bash node/nodectl.sh stop --prefix "$HOME/.local/share/omi-node"
```

These commands control the headless mail station, not the models. Start refuses an all-disabled roster. The controller records its child PID and exact Node/script/config arguments, verifies the runtime hashes, and refuses to signal a process whose identity does not match. It sends a graceful stop without a forced kill. A process marked running has not thereby completed a remote send/receive test. Logs stay owner-private and contain station metadata; message contents and tokens are not logged by this kit. The controller deliberately refuses an ambiguous stale control lock rather than guessing who owns it. Stop a running station before installing a newer runtime.

The Bash launchers also work on macOS and WSL when Git and Node are available. Ubuntu is the tested target. Native Windows `.cmd` client version checks may report unavailable; use Ubuntu/WSL for this release. NoMachine is optional remote operator access, separate from mail transport and model adapters. Discovery does not activate licenses, read license files, install NoMachine, or expose a desktop to the network. Owner-reported entitlements can be recorded separately from observations:

```bash
node node/discover.mjs --reported-nomachine-licenses 5 --reported-nomachine-edition 'Enterprise Desktop' --reported-nomachine-valid-through 2027-10-22
```

## Diagnose disconnects and apparently missing state

```bash
bash node/diagnose.sh --prefix "$HOME/.local/share/omi-node"
bash node/diagnose.sh --prefix "$HOME/.local/share/omi-node" --record
```

The first command is read-only. It reports UID, fingerprints for the home/host/boot identity, uptime, filesystem type, available space/inodes, temporary or overlay mounts, and the NoMachine service state. It does not dump environment variables, journals, credentials, or license contents and does not change networking or restart anything.

The optional `--record` command writes a private canary and last observation under `PREFIX/state/diagnostics`. Run it before and after a disconnect or reboot. It compares the boot, user, home inode, prefix device/inode, and canary. Missing canary or changed identity is evidence to investigate, not proof of deletion. A freshly created user session, remounted volume, temporary live system, and an actual reset require different fixes. Existing files are never deleted by these diagnostics. Keep the JSON report available for the team; it contains metadata, not message bodies.
