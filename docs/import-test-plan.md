# Import test coverage plan

This plan describes fictional cases for validating provider imports. It is not a source export or a record of real viewing, reading, play, account, or rating history. The checked-in synthetic fixtures are documented in [tests/fixtures/imports/README.md](../tests/fixtures/imports/README.md); observed export schemas and counts are in [import-fixture-analysis.md](import-fixture-analysis.md).

| Source | Cases to cover |
| --- | --- |
| Letterboxd | Watched and watchlist membership for the same work; half-star ratings; separate diary events and rewatch flags; unrated entries; animated films; cross-provider title matches. |
| IMDb | Film and TV rows; localized and original titles; personal ratings kept separate from aggregate scores; absent rating and date fields; watchlist state where supported by the export. |
| AniList and MyAnimeList | The same anime and manga across sources; source-specific status labels and score scales; anime TV versus film; manga versus adaptation; repeated import by provider ID. AniList access and MyAnimeList export/API support remain subject to the gates in [import-provider-research.md](import-provider-research.md). |
| Steam | Visible owned games with zero or positive playtime; unavailable ownership data; duplicate import. Wishlist and cart import are not supported by the current provider flow. |
| Goodreads | Read, currently-reading, and to-read shelves; 1–5 ratings and unrated zero; work versus edition identifiers; date-added versus date-read; adaptations shared with film providers. |

For every source, test that repeated imports are idempotent, original provider ratings and IDs remain available, ambiguous cross-provider matches require confirmation, and missing or unclear dates stay unset. Keep generated fixture values clearly synthetic and do not treat them as verified provider field semantics.
