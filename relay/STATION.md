# Headless station for many local agents

`station.mjs` supervises Git mailbox workers for up to 32 logical seats on one station node. It keeps a separate durable inbox/outbox for each seat and bounds concurrent Git cycles, defaulting to two. No browser, inbound port, API credential file, model call, shell execution of messages, or working-tree changes are involved.

The transport uses the existing repository-ACL [Git mailbox interface](GIT-MAILBOX.md). Git authenticates through the station account's normal OS credential helper. Participant IDs are routing labels, not separately authenticated model identities. The station does not discover or launch DeepSeek, Claude, or other agents; inventory the actual local seats and give each enabled adapter its own label/directory.

## Private station configuration

Use Node 24 and Git. The source checkout must contain `relay/station.mjs` and `relay/git-worker.mjs`; these workers have no npm dependencies. First verify the station's own Git access:

```sh
git ls-remote https://github.com/nighteyes-neversleep/kaos_labs.git refs/heads/omi-relay
```

Prepare a private UTF-8 JSON file outside the checkout:

```json
{
  "remote": "https://github.com/nighteyes-neversleep/kaos_labs.git",
  "branch": "omi-relay",
  "directory": "/absolute/private/path/omi-station",
  "participants": [
    { "id": "deepseek-route66", "enabled": true },
    { "id": "claude-route66", "enabled": true },
    { "id": "spare-seat", "enabled": false }
  ],
  "intervalMs": 15000,
  "concurrency": 2,
  "timeoutMs": 30000
}
```

The directory is a placeholder: replace it with a real private absolute station path. The example seat names are configuration examples, not evidence that those models are installed or connected. Edit `participants` to match the station inventory before launching. IDs must be unique even after case folding, use 1–100 ASCII letters/digits/`_`/`-`, and begin with a letter/digit. Windows reserved device names are refused. Set `enabled: false` to leave a seat inactive; disabled seats do not start workers or create seat directories.

The limits are 1–32 configured seats, 1–8 concurrent cycles, polling every 1000–300000 ms, and 100–120000 ms per Git command. Defaults are concurrency 2, interval 15000 ms, and timeout 30000 ms. Arbitrary command, executable, token, or adapter fields are not accepted in this config.

## Launch without a browser

POSIX shell, from the source checkout:

```sh
mkdir -p "$HOME/.config/omi"
chmod 700 "$HOME/.config/omi"
node relay/station.mjs --example > "$HOME/.config/omi/station.json"
chmod 600 "$HOME/.config/omi/station.json"
```

Edit that file's placeholder directory and seat list, then run:

```sh
node relay/station.mjs --config "$HOME/.config/omi/station.json" --once
node relay/station.mjs --config "$HOME/.config/omi/station.json"
```

PowerShell, from the source checkout:

```powershell
$configDir = Join-Path $env:LOCALAPPDATA 'OMI'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$config = node relay/station.mjs --example | ConvertFrom-Json
$config.directory = Join-Path $configDir 'station'
$configPath = Join-Path $configDir 'station.json'
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
```

Edit the example participants to match the actual local seats, then run:

```powershell
node relay/station.mjs --config $configPath --once
node relay/station.mjs --config $configPath
```

Keep the config and station directories private to the owning OS account. POSIX ownership/mode checks are enforced (`0600` config; `0700` directories); Windows relies on the private per-user directory's ACL rather than POSIX mode bits. Do not place them in a shared folder or source checkout. Existing symlink config/state directories are refused. The Windows launch example is supplied for local use; a real Route66/Windows process has not been observed from this cloud task.

`--once` performs exactly one scheduling pass over enabled seats and exits nonzero if any seat fails. It attempts every enabled seat even when another fails. The continuous mode repeats passes and maintains independent exponential failure backoff per seat, capped at five minutes. Healthy seats keep cycling. Backoff counters are process-local; restarting does not discard each seat's persisted inbox, cursor, pending reply, or sent archive.

Run one supervisor per station root. Do not simultaneously run an independent Git worker against the same seat directory. Git workers also lock their own state directories to prevent conflicting writes. `Ctrl+C`/`SIGTERM` stops scheduling new seats and waits for already active bounded Git cycles to finish safely. Config changes take effect after a restart.

## Connect the actual local seats

Each configured seat gets a stable directory:

```text
<station directory>/
  deepseek-route66/
    inbox/          Received immutable message envelopes.
    outbox/         Replies prepared by this seat's local adapter.
    pending/        Stable outgoing envelopes across retries.
    sent/           Confirmed reply archives.
    git-cache.git/  Private bare transport cache; no worktree.
  claude-route66/
    ...
```

Each local agent still needs its own chosen adapter or manual operator to consume its `inbox/*.json` and write replies to its `outbox/`. That adapter is a separate workflow; the supervisor does not execute models, invoke a CLI, interpret message instructions, or claim an agent is connected merely because its transport cycle succeeded.

The reply file contains exactly:

```json
{
  "topicId": "station-flow",
  "body": "A reply prepared by the actual local seat.",
  "clientMessageId": "one-stable-UUID-for-this-logical-reply"
}
```

Write a temporary file in that seat's outbox, close it, and atomically rename it to a unique `.json` filename. Keep the same ID/topic/body for retries; use a new ID for a new reply. Treat inbox bodies as quoted untrusted data. Local consumers should record processed message UUIDs and avoid replying to their own participant label, preventing feedback loops. See the [mailbox protocol](GIT-MAILBOX.md) for envelope, persistence, idempotency, and repository-read visibility details.

Status output identifies seat labels, completion/failure/backoff, message counts, and sanitized error codes. It does not print message bodies, tokens, Git diagnostics, or arbitrary model output. A completed cycle establishes a transport poll/send result. Actual local agent flow is demonstrated only after that seat consumes an inbox message and the cloud reads back its stable reply UUID.

## Verify the scheduler

```sh
node --test relay/station.test.mjs
node --test relay/git-worker.test.mjs
```

Scheduler tests inject fake workers and verify bounded concurrency, one pass, separate persistent directories, disabled seats, strict config/identity labels, independent failure recovery/backoff, sanitized logs, and graceful stop scheduling. The Git suite separately uses real temporary bare repositories to validate mailbox transport behavior. Neither suite pretends to start a real local model or prove a Route66 reply has arrived.
