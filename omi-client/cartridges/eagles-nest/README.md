# Eagle’s Nest: local family board

This is a new, self-contained Eagle’s Nest cartridge implementation. It was not imported from the original ZIP referenced by the registry. Its working features are notes, editable to-dos, completion, filtering, removal and undo. A new board starts empty.

The OMI host must verify its signed HTML bundle and require an unlocked Personal Capsule before mounting it. Run the cartridge in an opaque-origin iframe with `sandbox="allow-scripts"`; do not add `allow-same-origin`. The cartridge does not request camera, microphone, network, top-navigation, storage or core-write permissions. It cannot sign in independently.

## Host bridge

The cartridge sends `{ type: 'omi:ready', appId: 'eagles-nest' }` after startup. The host responds to that message or the iframe load event with `{ type: 'omi:init', appId: 'eagles-nest', data }`.

The data shape is `{ version: 1, entries: [{ id, title, body, kind, done, createdAt }] }`, where `kind` is `note` or `task`. The host owns persistence in an encrypted, per-cartridge namespace of the current capsule. The cartridge sends `{ type: 'omi:save', appId: 'eagles-nest', requestId, data }` after each change. `requestId` is an incrementing positive integer. The host must verify `event.source` is the active iframe, validate the app ID and payload, reject writes when the capsule is locked, and serialize durable writes in their received order. Messages never contain the full capsule or PIN.

After a durable write finishes, the host replies `{ type: 'omi:saved', appId: 'eagles-nest', requestId }`. On failure it replies `{ type: 'omi:save-error', appId: 'eagles-nest', requestId, error }`. The board shows a saving status until the latest request is acknowledged. A failed save leaves the in-frame changes available and offers a retry button; it does not claim they were persisted. Older acknowledgments cannot overwrite the latest save status.

The cartridge accepts initialization only from its parent window and only once per mount. Titles are limited to 80 characters, bodies to 800 characters, and boards to 50 entries. User text is rendered with `textContent`. The host should enforce equivalent payload limits and reject extra capabilities.

Escape inside the initialized cartridge sends `{ type: 'omi:close', appId: 'eagles-nest' }` to its recorded parent origin and prevents the key’s default action. The host must validate the active iframe source and app ID before closing that mount. This request grants no core-write capability. There are no nested cartridge dialogs that intercept Escape.

Recommended iframe CSP:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'
```

This board has local persistence through OMI. It does not provide family synchronization, authenticated communications, cloud services, emergency messaging or peer resource consumption. Those features require independently tested Talky Spider and identity services.

## Accessibility and keyboard use

The board uses native headings, labeled inputs, grouped radio buttons and buttons with contextual names such as “Edit Weekend plans.” Filters expose their selected state with `aria-pressed`. Separate, always-present live regions announce board changes, validation errors and durable-save status without rereading the entire board. The title input references its validation message and exposes `aria-invalid` when empty submission fails.

Tab and Shift+Tab reach every action. Enter in the title adds or saves an item; Enter in details adds a new line, while Control+Enter or Command+Enter saves. Escape requests closure of this mount through the host. Editing moves focus to the title. Cancel returns focus to the item’s Edit button. Completing a task preserves focus on its toggle. Removal moves focus to Undo; restoring returns focus to the restored item, and dismissing Undo returns to the selected filter. Retrying a failed save moves focus to the title before hiding the retry button. If an item is hidden by a filter, focus falls back to that filter.

These actions use JavaScript buttons inside a named `role="form"` container because the intentionally restricted sandbox does not grant `allow-forms`. The cartridge preserves native input and button keyboard behavior without permitting a native form submission, navigation or network request. Mobile presentation follows DOM order; visible focus and reduced-motion preferences are supported. Automated and browser keyboard checks supplement, rather than establish, compatibility with every assistive technology.
