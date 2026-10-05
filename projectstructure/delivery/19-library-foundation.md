# 19 — Library foundation

The initial macOS Library milestone added persisted entries, media types, criteria, tags, covers, and a versioned archive with story data. Later revisions added selectable media-type icons, the Animation and Comic defaults, the Ideas/Message criterion, short-label fallback, and localized entry copy. Entries include a “Your thoughts” review and no private-notes field. Overall score determines rating groups but is not a filter predicate. Catalog and file imports are specified in [Library](../specifications/07-library.md); they were outside the initial foundation. Its 2D overview has since been replaced by the Library universe scenes in specification 08. Scene palettes are extracted and cached at runtime from locally loaded covers and are not persisted in entries or archives.

Only score groups 10–7 show the universe scene. Its camera view, title visibility, motion pause, and collapse state are kept in a bounded in-memory cache keyed by Library tab; the 7/10 map saves bounded pan and zoom but has no orbit or motion control. Collapsing the scene releases its renderer, and revisiting a tab restores its scene controls during the current app session. These transient scene settings reset when the app restarts; graphics quality remains workspace-persisted.

## Universe scene verification

The 0.4.0 validation plan runs the production build, unit suite, and Library/Universe browser suite separately. Browser coverage includes the four 10–7 scenes, bounded 2D Deep Field pan/zoom, group navigation, saved view state, theme contrast, fallback rendering, and context loss. Scenes are absent for lower ratings, Unrated, Plan to Watch, and Dropped. Fixed title anchors may overlap in dense scenes; layout tests cover deterministic large-group geometry, not collision avoidance. These are CPU layout tests, not GPU load or frame-rate benchmarks; native-webview performance has not been measured.

## Vocabulary name matching limit

The data model requires trimmed Unicode-normalized, case-folded name equality. The current native storage implementation trims names and applies Rust's Unicode lowercase conversion before uniqueness checks. Rust's standard library does not provide Unicode normalization or full case folding. The local offline dependency cache has an ICU normalizer but no full case-fold API or dedicated normalization/case-fold crate; adding only NFKC plus lowercase would still miss full-fold equivalences such as `ß` and `ss`.

This is a known conformance gap. Do not weaken the data-model requirement to match the current behavior. Before release, add a pinned Unicode normalization and full case-fold implementation and cover composed/decomposed forms, compatibility forms, and multi-character fold mappings in tests.

## Workspace reset regression

Reset reseeds the current vocabulary through the migration helper, which also restores the archived `animated-films-series` type and its criterion links. Delete those `media_type_criterion` links before deleting that archived type; otherwise SQLite rejects the reset with a foreign-key error that the UI reports as a failed local data operation. The storage reset test covers this sequence.
