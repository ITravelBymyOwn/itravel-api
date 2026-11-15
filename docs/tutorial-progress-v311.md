# V311 — end navigation and return-origin explanation

Preview branch only: `preview/site-evolution-2026-11-12`. Main remains unchanged.

Completed:
- Every tutorial has a three-button end panel: previous, replay and next. Neighbor buttons include the tutorial title and short description. Missing neighbors are disabled at the first/last tutorial.
- Previous/next start the selected tutorial; replay starts the current one at zero. The panel stays visible when a floating video ends.
- Tested actual ended events using the native video End key: ES desktop replay/previous/next, first/last boundaries; EN next from 02 to 03; ES/EN 390×844 and landscape 844×390; floating end-panel bounds fit within the video.
- Tutorial 02 step 13 now explains in ES/EN that the return origin is prefilled with the last route city and can be edited. Values/timing are unchanged. Duration is 196.65 s in both languages. Audio packets are byte-identical to V309 (SHA-256 verified).
- Ending slide copy no longer contains the unsupported arrow glyph.

Remaining media work: full review/corrections of 01/03/04/05, continuous music in those videos, larger readable PDF close-ups in 04, and pointer geometry/visibility in 05. Do not describe all ten videos as complete. The next focused review block is 03 ES/EN (preferences, Info Chat, generation). Existing 03 ES/EN scene counts differ because EN skips screenshot 040; resolve that during parity review rather than silently claiming exact equivalence.

V309 native capture sources and V311 updated media/render sources remain available in the versioned backup package. Use the existing journey data; do not generate another itinerary for screenshots. The temporary viewport harness was removed after validation.

