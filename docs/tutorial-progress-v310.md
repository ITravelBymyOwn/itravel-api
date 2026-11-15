# ITBMO tutorial progress — V310

Branch: `preview/site-evolution-2026-11-12`. Production/main is unchanged.

## Completed media block

Tutorial 02 ES/EN is V309: 15 scenes and 58 actions in each language, 1920×1080, 196.65 seconds. Native UI screenshots contain the complete example values. Field positions come from the rendered controls; typing restores the source glyph pixels. The extra rectangular field highlight is removed. The animated pointer shrinks and fades during typing, then points to the actual controls. The continuous music mix has fades only at the start/end of the complete video. Both deployed files have been played in the browser.

Backup: `ITBMO_V309_TUTORIAL_02_ES_EN.zip`. Includes media, clean/native captures, action maps and rendering sources.

## Shared player UI

V310 changes the shared CSS/JS and both tutorial pages: stronger chapter-card contrast, a two-column mobile chapter grid, a floating player outside the main player viewport, back/close controls, a stable placeholder, and a modal that preserves the same video element/time. Floating playback is sized against both viewport dimensions. Mobile widths account for classic scrollbars. Short viewports constrain the main player height.

## Still pending — do not describe all 10 videos as complete

- Full visual and timing audit of videos 01, 03, 04 and 05 in both languages.
- Apply the continuous music pipeline to the remaining videos.
- Larger, readable PDF close-ups in tutorial 04, with adequate reading holds.
- Verify the pointer path/visibility in tutorial 05 and the remaining native input geometry in tutorial 03.
- Recheck ES/EN parity scene by scene, preserving the existing example values and UI appearance.

Use native recapture when a baked-in cursor overlaps a label or control. Automated inpainting and copying horizontal rows produced visible rectangles/ghost arrows in rejected V307/V308 experiments. Those attempts are not approved media. For new capture work, separate scene preparation and screenshot saving into different browser calls so screenshots reflect the updated fields; dismiss autocomplete before saving. Capture the original pointer in an empty header area, then restore only that empty header area from an equivalent native capture.

## Browser validation

- Desktop: playback keeps advancing when docked; Back to video restores the main slot; enlarge/close preserves current time and keeps one video element; changing chapters resets the selected media normally.
- 390 × 844: ES and EN play and dock within the viewport, with video bounds x=14…361 and y=124…317 in a classic-scrollbar viewport. Closing the floating player pauses it.
- 844 × 390: main video height is constrained below the header; floating EN playback fits (x=375…803, y=125…364). Modal bounds fit entirely in the viewport (top≈8, bottom≈382) without restarting playback.
- Mobile chapters form two visible columns, with chapter 05 on the last full-width row.

The temporary viewport-only test harness was removed after validation. Its frames loaded the actual ES/EN pages. Final landscape main-player bounds: x=21…808, y≈85…366 in 844×390, with native video content centered and all controls in view.
