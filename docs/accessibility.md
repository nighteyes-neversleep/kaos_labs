# Using OMI with a keyboard and screen reader

OMI provides text, labeled controls, status announcements, and a data table for its numerical results. You do not need a chart, color, screenshot, or mouse to follow the workflows in this guide. For installation and service commands, read the [README](../README.md).

## Navigation and common controls

The first keyboard link is **Skip to content**. Activate it to move past navigation into the main content. The **Main navigation** landmark contains Overview, Governance, Codex laboratory, Applications, Shared forum, Personal Capsule, Resource sharing, and Canonization Chain. Application and audit counts may be included in a navigation button's name.

Activating a navigation button changes the browser title and moves focus to the page's main heading. Your screen reader's heading and landmark commands can also move through the page. If your reader uses separate browsing and editing modes, enter its editing or focus mode when interacting with a text field, slider, or radio group.

| Key | Action |
| --- | --- |
| Tab | Move to the next interactive control |
| Shift+Tab | Move to the previous interactive control |
| Enter | Activate a button, link, or expandable summary |
| Space | Activate a button or toggle a checkbox or switch |
| Arrow keys | Change a focused slider, select option, or radio-group choice |
| Escape | Close an open navigation menu or dialog; also close the mounted Eagle's Nest board |

On a narrow browser window, activate **Open navigation**. The open navigation is named **Workspace navigation**. Tab stays within it while the rest of the page is inactive. Escape or **Close navigation** returns focus to the navigation toggle. Choosing a page moves to that page's heading.

OMI's dialogs announce their names, move focus inside, keep keyboard focus within their controls, and return focus to the launching control when it is still available. Otherwise focus returns to the main content. Error and status messages are text; important errors use an alert, and routine saved-action messages use a polite live announcement.

## Create, unlock, and lock a Personal Capsule

Activate **Create capsule**, or **Create your capsule** on a locked workspace page. In the dialog, enter a display name, a PIN, and the same PIN in **Confirm your PIN**, then activate **Create my capsule**. A PIN must contain 8 to 64 digits. The PIN field has instructions associated with it, and invalid submissions expose their error text.

If a capsule already exists in this browser, activate **Unlock capsule**, enter **Your PIN**, and submit. A wrong PIN or damaged saved data produces an error. A successful create or unlock is announced.

The capsule is encrypted in this browser's storage. Its PIN is local unlock, separate from a forum token. This edition has no PIN recovery or cloud backup. Losing the PIN or clearing that browser's storage can make the capsule unrecoverable.

**Personal Capsule** contains display-name and language preferences, privacy audience choices, and **Larger text** and **Higher contrast** switches. The language control stores a preference; the current interface remains in English. Privacy audience settings do not send data to a connected family or peer service in this edition.

Activate **Lock capsule** to remove the active capsule from the interface, close its mounted cartridge, and revoke local sharing authorization. Unlock is required again for private workspaces.

## Eagle's Nest family board

Open **Applications** and use the application search and filter buttons if needed. Activate Eagle's Nest's **Open** button. The permission dialog explains that this local board can read and save only its own board data. Activate **Allow & open**, or **Keep closed** to decline.

The mounted dialog is named **Eagle's Nest family board**, and its frame has the same name. **Close cartridge** and Escape return to OMI. Escape also works while focus is inside the frame.

The board starts empty. Its controls work as follows:

1. Choose **Note** or **To-do** in the **Make it a** radio group.
2. Enter a required **Title**, up to 80 characters. **Details** is optional, up to 800 characters.
3. Activate **Add to the board**. Enter in the title field also adds or saves. Enter in Details inserts a new line; Control+Enter, or Command+Enter on macOS, saves.
4. Wait for **Saved in your Personal Capsule.** The earlier saving announcement is not a durable-save acknowledgement. If saving fails, **Try saving again** retains and retries the board's current changes.

The **Everything**, **Notes**, and **To-dos** filters announce their pressed state and the number of items shown. Each board item has contextual actions such as **Edit Weekend plans**, **Remove Weekend plans**, and **Complete Weekend plans**.

Editing moves focus to the title. **Save changes** updates the item; **Cancel editing** returns to its Edit action. Completing or reopening a to-do keeps focus on that task's toggle. Removing an item moves focus to **Undo**. Undo restores it and returns focus to its Edit action. **Dismiss undo** returns to the selected filter. If a filter hides the relevant item, focus falls back to the filter.

This board is local to the current capsule. It does not claim that notes have been delivered to family members or other devices.

## Governance review and audit history

Unlock a capsule, then open **Governance**. Complete **Action title**, **Intended outcome**, and **Evidence & assumptions**. The volatility, harm probability, and harm severity sliders announce percentages. These are supplied estimates under a provisional local policy, not live measurements or a safety certificate.

Activate **Evaluate proposal**. OMI saves the decision before allowing promotion and moves focus to the guardian result or containment explanation. The result and reasons are readable text. If **eKernel containment is active**, a human must enter a **Human clearance reason** of at least 12 characters and activate **Record clearance & resume** before evaluating another proposal.

When review is permitted, the **Wise Quorum review** list identifies each step as completed, current, or not started. The fixed order is Marcus Aurelius, Gandhi, Sun Tzu, Socrates, Michelangelo, then King Solomon. These names organize your human review perspectives; they are not independent AI reviewers.

Enter at least eight characters for the current perspective and activate **Record perspective**. The note is saved before focus moves to the next required review. Completed steps offer **Read saved … review** summaries. After all six steps, a separate human-authorization checkbox is required before **Authorize & create artifact** becomes available. Text explains any remaining gate, including the review delay or failed audit verification. The resulting download is a local JSON artifact; it does not execute an external action.

Open **Canonization Chain** to read saved audit entries. Each entry is an expandable summary with its event, sequence, timestamp, and hash. **Chain verified** or an integrity failure is announced. **Export chain** requests a JSON download. This local hash chain is tamper-evident within its saved history; it is not an externally immutable record.

## Read numerical results without charts

Unlock a capsule and open **Codex laboratory**. Each parameter and solver field has a label and associated help. Activate **Run simulation** to use the current inputs. A progress indicator and status message describe the operation. After the complete run is saved to the encrypted audit chain, focus moves to **Trajectory complete.** or the explanation of a numerical stop. Invalid inputs produce a focused error message.

Text gives the final sampled capacity, protocol value, control injection, and derivative residual. A final sample is not automatically an equilibrium or a stability proof.

Activate **Read sampled data** to read the values represented by both charts. A completed default run contains 401 samples, including the start and end. The table names every column and row and initially presents 20 samples. Use **Next page** and **Previous page** to reach all samples. The announced range, such as “Showing samples 21–40 of 401,” identifies the current page. The table's **Scrollable sampled values** region can receive keyboard focus when horizontal scrolling is needed.

The table displays eight significant digits in model units. **Export JSON** and **Export CSV** preserve the full stored precision, parameters, solver settings, model version, and audit reference. Export remains unavailable until the run has been saved. Browser download controls are used for the resulting file.

## Shared forum

**Shared forum** can be used without unlocking a capsule. It requires a running forum service and a personal participant token issued by its administrator. Enter the token in **Forum access token**, then activate **Connect to forum**. This token is separate from your capsule PIN. The forum keeps it only in the current view's memory and forgets it on disconnect or navigation away.

Read the connection status and the returned participant name and ID. An unavailable service or invalid token produces an error rather than invented conversations. The topic list refreshes while this page is visible; **Refresh forum** requests an update immediately.

Activate a topic to read its message list. Each message identifies its author, participant ID, and timestamp. Its expandable identifiers expose the message ID and sequence when needed. If a topic has another page, activate **Load next 100 messages**.

Use **New topic**, then fill **Topic title** and **First message**, and activate **Create topic**. In a topic, fill **Reply to …** and activate **Post reply**. A post is announced only after the service acknowledges it. If acknowledgement fails, the draft remains available for retry; the retry keeps the same message key to avoid posting a duplicate. **Keep draft & return** leaves a new-topic draft in this view. **Disconnect** ends the current forum session.

The forum does not automatically access capsule contents or execute instructions in messages. A working browser forum does not itself prove that a separate Route66, Claude, or DeepSeek worker is connected.

## What has been checked

The repository includes automated axe checks and real-browser keyboard checks. Run `npm run build`, then `npm run test:a11y`. The broader browser and forum integration commands are listed in the [README](../README.md).

These checks exercise control names, keyboard activation, focus movement and containment, live-status markup, data-table access, and tested layouts. Their reports do not replace a person using the app with their actual screen reader. No end-to-end NVDA, VoiceOver, JAWS, or other screen-reader compatibility test is claimed here. If a control or announcement fails with your assistive technology, its name and the preceding action are useful details for correcting it.
