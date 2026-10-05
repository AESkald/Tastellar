# Import test fixtures (synthetic)

All media names, localized aliases, source IDs, personal ratings, dates, shelves, tags, and statuses here are generated solely for parser/UI tests. They are not copied from a user export and do not describe a real account. No profile, username, email, credentials, reviews, private notes, tokens, or cover art are included. The CSV/ZIP headers and file layout mimic observed provider export shapes; the IMDb-like `Const`, Goodreads-like `Book Id`, Letterboxd URIs, and catalog crosswalk IDs are intentionally fictional. The crosswalk JSON is a local mock only; it must never be sent to a live catalog API.

- `imdb-source-only-synthetic.csv`: 10 rows; six same-film candidates by title/year against Letterboxd, a localized title, two TV rows, one synthetic user rating, and non-empty aggregate scores to verify they do not become personal ratings.
- `letterboxd-source-only-synthetic.zip`: 10 unique films; 2 watched rows, 1 current-rating row, 2 distinct diary events for the same film (different dates/scores), and 8 watchlist rows. No profile CSV. One film is both watched, diary-rated, and watchlisted.
- `goodreads-source-only-synthetic.csv`: 8 rows (7 read, 1 to-read); positive 1–5 scale examples, unrated zero, wrapped ISBN/ISBN13 text, blanks, and one malformed wrapper. Private-text columns exist only as empty headers/cells to exercise safe exclusion.
- `catalog-crosswalk-synthetic.json`: fictional provider result mapping an IMDb-shaped `Const` to a TMDb-shaped external ID for local mocks only. It contains no image URL or artwork.

The 28 source work rows contain six cross-source candidates; after explicit confirmation of all six, the expected canonical-work count is 22. These are candidate title/year matches, not automatic identities. Re-import should be idempotent, preserve source-native ratings/events, never import IMDb aggregate scores, and require explicit decisions on local rating conflicts and tags.
