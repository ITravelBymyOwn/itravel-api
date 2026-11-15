# V312 — Two tutorial playback modes

Preview branch: preview/site-evolution-2026-11-12. Production/main untouched.

## Delivered
- Watch opens the wide modal immediately. Native first playback also opens it.
- Same single video element moves between the integrated slot and modal. Closing returns to the slot and scrolls it into view, preserving playback time and paused/playing state.
- Enlarge reopens the modal without resetting the video.
- Removed the small docked player, visibility observer, dismiss/recovery buttons and corresponding CSS.
- Modal has persistent Previous / Replay / Next navigation with adjacent tutorial titles. End overlay retains descriptions. Both navigation sets start the requested tutorial in the current mode. First/last boundaries disabled.
- ES/EN asset cache versions bumped to 312. Existing media unchanged.

## Verified on real preview pages
- EN desktop: initial playback opens modal, one video only, playing; close while playing keeps time and playback; close/reopen while paused keeps exact time and pause.
- Modal Previous/Next loads corresponding video and plays without closing. End overlay Next also remains in modal and starts next video. First tutorial Previous disabled.
- Integrated Next starts corresponding video while staying integrated. No dock classes or tools exist.
- Real page iframe viewport QA: 390x844 portrait ES and EN playback opens modal; 844x390 landscape EN modal and navigation fit viewport. EN Next starts tutorial03 in the same modal. ES labels localized.
- JS syntax check passed. Temporary viewport QA page removed after verification.

## Remaining tutorial media work
V311 tutorial02 media retained. Earlier pending media audit/corrections for 01/03/04/05, black cursors, PDF legibility and ES/EN scene parity remain separate work. No claim those media have been re-rendered in V312.
