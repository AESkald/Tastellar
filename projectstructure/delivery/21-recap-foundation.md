# 21 — Recap foundation

Recap is a single-column feed of editable poster compositions over the active ranked library; it does not show the Library folder column. The gallery offers only templates supported by available entries and fields. Release-year and decade posters require known release years, and format posters need enough rated entries per type. Empty, sparse, or unplaced libraries receive an invitation to add ratings or ranking positions. The former personal-selection template is hidden; saved drafts using it remain preserved for compatibility.

Each feed poster and editor preview use the same content-sized canvas scene, which is also the source for PNG export. Users can swap, remove, or replace works; filter by all or selected media types and tags; and edit saved drafts. Type filters combine with the tag selection using AND; selected tags match any or all as chosen. The feed has no style selector. Style is changed in the editor and defaults to the palette matching the active app theme. Cover mode uses the Library's 0.76 portrait cover treatment, with subtle rank badges and short names along the bottom; names on covers are optional. Text mode always includes work names and has an independent media-type label toggle. Missing artwork uses the media-type icon and work initial. Top Ten, Challengers, and Format support horizontal or vertical layouts; 3 × 3 remains a portrait grid with #1 centered and the feed/editor canvas fits the available viewport without horizontal overflow. Opening the editor selects no work; clicking the selected slot again or completing a swap clears selection.

The Tastellar watermark starts enabled. Removing it opens a well-spaced message about the free, ad-free, non-commercial open-source app every time and removes the watermark from all Recap posters; users can enable it again. PNG export uses the selected scene dimensions.

Drafts persist in Preferences as bounded, versioned JSON (up to 30 drafts, 300 total slots, and 1 MiB). Slot snapshots retain title, short label, media-type name/icon, release year, rank, and immutable cover asset reference. Portable backups include referenced cover assets. Drafts survive route and theme changes; source fingerprints detect relevant library/ranking changes without treating preference revision bumps as content edits. Rust validation accepts legacy style/mode values for import compatibility while the UI normalizes them to current choices.

## Validation

The focused Recap Playwright suite passes 3/3. Coverage includes feed/editor parity, theme and orientation controls, media/tag filters, selection and swap behavior, saved drafts, watermark and delete confirmations, sparse or unplaced libraries, and PNG dimensions.

A browser performance fixture with 120 synthetic covers across eight release-year pages measured 153.5 ms cold and 89.4 ms warm for loading plus canvas rendering. Per-page cover resolution p95 was 5.9 ms cold and 1.2 ms warm; navigation took 121 ms median and 214 ms maximum. These Chromium/Vite preview figures cover in-memory browser assets, not native storage or desktop decoding.

Recap domain and renderer tests pass 17/17, including 9 domain tests; storage tests pass 76/76. Formatting, the Tauri crate check, and the frontend production build pass. The full frontend unit suite reports 95/97; two existing `rendering/scenes/sceneLayout.test.ts` cases fail for constellation viewport sizing and deep-field brightness.

The renderer uses system UI fonts rather than bundled fonts. Browser preview PNG download is verified; the native destination picker and target-specific behavior beyond local Tauri compilation were not verified in this validation pass.
