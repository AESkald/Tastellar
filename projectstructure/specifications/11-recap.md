# 11 — Recap compositions and export

Recap creates editable local images; it does not post them. It has no Library group column. Use a template gallery with eligibility reasons, live preview, contextual composition inspector, and Export image. Data comes from canonical ranking, never a renderer-specific sort.

## Templates and exact eligibility

Only active rated works are eligible by default; filters may narrow them by media type and tags. Selected media types and the selected tag group combine with AND. The user can choose whether the tag group matches any selected tag or all selected tags; an empty tag selection adds no restriction. A missing cover never makes an otherwise eligible work ineligible. Use year predicates only on known release years, show omitted-date counts, and never imply complete year coverage.

| Template | Minimum and selection | Canvas behavior |
| --- | --- | --- |
| Top ten media | ≥10 eligible; select top 10 | User chooses portrait or landscape; landscape is the initial choice. #1 is dominant and the other nine form a 3 × 3 group. |
| The Throne and Its Challengers | ≥5; top 1 plus 2–5 | User chooses portrait or landscape; landscape is the initial choice. |
| 3 × 3 | ≥9; top 9 across selected media/filter | A true 3 × 3 of portrait covers, with #1 slightly larger in the center. It has no portrait/landscape chooser. |
| My #1 by Release Year | ≥3 distinct known years in chosen range; best per year | The layout follows its year count and content. Paginate ranges that exceed renderer limits. |
| Best of Each Decade | ≥2 eligible decades; best per decade | The layout adapts to the eligible decade count and content. |
| My #1 in Each Format | ≥2 active media types with at least five rated works each; top per type, custom included | User chooses portrait or landscape; landscape is the initial choice. |

Canvas dimensions follow the chosen composition and rendered content. Do not force a 9:16, 16:9, square, or padded mat around designs whose composition does not need it. Keep vertical cover cells near a 0.76 width-to-height ratio.

A year/decade can contribute a single rated work, but label “My #1 among recorded works” and show eligible count in editor help; do not claim a contest among unrecorded releases. For a selected continuous year range, years without entries are visibly empty labeled slots or can be omitted by an explicit “Hide empty years” option. No placeholder cover masquerades as a winner. Date-less templates remain usable without dates. With fewer than two rated entries show a profile preview and invitation rather than an ineligible top template.

## Composition model and invariants

A composition stores template/version, style, canvas preset, ordered slot IDs, source filter including optional tag IDs and any/all tag mode, original selected entry IDs, per-slot title/type/year/nullable rank and placed-state snapshot, cover asset reference/crop, text overrides, colors/font choices, and creation revision. Persist drafts. Library changes do not silently rearrange a saved composition: show “Library changed” with explicit Refresh from library and a preview of changes. A removed/trash entry can remain in a saved snapshot unless purged; purge handling follows Data safety. Previously saved selection-template drafts remain archive-safe but are hidden from the active template gallery.

Actions: swap two slots, remove a slot's work, click an empty slot to choose a replacement, edit heading/caption, choose style/mode, adjust crop, undo/redo draft edits. Opening an editor does not preselect a work. Clicking the selected slot again clears selection; completing a swap also clears selection. Default unedited compositions may say “My top 10.” Editing a composition never writes library ratings/order.

Replacement picker enforces the active media and tag filters plus the slot predicate (same year/type where applicable); duplicates are disallowed within one composition. A removed slot remains editable and exports as intentional whitespace/text tile; it does not cause invisible reindexing.

## Layout and visual system

Top ten uses a dominant #1 cover and a square 3 × 3 of the remaining nine works, arranged below it for portrait and beside it for landscape. Large rank numbers stay legible without overpowering the artwork. The 3 × 3 template places #1 in a slightly larger central panel. Template section names belong to the gallery, never to the exported poster; headings and captions in the image are optional user content.

Styles are Dark, Daylight, Dusk, and Reading, with palettes that fit their corresponding app themes. Style choice belongs in the editor, not in the template feed; new compositions default to the palette matching the active app theme. Each style shares the same editing affordances and contrast rules. The selected style remains stable through preview and export. Older saved styles Quiet, Paper, and Editorial remain readable and are normalized to Dark, Reading, and Dusk when edited.

Cover and text modes are available where the layout supports both. Cover mode gives artwork the main visual area, uses full-bleed portrait covers without oversized surrounding mats, and tolerates clashing source palettes. A missing-cover tile uses its media-type icon (or a clear initial when no icon is available), with the same caption placement as a covered tile. Each work has one consistent bottom caption area for its short label and optional media-type label. Users can toggle work names and media-type labels independently. Text mode is a deliberate typographic composition, not empty image frames. Keep the watermark and captions inside safe areas; watermark is subtle readable “Made with Tastellar” near the top, with no invented URL or account identifier. It is enabled by default. One global preference controls the watermark across every template. Each attempt to disable it opens a generously padded dialog explaining that Tastellar is free, ad-free, non-commercial, and open source and asking users to help popularize it. Removal remains available; re-enabling needs no dialog.

Use the same scene/layout output for the gallery preview, editor canvas, and exported image. Fit feed posters and editor canvases inside the available viewport width while preserving their canvas aspect ratio; overlays and hit targets stay aligned at every screen size, including 3 × 3. Editing controls span the available editor width for their choices. Saved Recaps can be removed individually or cleared together; clearing all requires a confirmation.

## Export pipeline

Use a dedicated Canvas 2D renderer consuming a versioned layout scene graph (rectangles, text, images, clipping, opacity), shared by preview and export. Do not screenshot the interactive UI or rely on DOM layout capture. Bundle licensed fonts with known coverage; load font/image assets completely before export. Measure and wrap text using the same layout engine; never silently cut off a long title. Preview overflow warnings and fallback font choices.

Default PNG in sRGB, opaque chosen background, no source EXIF/location metadata. Optional JPEG requires an explicit background. Export user-selected file through a platform adapter; Android uses storage/share intents. No social upload. Bound output to 4096 px per axis initially and render pages sequentially to control memory. At 4096², one RGBA buffer alone is about 64 MiB, so avoid duplicate full-size buffers and release assets between pages. Show progress/cancel and actionable permission/disk errors. A multi-page timeline exports numbered files with clear count.

## Acceptance

Every template is visually checked with unrelated cover palettes, all covers absent, one missing image, custom media names, long titles, non-Latin user text, and sparse dates. Swapping cards changes only the composition. PNG dimensions match the selected preset, text is not clipped, watermark is present, and restoring an archive preserves editable drafts and their asset references.
