# 07 — Library, details, and vocabulary editors

## Navigation, search, filters

Left group column follows [Product contract](01-product-contract.md), with Add work and Search at the top. Each group shows its full count and optionally matching count when filtered. Previous/next controls in main follow the same sequence; disable unavailable directions and label the destination. Empty groups remain navigable.

While searching, results replace the group column. Default search covers all active entries and initially ignores Library filters, visibly labeled “All works”; an optional “Within current filters” switch applies them. Search title/short label by default; review/tag search is opt-in. A short label is a user-supplied card fallback: use it in a constrained media card when the full title overflows and a short label exists. Keep the full title in details and the accessible name. Do not reinterpret it as a subtitle or global replacement title. Debounce approximately 150 ms and cancel stale result requests. Selecting a result changes the active group and opens details. If filters hide it, reveal it with a temporary “Showing selected search result outside filters” exception shared by list and scene; clearing selection/search removes the exception. Never pretend a hidden result matches filters.

Filter button opens contextual panel mode. Filter predicates are defined once in [Contracts](../architecture/04-contracts.md). Overall score is not a filter; score groups remain available through group navigation. Apply the same eligible ID set to list and scene. Show active filter chips, result/full counts, and Clear all. Empty filtered results offer clearing filters, not adding duplicate entries. Selected entries hidden by a filter can remain in details with a “Not in current results” label.

The Library heading toolbar keeps the Import/export action beside the list-view controls; do not duplicate it in the group-column footer. That action opens the import/export panel, which shares the work-details panel's interior padding and alignment. Replacement-data confirmation dialogs use balanced top and side insets so warning text and actions do not sit against the dialog edge.

## Main content

Upper area: group scene, with collapse, motion and quality controls. Until the later 3D-scene milestone, show an accessible 2D collection overview with counts and score distribution in this space; do not render interactive 3D. Lower area: virtualized list in one of three modes:

- Cover grid, consistent aspect-ratio frames, title/year below; no-cover tile uses typography and a neutral palette.
- Compact text grid, clear title and small score/type metadata; when the title does not fit in a card, use the optional short label, otherwise visually clamp the full title. Full title remains available on focus and in details.
- Table, selectable columns: title (always), type, overall score, within-score rank, release year, tags, date added, cover presence. Unplaced rated works show “Unplaced” instead of a fabricated rank. Column changes never remove data. Optional table sort is visibly separate from canonical ranking. Rows have no separate edit button; selecting opens details and double-clicking edits.

Default order is canonical best-first; unscored groups use manual display order. Selection highlights corresponding scene object/list item without stealing scroll unexpectedly. A single click opens details; double click opens the editor. Cover, compact, and table views do not show per-item three-dot edit buttons. Explicit Edit remains available in the details panel. Right-click actions always have visible button/menu equivalents.

Closing the entry editor must not leave a theme-accent divider between the app tab bar and the Library. Verify this boundary in Midnight and Reading themes; ordinary theme-colored separators within Library remain unchanged.

## Entry editor

Required title; optional type, cover, release date with precision, overall rating, criterion scores, tags, multiline **Your thoughts** review, and short label. There is no private-notes field. Initial Add work defaults to Plan to Watch, with immediate access to “Already experienced” and Dropped. Selecting a rating automatically selects experienced and previews the destination group. Save is atomic; Cancel has no partial entry. Newly created optional vocabulary may persist independently only if the user explicitly saved that vocabulary editor.

Type selector can open the type editor. Type editor can open global criterion editor without losing the entry draft. Creating a type selects existing criteria or adds new ones. Type changes show which criterion scores become inactive and where they can be recovered. Overall score never changes automatically when criterion values change.

Cover import offers file picker and drag/drop; clipboard image support is platform-capability dependent with file fallback. Crop affects derived display rendition, preserves original. No automatic remote fetching in the initial product. An invalid image does not damage the saved entry. Optional release year can be entered without month/day.

## Details panel

Show cover or an inviting Add cover action, full title, type or “No type”, known release date/year, disposition, score, placed rank (or “Unplaced”), overall rank, Top percentage and/or clearly labeled percentile, Compare or Place action, tags, criterion scores, rating/experience history, **Your thoughts** review, and meaningful scoped stats. Unplaced works have no ordinal rank or rank-derived percentile. Unrated/planned/dropped have no fake overall rank. Show “Not rated” rather than 0/10. Small-library rank wording follows the data-model rule.

Compare opens Ranking with a relevant same-score group; for an unscored entry invite rating first. For an unplaced rated entry, offer binary placement and manual drag placement; placement is always explicit. Scoped stats such as “#2 among Animation works from the 2010s” use placed works and explicit filters/denominators. Require at least 5 eligible placed works for decorative comparative callouts; ordinary rank remains available at any size once placed. Similar works is deferred until there is a defensible similarity model; do not invent recommendations.

History distinguishes user-supplied experience dates, recorded rating events, and import dates. A supplied old score is historical only if provenance supports it. Imported current ratings must not be shown as original rating dates.

## Vocabulary management

Media types/criteria use stable IDs, editable names and ordering, uniqueness checks, and the conditional deletion rules in the Product contract. Each media type has a selectable icon. Seeded types have distinct, fitting icons; custom types can choose from ten abstract, neutral icons with no fixed subject. The type deletion dialog lists every affected title in a scrollable/paged list with count; do not hide the list behind “and others” only. Criterion impact lists affected types and entries. New usage during confirmation invalidates its impact token.

Tag list starts empty; free creation from entry editor, rename, merge with preview, or delete. Tag merge atomically redirects links and deduplicates them. Deleting a tag can be immediately undoable without a modal since it removes labels, not works. Never normalize imported genre names into tags without a mapping preview.

## Acceptance

A text-only entry is readable in every view. A search result opens the correct group/details even under incompatible filters. Hiding a table column changes no stored entry fields. Media-type deletion clears types, retains entries/history, and asks for confirmation exactly when the type is used. Criterion deletion follows current type usage even if those entries have no criterion scores yet.
