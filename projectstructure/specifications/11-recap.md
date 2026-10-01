# 11 — Recap compositions and export

Recap creates editable local images; it does not post them. It has no Library group column. Use a template gallery with eligibility reasons, live preview, contextual composition inspector, and Export image. Data comes from canonical ranking, never a renderer-specific sort.

## Templates and exact eligibility

Only active rated works are eligible by default; filters may narrow them. A missing cover never makes an otherwise eligible work ineligible. Use year predicates only on known release years, show omitted-date counts, and never imply complete year coverage.

| Template | Minimum and selection | Initial export canvas |
| --- | --- | --- |
| My Personal Canon | ≥10 eligible; select top 10 | 1080 × 1920, portrait 9:16 |
| The Throne and Its Challengers | ≥5; top 1 plus 2–5 | 1080 × 1350 |
| 3 × 3 | ≥9; top 9 across selected media/filter | 1080 × 1080 |
| My #1 by Release Year | ≥3 distinct known years in chosen range; best per year | Height 1080; width 240 per year column + 160 margin, max 4096; paginate longer ranges |
| Best of Each Decade | ≥3 eligible decades; best per decade | 1080 × 1350 for 3–6 slots; 1920 × 1080 for 7–10; paginate beyond |
| My #1 in Each Format | ≥2 active media types with at least one rated work; top per type, custom included | 1080 × 1350 up to 6 types; adaptive grid/pages above |

A year/decade can contribute a single rated work, but label “My #1 among recorded works” and show eligible count in editor help; do not claim a contest among unrecorded releases. For a selected continuous year range, years without entries are visibly empty labeled slots or can be omitted by an explicit “Hide empty years” option. No placeholder cover masquerades as a winner. Date-less templates remain usable without dates. With fewer than two rated entries show a profile preview and invitation rather than an ineligible top template.

## Composition model and invariants

A composition stores template/version, style, canvas preset, ordered slot IDs, source filter, original selected entry IDs, per-slot title/type/year/nullable rank and placed-state snapshot, cover asset reference/crop, text overrides, colors/font choices, and creation revision. A selected unplaced work has no rank snapshot; a user's explicit slot order is labeled “My selection,” not a library rank. Persist drafts. Library changes do not silently rearrange a saved composition: show “Library changed” with explicit Refresh from library and a preview of changes. A removed/trash entry can remain in a saved snapshot unless purged; purge handling follows Data safety.

Actions: swap two slots, remove a slot's work, click an empty slot to choose a replacement, edit heading/caption, choose style/mode, adjust crop, undo/redo draft edits. Rank numbers describe composition order when manually changed and are labeled “My selection” rather than falsely asserting current library rank. Default unedited compositions may say “My top 10.” Editing a composition never writes library ratings/order.

Replacement picker initially enforces the slot predicate (same year/type where applicable); duplicates are disallowed within one composition. To use an out-of-predicate work, user must explicitly switch to a custom selection layout and remove the now-false semantic heading. A removed slot remains editable and exports as intentional whitespace/text tile; it does not cause invisible reindexing until the user chooses Compact layout.

## Layout and visual system

Personal Canon uses ten content regions with #1 approximately twice the area of each other work. Starting grid: 3 columns × 4 equal-height units, #1 spans 2 × 1 units, #2 uses remaining first-row unit, #3–#10 use eight following units, final spare unit holds title/profile/watermark. Cropped portrait images sit inside each card with readable title/rank overlay or adjacent strip. Validate this asymmetrical layout at export size, not just thumbnail size.

Initial styles for Canon: minimalist (quiet typography), magazine (editorial headings), VHS (restrained analog texture), manga panel (monochrome borders and captions), brutalist (large type and hard grid). Styles share the same composition semantics, editing affordances, and contrast rules. Other templates initially offer minimalist plus compatible styles; do not promise every style/layout combination before QA.

All templates support cover and text modes. Cover mode uses neutral mats, consistent crops, legible title bands, and optional desaturated background accents to tolerate clashing artwork. Missing-cover cards use the same visual weight with title, type/year, and deliberate typography. Text mode is a designed layout, not empty image frames. Mixed mode must still look intentional. Protect watermark and title safe areas; watermark is subtle readable “Made with Tastellar”, with no invented URL or account identifier.

## Export pipeline

Use a dedicated Canvas 2D renderer consuming a versioned layout scene graph (rectangles, text, images, clipping, opacity), shared by preview and export. Do not screenshot the interactive UI or rely on DOM layout capture. Bundle licensed fonts with known coverage; load font/image assets completely before export. Measure and wrap text using the same layout engine; never silently cut off a long title. Preview overflow warnings and fallback font choices.

Default PNG in sRGB, opaque chosen background, no source EXIF/location metadata. Optional JPEG requires an explicit background. Export user-selected file through a platform adapter; Android uses storage/share intents. No social upload. Bound output to 4096 px per axis initially and render pages sequentially to control memory. At 4096², one RGBA buffer alone is about 64 MiB, so avoid duplicate full-size buffers and release assets between pages. Show progress/cancel and actionable permission/disk errors. A multi-page timeline exports numbered files with clear count.

## Acceptance

Every template is visually checked with unrelated cover palettes, all covers absent, one missing image, custom media names, long titles, non-Latin user text, and sparse dates. Swapping cards changes only the composition. PNG dimensions match the selected preset, text is not clipped, watermark is present, and restoring an archive preserves editable drafts and their asset references.
