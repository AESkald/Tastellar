# Import, catalog, and library verification

## Recorded validation

Validation results recorded on 2026-10-04. These are historical results, not a claim about later runs.

- `npm run build` passed. Focused Playwright checks passed 6/6 across import-catalog and bulk-library flows, followed by 7/7 import-catalog checks for the review dialog, provider selection, identity conflicts, and cover retry.
- Desktop and 390px browser layouts were visually checked. Import results and actions stayed visible, and the compact bulk-selection panel had no horizontal overflow.
- The full frontend unit run had 98 passing tests and 2 failures in existing `sceneLayout.test.ts` cases for constellation viewport bounds and faint-star alpha.
- The final offline storage run passed 109 tests across storage, import workflow, ranking, and reported-ranking flows; one private-fixture test was intentionally ignored in the normal run. The import-workflow suite passed serially after three shared-temporary-database races in a parallel run. The Tauri application check and private-export parser check also passed.
- The private-export parser check covered 28 rows across the supplied IMDb, Letterboxd, and Goodreads files. IMDb aggregate ratings were not treated as personal ratings.

## Provider checks

Live requests in the configured test environment returned 6 TMDb results for *Arcane* (selected cover 500×750), 8 IGDB results for *Celeste* (528×704), 8 Google Books results for *Mother* (128×213), 5 Steam owned games, and 8 Open Library results for *Mother* (selected JPEG cover 318×475, 25,288 bytes). Two Goodreads ISBN lookups also returned cover references and both downloads succeeded. Open Library may redirect an aliased numeric cover filename; subsequent redirects must remain bound to the same archive and file. No placeholder covers appeared in the two ISBN samples checked.

The Settings credit uses the approved TMDb primary blue SVG from its official attribution page. The attribution notice, logo, and terms link are available without a network request for the logo.

## Verified behavior

- New library works default to “Already experienced.” When all works are experienced and unrated, the initial group is Unrated.
- Import preserves source statuses unless the user overrides them. Clearing a batch override restores each row's source status. An empty active group switches to an imported group or the normal initial group.
- Catalog search uses one selected provider, remembers that selection, and shows up to eight results per page. The import window does not expose a provider-terms button. Batch lookups use supported exact IMDb IDs or ISBNs when available, then title and year. Results require review; partial provider failures leave successful results visible.
- Imports support Letterboxd ZIP, IMDb CSV, Goodreads CSV, MyAnimeList XML/XML.gz, supported CSV/TSV, and one-title-per-line TXT. Steam imports visible owned games and available playtime; wishlist and cart import are not offered. Generic CSV uses recognized headers rather than arbitrary column mapping. Browser mode previews imports; commits require the desktop app.
- A selected provider cover is downloaded during desktop commit. Choosing a local cover clears the remote-cover reference. Failed cover downloads leave the rest of the import intact and can be retried or skipped from the receipt. Undo remains available until later edits make it unsafe.
- Ambiguous shared identities require an explicit merge or separate-work choice. When enrichment finds an existing library work, the preview proposes reusing it while preserving its local rating and status. Bulk media-type, status, cover-removal, and trash actions use atomic batch commands.
- A supplied MAL XML.gz file passed native prepare and a 161-row create commit. The compressed bytes and original filename must be preserved through the upload bridge.
- The historical `020.tastellar.json` archive restored 311 entries and passed an export/reimport round trip. Compatibility handles omitted historical Home settings when reconstructing its old checksum and continues to reject unknown or lost input fields.
- The 30-day support reminder, gzip upload handling, default no-tags selection, sidebar visibility, and Recap title privacy passed focused browser checks. Recap drafts and gallery previews hide titles while explicit saved settings remain intact. Steam profile checks covered numeric IDs and vanity URLs resolved through Steam.

## Security and compatibility notes

Bundled provider configuration uses two fresh OS-random masked binary shares instead of a plaintext JSON include. Three helper tests passed, including loading the bundled configuration; both generated payload/mask pairs reconstructed it. A value-only audit found no complete-config, API-key, or client-secret literal matches in the generated blobs. Native startup reconstructs and parses the configuration, then wipes the temporary JSON buffer. Release builds strip symbols. The usable credentials still exist in the application at runtime, so this obfuscation does not protect a shared key against determined reverse engineering or provide a global quota.

Provider terms, attribution, image retention, and donation-related permission gates are summarized in [provider research](import-provider-research.md).

## MAL with TMDb covers investigation

The supplied 161-row MAL export passed a full native enriched commit with a synthetic valid image for every row and duplicate catalog identities filtered as the frontend does. A permanent 161-row synthetic regression passes. A separate bounded live check searched only the first three supplied MAL rows: three candidates, three cover references, three real TMDb downloads, and three enriched native creates succeeded with zero cover failures (the remaining 158 rows were skipped in that check). A separate twelve-row search-only check succeeded and found eleven first-result covers. The reported user failure was not reproduced; these checks do not establish that every live match in the full list succeeds. Native identity ownership validation remains enforced.

The subsequent full exact-file live pass also succeeded: seed import created 161 entries; 161 paced TMDb lookups completed with zero search failures, 139 candidates and 138 cover references. All 119 distinct cover URLs downloaded successfully, with nineteen duplicate-URL reuses in the diagnostic runner and zero cover failures. Enriched reimport linked all 161 seeded entries and preserved their MAL titles. A fresh enriched create reused the same cached candidate/image data and created 161 entries with 138 cover assets; both test databases were temporary. The diagnostic runner deduplicated requests; this is not a claim that the production downloader currently deduplicates them. No failure was reproduced in this full native run.

Frontend improvements preserve MAL source titles during automatic TMDb batch selection and show work/selected-cover counts with a sequential-download wait explanation during commit. Manual catalog selections retain explicit metadata behavior. All eleven focused import/catalog browser tests and the production build passed; desktop and 390px wait-notice screenshots were reviewed. A duplicate-result regression preserves both covers and independent source ratings while filtering repeated catalog IDs.

## Confirmed batch-tag import defect

The user isolated the failure to creating an `anime` batch tag. The exact supplied MAL file reproduced it: a new tag caused a native Internal error and an atomic rollback of all 161 entries, while reusing an existing tag succeeded. Import tag INSERT statements omitted the required `tag.normalized_name` column. Both batch-tag and source-tag creation now populate that column using the regular canonical name normalizer and resolve existing names by the same normalized value. After the fix, new-tag and existing-tag/case-and-whitespace scenarios each committed and tagged all 161 entries with one distinct tag. No migration was needed.

Frontend payloads now include batch tag IDs/names only when batch-tag mode is selected; returning to No imported tags omits previously staged choices. Structured native error messages are retained instead of replaced by the generic import failure message. Checks passed: serialized import-workflow suite 21 passed/one expected ignored, structured-error unit tests 3/3, focused tag/popup browser tests 3/3, production build, rustfmt check, and diff whitespace check. The earlier TMDb-cover investigation did not reproduce this failure because it did not create the failing new tag.

## Scene-test failures resolved

The two historical scene-layout failures were stale test assertions, not demonstrated rendering defects. Tests required old constellation sprite/connector style constants and an exact faint-galaxy opacity of 0.4; those values are not requirements of the current scenes specification. Coverage now checks valid visible sprites/connectors, rank-dependent opacity, filter stability, deterministic responsive placement and work-object fit in wide/portrait viewports. No tests were deleted and production rendering was unchanged. Latest scene tests pass 12/12; the complete frontend unit suite passes 129/129 across eighteen files. Diff whitespace checks pass.
