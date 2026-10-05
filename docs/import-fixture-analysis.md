# Analysis of supplied import fixtures

**Observed 2026-10-03.** The supplied files included an IMDb CSV, a Goodreads library CSV, and a Letterboxd ZIP. No AniList, MyAnimeList, or Steam export was included, so this analysis makes no claims about those formats.

## Inventory and safe parsing

| File | Rows | Contents and identity fields |
| --- | ---: | --- |
| IMDb CSV | 10 | IMDb title rows. `Const` is the IMDb title ID; `URL` is present. The CSV has 18 columns, including localized and original titles, type, aggregate and personal rating columns, year, release date, genres, runtime, and votes. |
| Goodreads library CSV | 8 | Goodreads book rows. `Book Id` is populated and unique in this file. ISBN and ISBN13 are available on six rows. The 23 columns include author, rating, publication years, reading dates, shelves, notes/reviews, and ownership counts. |
| Letterboxd ZIP | varies by CSV | Native Letterboxd archive. Ten unique film works appear across activity/list CSVs: 2 watched, 1 rating, 2 diary events, and 8 watchlist memberships. These are overlapping relations, not 13 unique works. |

Parse CSV as UTF-8 with BOM tolerance, quoted fields, and embedded newlines; preserve identifiers and date strings as strings before field-specific validation. Never infer a status from file presence alone when the export does not express one.

**IMDb header:** `Position, Const, Created, Modified, Description, Title, Original Title, URL, Title Type, IMDb Rating, Runtime (mins), Year, Genres, Num Votes, Release Date, Directors, Your Rating, Date Rated`.

**Goodreads header:** `Book Id, Title, Author, Author l-f, Additional Authors, ISBN, ISBN13, My Rating, Publisher, Binding, Number of Pages, Year Published, Original Publication Year, Date Read, Date Added, Bookshelves, Bookshelves with positions, Exclusive Shelf, My Review, Spoiler, Private Notes, Read Count, Owned Copies`.

Private/profile columns are not media metadata. Goodreads `My Review`, `Spoiler`, and `Private Notes`, IMDb `Description`, and Letterboxd profile values were not inspected. Exclude these fields by default from import parsing, logs, previews, and shared catalog data.

## Field mapping from the observed files

The current app has a single selected media bucket, optional year/date, disposition, and an optional 1–10 local rating; it has no native provider identity, source-rating record, edition/format distinction, or activity-event model. The table below distinguishes safe direct source facts from fields that require user choice or separate persistence.

| Source fields | Observed meaning | Import treatment |
| --- | --- | --- |
| IMDb `Const`, `URL` | Provider title identifier and URL | Store `Const` as namespaced IMDb identity. URL is provenance, not a substitute for a stable ID. No cross-provider ID is in this file. |
| IMDb `Title`, `Original Title` | Localized display title and original title where distinct | Keep one selected display title and the other as a source alias/original title. Do not discard script/language distinctions. |
| IMDb `Title Type`, `Genres` | `Movie`/`TV Series` work format and separate genre traits | Suggest Film for Movie and TV Series for TV Series, with user review. Keep Animation as a trait/format attribute rather than overwriting the selected bucket; the app's six buckets overlap (for example, animated TV is both a series and animation). |
| IMDb `Year`, `Release Date` | Separate source year and more precise date | Preserve separately. If selected, map `Year` to a year-precision release date; never derive a year from a later release date when the two differ. |
| IMDb `IMDb Rating`, `Your Rating`, `Date Rated` | Aggregate rating vs. personal score/date | In this fixture, every `Your Rating` and `Date Rated` is blank. `IMDb Rating` is the community aggregate and must not be imported as the user's score. No personal watch/completion state is established by these rows. |
| Goodreads `Book Id`, `ISBN`, `ISBN13` | Provider row identity plus optional book/edition identifiers | Keep namespaced Goodreads ID and valid ISBNs as separate identity evidence. Do not collapse editions solely by title or by Book Id. Preserve exact source IDs even when ISBNs are missing. |
| Goodreads `Title`, `Author`, `Additional Authors` | Work/edition description and creator names | Map title and selected author metadata only after preview; keep original source values for later re-match. Do not import review/private-note fields by default. |
| Goodreads `My Rating` | Personal 0–5 field in the observed export | Preserve raw value and source scale. Here 0 is paired with a `to-read` row and means unrated, not zero stars. An explicitly opted-in 1–5-to-1–10 mapping can multiply positive values by 2; never convert 0 to the app's minimum rating. |
| Goodreads `Exclusive Shelf`, `Bookshelves`, `Read Count` | Read/to-read status, user shelves, and repeat count | `read` may propose completed and `to-read` may propose planned, subject to user review. Keep shelves separate from Tastellar tags until the user chooses a mapping. Preserve `Read Count` as source progress/history; it is not itself a number of diary events. |
| Goodreads `Date Read`, `Date Added` | Reading date vs. library-add date | `Date Read` is blank in all 8 rows. Preserve `Date Added` as an add date, not a read/completion date or release date. |
| Goodreads `Year Published`, `Original Publication Year` | Edition/printing year and original-publication year | Keep them distinct. The Blade Itself has 2007 vs. 2006; neither is necessarily erroneous. Do not treat a one-year mismatch as identity conflict. |
| Letterboxd `Letterboxd URI`, `Name`, `Year` | Provider-scoped film identity and matching display facts | Use exact URI for deduplication/re-import within Letterboxd. URI is not an IMDb/TMDb ID. Name+year can suggest a cross-provider match but must not auto-merge. |
| Letterboxd `watched.csv`, `watchlist.csv` | Watched relation and watchlist membership | Keep as separate states/relations. A film may appear in both; watchlist must not erase watched state. |
| Letterboxd `ratings.csv` / `diary.csv` `Rating` | Personal rating / diary rating | Preserve raw 0.5-star increments and original 5-star scale. 4.5/5 may be proposed as 9/10 only after explicit user choice. Do not conflate an un-rated diary event with a rating. |
| Letterboxd `diary.csv` `Watched Date`, `Rewatch`, `Tags` | Diary event date, repeat flag, and user tags | Keep each diary row as a distinct event, including same-day repeats. `Rewatch=Yes` is explicit; blank is not a `No` assertion unless provider docs establish blank semantics. Map tags only after user selection. |
| Letterboxd `Date` | Opaque date field repeated in activity/list CSVs | Preserve raw value and source field name. Its meaning is unresolved; do not label it as watched, added, or rated date. |

Observed Letterboxd CSV schemas:

| CSV | Rows | Header |
| --- | ---: | --- |
| `watched.csv` | 2 | `Date, Name, Year, Letterboxd URI` |
| `ratings.csv` | 1 | `Date, Name, Year, Letterboxd URI, Rating` |
| `diary.csv` | 2 | `Date, Name, Year, Letterboxd URI, Rating, Rewatch, Tags, Watched Date` |
| `watchlist.csv` | 8 | `Date, Name, Year, Letterboxd URI` |
| `reviews.csv` | 0 | `Date, Name, Year, Letterboxd URI, Rating, Rewatch, Review, Tags, Watched Date` |
| `comments.csv` | 0 | `Date, Content, Comment` |

The archive also contains profile, likes, deleted, and orphaned CSVs. The profile row values were not inspected; ignore profile data for a media-list importer. Deleted/orphaned diary and review files were empty in this archive. File sets can differ by export/version, so discover paths and headers and report unsupported files instead of assuming this exact bundle.

## Observed activity, ratings, and date edge cases

| Source | Observed item/list counts | Personal score evidence | Date/status caveat |
| --- | --- | --- | --- |
| IMDb | 10 rows: 8 Movie, 2 TV Series | All 10 `Your Rating` and `Date Rated` cells are blank. Aggregate `IMDb Rating` is populated but is not a user rating. | No explicit watched/planned/completed state in the observed columns. |
| Goodreads | 8 books: 7 `read`, 1 `to-read` | Three 4/5; four 5/5; one `0` on the `to-read` row (unrated). Positive values map to 8/10 and 10/10 only if opted in. | All 8 `Date Read` cells are blank; all `Date Added` values are 2026/10/03. The to-read book has a 2027 publication year, which is future relative to this analysis date and should remain a valid planned item. |
| Letterboxd | 10 unique works: 2 watched, 1 ratings row, 2 diary events, 8 watchlist memberships | One rating/diary value: The Godfather 4.5/5 (9/10 proposal). Harakiri's diary event is unrated and marked `Rewatch=Yes`. | Both diary `Date` values and all other populated `Date` values are 2026-10-04; both diary `Watched Date` values are 2026-10-03. The UI had shown diary activities on Oct 3. `Date` semantics remain unverified; this one-day discrepancy must be retained as an import edge case. |

Do not import IMDb's aggregate values as personal ratings. Do not infer completion solely from a rating. For any accepted rating copied into Tastellar's `overallRating`, show the raw source value/scale and conversion; keep provider-native ratings in provenance so re-import does not compound conversions.

## Matching collisions in these exact files

Six IMDb/Letterboxd pairs are strong same-film candidates by original/English title and year. This is useful for duplicate-review fixtures, but no shared ID proves a pair: Letterboxd supplies only a Letterboxd URI, while IMDb has its `Const`. All six therefore remain suggestions requiring user confirmation.

| IMDb row | Letterboxd row | Match evidence and caveat |
| --- | --- | --- |
| The Godfather (1972) | The Godfather (1972) | Exact title/year candidate; IMDb `Const` and Letterboxd URI are different namespaces. |
| The Godfather Part II (1974) | The Godfather Part II (1974) | Exact title/year candidate; keep distinct from the 1972 film. |
| The Lord of the Rings: The Return of the King (2003) | The Lord of the Rings: The Return of the King (2003) | Exact original title/year candidate. IMDb release date is 2004-01-22; its `Year=2003` matches Letterboxd year. |
| The Shawshank Redemption (1994) | The Shawshank Redemption (1994) | Exact original title/year candidate. |
| Idi i smotri (1985), localized IMDb title `Иди и смотри` | Come and See (1985) | Transliteration/localized title alias plus year; normalized title alone will not match. IMDb `Release Date=1986-01` differs from source `Year=1985`. |
| Gisaengchung (2019), localized IMDb title `Паразиты` | Parasite (2019) | Original-language and localized aliases differ from Letterboxd English title; title alias/catalog crosswalk is needed. |

The inputs contain 28 source-work rows in total (IMDb 10 + Goodreads 8 + Letterboxd 10). If all six candidates are confirmed as the same works, that yields 22 canonical works. This is a count for a reviewed match scenario, not proof of automatic cross-provider identity.

One apparent cross-source title/franchise overlap is **Mushoku Tensei**: Goodreads has a Japanese light-novel/book row, while IMDb has the animated TV series. These are an adaptation/franchise relationship, not the same media record. Preserve medium and source identity separately and do not merge them. The six seeded Letterboxd/IMDb matches do not include a Goodreads title collision.

Other within-source ambiguity to retain:

- Goodreads **The Blade Itself** has `Year Published=2007` and `Original Publication Year=2006`; store both facts with their distinct field meanings.
- Goodreads source ID (`Book Id`) is unique for each of these eight rows; it does not by itself prove two rows are the same book work or edition. ISBNs add edition evidence but are absent on two rows.
- IMDb `Title` is often Russian while `Original Title` is English/transliterated; retaining source aliases improves matching and display without losing user-selected title.
- An animated work can also be a film or TV series. Keep provider-native format and the app's selected bucket/facets separate; do not make “Animation” override film/series classification.

## Goodreads ISBN cell handling

In this CSV, populated ISBN/ISBN13 values are spreadsheet-safe text such as `="0575077905"` and `="9780575077904"`; two rows use `=""` for blank. This wrapper is data, not executable content. Read with a CSV parser and handle it as a string only:

1. If the raw cell is exactly `=""`, classify as missing.
2. Otherwise accept only an exact string match to `^="([0-9Xx]+)"$`, extract the captured digits/`X`, then apply field-specific length/checksum validation.
3. Keep the original cell in transient parse provenance if needed for diagnostics; never evaluate it as a spreadsheet formula or send it to a formula engine.
4. For a malformed formula-like cell, leave the identifier empty and surface a row warning. Do not strip arbitrary prefixes/suffixes or execute content.

The observed file has six rows with both ISBN and ISBN13 values that pass basic digit extraction, and two with both blank. Identity still needs care: ISBN identifies an edition/format, not automatically the same work entity as IMDb/Letterboxd.

## Artwork and catalog enrichment

None of the observed CSV headers or Letterboxd media CSVs has a cover/poster/image URL or embedded artwork. IMDb's `Const`/title URL and Letterboxd's URI are identity/provenance references, not image-use licenses. If the add-media search flow offers covers, resolve the provider's terms, attribution, caching, and redistribution rules separately from title lookup; show source/attribution and do not package these exports' external artwork into fixtures. A missing cover must not block list import.

## Test cases derived from the actual files

Use this attached data as a small, high-value parser/matcher fixture:

1. Round-trip all 18 IMDb and Goodreads rows preserving blank personal ratings, IDs, and source-date fields. Assert aggregate IMDb rating never populates `overallRating`.
2. Import the Letterboxd ZIP idempotently: 10 works, 2 watched relations, 8 watchlist relations, 1 rating record, and 2 distinct diary events. Re-import must not duplicate works/events. Ensure The Godfather can remain watched, rated, and on a watchlist if a later export says so.
3. Preview the six candidate IMDb/Letterboxd duplicates and require explicit link/create-separately/skip decisions; test cross-script/localized titles and the 1985-vs-1986 release-year discrepancy.
4. Preserve Goodreads `read` vs `to-read`; map positive 4/5 and 5/5 only when accepted; ensure the to-read `0` stays unrated and the future 2027 date/year is not rejected as malformed.
5. Verify Goodreads `Date Read` remains null and `Date Added` does not become a reading date. Keep `Year Published` separate from `Original Publication Year`.
6. Treat Goodreads wrapped ISBN cells strictly as text; tests should cover valid wrappers, `=""`, malformed wrappers, 10- and 13-character identifiers, and no formula evaluation.
7. Verify Mushoku Tensei book and TV adaptation remain separate, even though normalized titles/franchise tokens overlap.
8. Preserve Letterboxd's opaque `Date=2026-10-04` and distinct `Watched Date=2026-10-03` without silently assigning the former watch/rating meaning.
9. Verify absent cover references leave cover unset and do not make otherwise valid rows unimportable.

## Additional hypothetical adversarial scenarios (not present in these exports)

The following cases are design/test requirements, not observed rows or synthetic exports. They ensure the importer remains safe when later files contain conflicts or when the user's library changes during an import session.

| Hypothetical input or user action | Required behavior |
| --- | --- |
| An IMDb row for The Godfather (1972) has a personal score of 7/10; a matched Letterboxd row has 4.5/5 (= 9/10); the existing Tastellar score is 8/10. | Show all three values with their sources/scales. Never average or choose a provider by import order. Preserve both source scores. Keep the existing local score unless the user explicitly selects a replacement; for a new work leave the local score unset until the user chooses. |
| The same confirmed work has IMDb 7/10 and Letterboxd 3.5/5 (= 7/10). | Show that normalized values agree, but retain both raw ratings and provenance. Only create/update Tastellar's score after explicit acceptance of the displayed proposal; agreement is not permission to overwrite an existing score. |
| Two diary events for the same Letterboxd URI have different watched dates and different ratings. | Preserve two distinct activity events. Do not collapse events into one rating or allow the newer event to silently erase the older event's score/date. Maintain a separate current/local rating only through an explicit user choice. |
| Two sources or repeated imports have missing dates, invalid dates, date-only values, or conflicting time zones. | Keep unknown dates unknown and retain raw source strings/precision. Do not infer which value is newest, sort null as zero, or invent a date/time zone. Ask for a field choice when a date would replace an existing value. |
| The user changes a local rating after import preview but before commit. | Detect that the entry revision/value changed since preview. Mark the row stale and require a refreshed preview/decision; never commit over the intervening edit. |
| A score of `0` appears in an unfamiliar provider or status. | Do not assume zero always means unrated or always means the minimum score. Apply only a provider- and field-specific documented sentinel rule; if unknown, preserve raw value and ask/skip that score. The Goodreads fixture's `0` is unrated because that observed record is `to-read`, not a universal rule. |
| A provider has configurable, nonstandard, text, or unknown rating scales (for example a 100-point, letter-grade, or custom scale). | Preserve its native representation and scale metadata. Do not guess a conversion to 1–10. Require an explicit mapping or leave Tastellar's local score unset. |
| Two records share a title but differ by medium, adaptation, season, edition, volume, issue, or game edition. | Show them as separate candidates and require confirmation before linking. Same title/franchise alone is never a merge key. Preserve provider-native entity kind and selected app category separately. |
| Several providers identify one selected work, or a single provider supplies work and edition IDs for it. | Store multiple provider-scoped identities on the confirmed local work, with entity kind/relationship kept explicit. Enforce uniqueness for each provider ID so one ID cannot silently attach to multiple works. Do not assume identifiers from different namespaces are interchangeable. |
| A previously imported item or list membership is missing from a later export. | Do not delete the Tastellar work, local score, tags, or history. Treat removal as a source-state change only if the provider/export semantics document that it is authoritative and the user opts in; otherwise report it as absent from this snapshot. |
| Import maps a provider shelf to an existing Tastellar tag, creates a selected new tag, or applies a row-specific override; the same source is then re-imported. | Preview source-to-tag mappings and row overrides before commit. Keep source shelves separate absent that choice. Re-import must reuse the same mapping and avoid duplicate tags, tag assignments, works, and events; changed mapping requires a fresh preview. |

Use these collisions as synthetic acceptance cases. Keep them separate from the supplied files and label all generated rows as synthetic.

For synthetic import coverage scenarios, see [`import-test-plan.md`](import-test-plan.md). Provider-term evidence is in [`import-provider-research.md`](import-provider-research.md).
