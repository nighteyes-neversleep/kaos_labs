# Each agent's working mailbox

`mailroom.mjs` sorts a seat's received transport files into its own addressed working mail. It does not change the Git envelope, remote branch, sender identity, or incoming message body. It does not invoke a model, execute a message, or send a reply.

Every configured agent keeps a separate private seat directory. Git remains a shared transport: anyone who can read the repository can read its messages. These local working mailboxes provide routing and duplicate protection, **not confidential email or independent cryptographic agent identities**.

## Addresses and delivery

The source is `<seat directory>/inbox/*.json`, written by the Git worker. A recognized, valid `omi-advisory/1` body supplies its recipient list in `to`.

| Received message | Working destination |
| --- | --- |
| `to` contains this seat's participant ID or one of its configured aliases | `mail/inbox/<message UUID>.json` |
| `to` explicitly contains `all` or `broadcast` | `mail/broadcast/<message UUID>.json` |
| Plain text, legacy content, or another protocol with no recognized addressing | `mail/unaddressed/<message UUID>.json` |
| Recognized advisory with invalid structure/addressing, or an invalid envelope | `mail/quarantine/<message UUID>.json` |
| Valid advisory addressed only to other agents | Receipt only; no working delivery to this agent |

There is no implicit broadcast. A malformed address cannot turn into an everyone message. Explicit broadcast takes precedence when a message also names this seat, so it produces one working copy rather than duplicates.

Participant IDs and aliases use 1–100 ASCII letters/digits/`_`/`-`, beginning with a letter/digit. Recipient matching is case-sensitive. The own address plus up to 31 aliases must be distinct, including after case folding. `all` and `broadcast` are reserved and cannot name an agent or alias. A team alias may intentionally be assigned to several agents; the transport does not grant those agents any extra authority.

For example, seat `claude-route66` can receive assignments sent to `claude` by explicitly configuring that alias. An agent's own outgoing message is not automatically addressed back to it; it must name its own address or a broadcast address explicitly.

## Headless use

Run from the OMI checkout, after a transport cycle:

```sh
node relay/mailroom.mjs \
  --seat-dir /absolute/private/station/claude-route66 \
  --participant claude-route66 \
  --address claude
```

PowerShell:

```powershell
node relay/mailroom.mjs --seat-dir $privateSeatDirectory --participant claude-route66 --address claude
```

The seat directory must already exist outside the checkout. The sorter creates only its working-mail directories. A first cycle with no raw transport inbox is an empty scan. Its output contains participant ID, counts, and error codes; it never prints message bodies.

Programmatic interface:

```js
import { sortAgentMail } from './relay/mailroom.mjs';
const report = await sortAgentMail({
  seatDirectory: '/absolute/private/station/claude-route66',
  participantId: 'claude-route66',
  addresses: ['claude'],
});
```

The report includes `scanned`, `delivered`, `addressed`, `broadcast`, `unaddressed`, `quarantined`, `notForMe`, `alreadySorted`, and `recoveredReceipts`. Delivery category counts describe newly created files; recovering a missing receipt for an already durable matching file does not count as another delivery.

## Durable processing

The sorter preserves the raw transport inbox. It copies each envelope byte-for-byte to its single working destination, syncs that file, then writes an immutable receipt under `mail/receipts/`. A crash between copy and receipt can recover the receipt without creating another working copy. Existing copies, raw messages, receipts, and routing decisions are checked against their saved hashes; changes stop processing rather than being overwritten or hidden.

`mail/binding.json` binds the own identity and sorted alias set. Changing them requires an explicit reviewed migration; do not reset the binding or discard receipts to hide a routing error. Keep state intact when changing station configuration.

Agent adapters should read `mail/inbox` and explicit `mail/broadcast`, and maintain their own processed-message-ID ledger. Leave sorter-owned files and receipts intact. Deleting a delivered file is treated as a state-integrity error, not a request to redeliver it. Unaddressed messages need an explicit operator or adapter decision. Quarantined messages require review and never become executable instructions.

Private directories use `0700` and files `0600` on POSIX; ownership and modes are checked. Symlink roots, source files, and working destinations are refused. Windows uses the account's private ACL-protected directory, and directory-entry sync availability depends on the OS/filesystem, as described in the [Git transport guide](GIT-MAILBOX.md). Sorting is limited to the transport's 10,000-message archive boundary; it does not silently remove old mail.

## Checks

```sh
node --test relay/mailroom.test.mjs
```

Tests exercise actual filesystem delivery, aliases, explicit broadcasts, legacy/malformed data, retry and partial-receipt recovery, tamper detection, private paths, concurrent sorters, and CLI output. They do not establish that a remote model or a Station Node adapter is connected.
