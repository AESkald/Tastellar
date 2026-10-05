import { expect, test, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";

async function installNativeImportMock(page: Page, options: { seedEntry?: any; failCover?: boolean; duplicateRows?: boolean; malSeasonRows?: boolean; commitDelay?: number; commitError?: { code: string; message: string } } = {}) {
  await page.addInitScript(({ seedEntry, failCover, duplicateRows, malSeasonRows, commitDelay, commitError }) => {
    const g = window as any;
    const mediaTypes = [
      ["literature", "Literature", "book-open"],
      ["anime", "Animation", "clapperboard"],
      ["games", "Games", "gamepad-2"],
      ["films", "Films", "film"],
      ["tv-series", "TV series", "tv"],
      ["comic", "Comic", "messages-square"],
    ].map(([id, name, iconKey], sortOrder) => ({
      id, name, iconKey, sortOrder, criterionIds: [], archivedAt: null,
      version: 1, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z",
    }));
    let library: any = { revision: seedEntry ? 1 : 0, entries: seedEntry ? [structuredClone(seedEntry)] : [], mediaTypes, criteria: [], tags: [] };
    let importRows: any[] = [];
    const preferences = {
      theme: "dark", textScale: 1, reducedMotion: "off", graphics: "low",
      scenesEnabled: false, rememberSidebarsPerTab: true, restoreTabs: false,
      startupSection: "library", previousTabShortcut: "Alt+ArrowLeft",
      nextTabShortcut: "Alt+ArrowRight", radarMode: "explicit", visibleCriteria: [],
      analyticsBoundaryReviews: [], recapDrafts: JSON.stringify({ version: 1, drafts: [] }), recapWatermark: false,
    };
    const home = {
      version: 0,
      profile: { nickname: "", statedTastes: "", avatarAssetId: null },
      guidelines: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), ""])),
      tasteInputs: {}, preferences,
      workspace: { tabs: [], activeTabId: null, railCollapsed: true, detailsOpen: false, detailsWidth: 320, folderOpen: true },
    };
    const capabilities = [{
      provider: "tmdb", label: "TMDb", enabled: true, configured: true, reason: null,
      mediaTypeIds: ["films", "tv-series", "anime"],
      termsUrl: "https://www.themoviedb.org/api-terms-of-use",
      attributionText: "This product uses the TMDB API but is not endorsed or certified by TMDB.",
    }, {
      provider: "openLibrary", label: "Open Library", enabled: true, configured: true, reason: null,
      mediaTypeIds: ["literature", "comic"], termsUrl: "https://openlibrary.org/developers/api", attributionText: "Open Library",
    }, {
      provider: "steam", label: "Steam", enabled: true, configured: true, reason: null,
      mediaTypeIds: ["games"], termsUrl: "https://steamcommunity.com/dev/apiterms", attributionText: "Steam",
    }];
    const calls: any[] = [];
    g.__testCalls = calls;
    g.isTauri = true;
    g.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (command: string, args: any = {}) => {
        const call: any = { command, args, completed: false };
        calls.push(call);
        let result: any;
        if (command === "load_home") result = structuredClone(home);
        else if (command === "load_ranking") result = {
          revision: library.revision, library: structuredClone(library), unscoredIds: [],
          tiers: Array.from({ length: 10 }, (_, index) => ({ score: 10 - index, placedIds: [], unplacedIds: [], inputSequence: 0, fittedSequence: 0, pendingReconcile: false })),
          activeSession: null,
        };
        else if (command === "load_avatar") result = null;
        else if (command === "catalog_capabilities") result = capabilities;
        else if (command === "prepare_library_import") {
          const importProvider = args.input.uploads?.[0]?.provider ?? "imdb";
          const primaryRow = {
            rowId: importProvider === "letterboxd" ? "letterboxd:watchlist:synthetic" : "imdb:0:2", provider: importProvider,
            providerMediaType: importProvider === "letterboxd" ? "Film" : "Movie",
            externalId: importProvider === "imdb" ? "tt99000001" : null,
            sourceIdentities: importProvider === "imdb" ? [{ provider: "imdb", entityKind: "title", externalId: "tt99000001", sourceUrl: "https://www.imdb.com/title/tt99000001/" }] : [],
            sourceUrl: importProvider === "imdb" ? "https://www.imdb.com/title/tt99000001/" : "https://letterboxd.com/film/glass-harbour/",
            title: "Glass Harbour", originalTitle: "The Glass Harbour", creators: ["Synthetic Example"], year: 2019,
            releaseDate: { year: 2019, month: null, day: null, precision: "year" },
            sourceStatus: importProvider === "letterboxd" ? "watchlist" : "watched",
            sourceRating: importProvider === "letterboxd" ? { value: 4, scale: "0.5-5" } : { value: 7, scale: "1-10" },
            sourceDates: { "date rated": "2026-10-02" },
            sourceActivities: [{ fingerprint: "synthetic-activity", kind: "rating", dateFields: { "date rated": "2026-10-02" }, rating: { value: importProvider === "letterboxd" ? 4 : 7, scale: importProvider === "letterboxd" ? "0.5-5" : "1-10" }, rewatch: null, tags: [], hasReview: false }],
            tags: [], progress: null, suggestedMediaTypeId: "films", exactEntryId: null, candidates: [], warnings: [],
          };
          const malRows = [
            { ...primaryRow, rowId: "myAnimeList:0:1", provider: "myAnimeList", providerMediaType: "anime", externalId: "1001", sourceIdentities: [{ provider: "myAnimeList", entityKind: "anime", externalId: "1001", sourceUrl: "https://myanimelist.net/anime/1001/" }], sourceUrl: "https://myanimelist.net/anime/1001/", title: "Season One", originalTitle: null, year: 2020, releaseDate: { year: 2020, month: null, day: null, precision: "year" }, sourceStatus: "completed", sourceRating: { value: 9, scale: "0-10" }, sourceActivities: [{ fingerprint: "mal-season-one", kind: "rating", dateFields: {}, rating: { value: 9, scale: "0-10" }, rewatch: null, tags: [], hasReview: false }], suggestedMediaTypeId: "anime" },
            { ...primaryRow, rowId: "myAnimeList:0:2", provider: "myAnimeList", providerMediaType: "anime", externalId: "1002", sourceIdentities: [{ provider: "myAnimeList", entityKind: "anime", externalId: "1002", sourceUrl: "https://myanimelist.net/anime/1002/" }], sourceUrl: "https://myanimelist.net/anime/1002/", title: "Season Two", originalTitle: null, year: 2021, releaseDate: { year: 2021, month: null, day: null, precision: "year" }, sourceStatus: "completed", sourceRating: { value: 8, scale: "0-10" }, sourceActivities: [{ fingerprint: "mal-season-two", kind: "rating", dateFields: {}, rating: { value: 8, scale: "0-10" }, rewatch: null, tags: [], hasReview: false }], suggestedMediaTypeId: "anime" },
          ];
          const rows = malSeasonRows ? malRows : duplicateRows ? [primaryRow, {
            ...primaryRow,
            rowId: "letterboxd:watched:synthetic",
            provider: "letterboxd",
            providerMediaType: "Film",
            externalId: null,
            sourceIdentities: [],
            sourceUrl: "https://letterboxd.com/film/glass-harbour/",
            sourceStatus: "watched",
            sourceRating: null,
            sourceActivities: [],
          }] : [primaryRow];
          importRows = structuredClone(rows);
          result = {
            schemaVersion: 1,
            sessionId: "synthetic-import-session",
            expectedRevision: library.revision,
            sources: [...new Set(rows.map((row: any) => row.provider))].map((provider) => ({ provider, sourceName: `${provider}-source-only-synthetic`, rowCount: rows.filter((row: any) => row.provider === provider).length, warnings: [] })),
            rows,
            warnings: [],
          };
        } else if (command === "search_catalog") {
          const query = args.input.query;
          if (query === "Slow Query") await new Promise((resolve) => setTimeout(resolve, 1100));
          else await new Promise((resolve) => setTimeout(resolve, 60));
          const provider = args.input.providers[0];
          const resultFor = (mediaType: string, title: string) => ({
              provider, id: query === "Slow Query" ? "slow" : "42",
              mediaType, title,
              originalTitle: null, creators: ["Catalog creator"], year: 2019,
              suggestedMediaTypeId: "films",
              identities: [
                { provider: "tmdb", entityKind: "movie", externalId: "42", sourceUrl: "https://www.themoviedb.org/movie/42" },
                { provider: "imdb", entityKind: "title", externalId: "tt99000001", sourceUrl: "https://www.imdb.com/title/tt99000001/" },
              ],
              coverUrl: provider === "tmdb" ? "https://image.tmdb.org/t/p/w500/example.jpg" : null, coverMode: provider === "tmdb" ? "persistReference" : "none",
              coverProvider: provider === "tmdb" ? "tmdb" : null,
              remoteCover: provider === "tmdb" ? { provider: "tmdb", url: "https://image.tmdb.org/t/p/w500/example.jpg", sourceUrl: "https://www.themoviedb.org/movie/42", attribution: "TMDb" } : null,
              attribution: provider === "tmdb" ? "TMDb" : "Open Library", sourceUrl: "https://www.themoviedb.org/movie/42",
            });
          result = {
            results: query === "Collision Query"
              ? [resultFor("movie", "Same ID Movie"), resultFor("tv", "Same ID TV")]
              : [resultFor("movie", query === "Slow Query" ? "Stale title" : "Fresh catalog title")],
            nextPage: null,
            warnings: query === "Fast Query" ? ["One provider request failed"] : [],
          };
        } else if (command === "commit_library_import") {
          const input = args.input;
          if (commitError) throw structuredClone(commitError);
          if (malSeasonRows) {
            if (commitDelay) await new Promise((resolve) => setTimeout(resolve, commitDelay));
            const catalogIdentityKeys = new Set<string>();
            for (const decision of input.decisions) for (const enrichment of decision.enrichments ?? []) {
              for (const identity of enrichment.externalIdentities ?? []) {
                const key = `${identity.provider}\0${identity.entityKind}\0${identity.externalId}`.toLowerCase();
                if (catalogIdentityKeys.has(key)) throw new Error("Duplicate catalog identity would block this import.");
                catalogIdentityKeys.add(key);
              }
            }
            const entries = input.decisions.filter((decision: any) => decision.action !== "skip").map((decision: any, index: number) => {
              const enrichment = decision.enrichments?.[0];
              const accepted = decision.ratingSelections?.find((selection: any) => selection.acceptNative);
              const source = importRows.find((row) => row.rowId === accepted?.sourceRowId);
              return {
                id: `synthetic-mal-entry-${index + 1}`, importOrder: index + 1, version: 1,
                title: enrichment?.title ?? decision.title, disposition: decision.disposition, mediaTypeId: decision.mediaTypeId,
                overallRating: source?.sourceRating?.value ?? null,
                coverAssetId: enrichment?.remoteCover ? `downloaded-cover-${index + 1}` : null,
                releaseDate: enrichment?.releaseDate ?? null,
                reviewText: "", externalIdentities: [...(importRows.find((row) => decision.rowIds.includes(row.rowId))?.sourceIdentities ?? []), ...(enrichment?.externalIdentities ?? [])],
                remoteCover: null, shortLabel: null, criterionRatings: {}, tagIds: [], createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z",
              };
            });
            library = { ...library, revision: library.revision + 1, entries: [...library.entries, ...entries] };
            result = { library: structuredClone(library), batchId: "synthetic-mal-batch", created: entries.length, linked: 0, skipped: 0, coverFailures: [] };
          } else {
          const decision = input.decisions[0];
          const enrichment = decision.enrichments?.[0];
          const rowIdentity = { provider: "imdb", entityKind: "title", externalId: "tt99000001", sourceUrl: "https://www.imdb.com/title/tt99000001/" };
          const existingTarget = decision.targetEntryId ? library.entries.find((entry: any) => entry.id === decision.targetEntryId) : null;
          if (decision.action === "link" && existingTarget) {
            library = {
              ...library,
              revision: library.revision + 1,
              entries: library.entries.map((entry: any) => entry.id === existingTarget.id ? {
                ...entry,
                ...(decision.overwriteExistingMetadata && enrichment ? { title: enrichment.title, releaseDate: enrichment.releaseDate } : {}),
                ...(decision.overwriteExistingDisposition ? { disposition: decision.disposition } : {}),
              } : entry),
            };
            result = { library: structuredClone(library), batchId: "synthetic-batch-1", created: 0, linked: 1, skipped: 0, coverFailures: [] };
          } else {
            library = {
              ...library,
              revision: library.revision + 1,
              entries: [...library.entries, {
              id: "synthetic-imported-entry", version: 1,
              title: enrichment?.title ?? decision.title ?? "Glass Harbour",
              disposition: decision.disposition ?? "experienced", mediaTypeId: decision.mediaTypeId ?? "films",
              overallRating: 7, coverAssetId: enrichment?.remoteCover && !failCover ? "downloaded-cover-asset" : null,
              releaseDate: enrichment?.releaseDate ?? { year: 2019, month: null, day: null, precision: "year" },
              reviewText: "", externalIdentities: [rowIdentity, ...(enrichment?.externalIdentities ?? [])],
              remoteCover: null, shortLabel: null, criterionRatings: {}, tagIds: [],
              createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z",
              }],
            };
            const failure = failCover && enrichment?.remoteCover ? [{ sourceRowId: enrichment.sourceRowId, title: enrichment.title, message: "Synthetic cover download failed.", provider: enrichment.remoteCover.provider, url: enrichment.remoteCover.url, entryId: "synthetic-imported-entry" }] : [];
            result = { library: structuredClone(library), batchId: "synthetic-batch-1", created: 1, linked: 0, skipped: 0, coverFailures: failure };
          }
          }
        } else if (command === "retry_import_cover") {
          library = { ...library, revision: library.revision + 1, entries: library.entries.map((entry: any) => entry.id === args.entryId ? { ...entry, coverAssetId: "retried-cover-asset", version: entry.version + 1 } : entry) };
          result = structuredClone(library);
        } else if (command === "cancel_library_import") result = null;
        else if (command === "save_entry") {
          const entry = args.entry;
          const now = "2026-10-04T00:00:00Z";
          library = {
            ...library,
            revision: library.revision + 1,
            entries: [...library.entries, { ...entry, version: 1, createdAt: now, updatedAt: now }],
          };
          result = structuredClone(library);
        } else if (command === "save_entry_cover") {
          library = {
            ...library,
            revision: library.revision + 1,
            entries: library.entries.map((entry: any) => entry.id === args.entryId ? { ...entry, coverAssetId: "manual-cover-asset" } : entry),
          };
          result = structuredClone(library);
        }
        else if (command === "save_workspace") result = structuredClone(home);
        else throw new Error(`Unexpected test bridge command: ${command}`);
        call.result = structuredClone(result);
        call.completed = true;
        return result;
      },
    };
  }, options);
}

async function mockCatalogCover(page: Page) {
  await page.route("https://image.tmdb.org/t/p/w500/example.jpg", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="144"><rect width="96" height="144" fill="#765bd8"/><path d="M0 100 48 48 96 100v44H0z" fill="#b9a6ff"/></svg>',
  }));
}

test("monthly support reminder is dismissible and support/help layouts stay inset", async ({ page }) => {
  await installNativeImportMock(page);
  await page.goto("/");
  const reminder = page.getByRole("complementary", { name: "Support Tastellar" });
  await expect(reminder).toBeVisible();
  await expect(reminder.getByRole("link", { name: "Support on Boosty" })).toHaveAttribute("href", "https://boosty.to/tastellar");
  await page.screenshot({ path: "/private/tmp/tastellar-support-reminder-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/private/tmp/tastellar-support-reminder-narrow.png" });
  await reminder.getByRole("button", { name: "Close" }).click();
  await expect(reminder).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Support Tastellar" })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  const settingsLink = page.getByRole("link", { name: "Support the project on Boosty" });
  await expect(settingsLink).toHaveAttribute("href", "https://boosty.to/tastellar");
  await settingsLink.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/private/tmp/tastellar-settings-support-narrow.png" });

  await page.setViewportSize({ width: 1320, height: 920 });
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await page.getByRole("button", { name: "Why compare apples to oranges?" }).click();
  const help = page.getByRole("dialog");
  await expect(help).toBeVisible();
  await page.screenshot({ path: "/private/tmp/tastellar-ranking-help-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/private/tmp/tastellar-ranking-help-narrow.png" });
});

test("Home and Settings hide sidebars without clearing the active tab visibility choices", async ({ page }) => {
  await installNativeImportMock(page);
  await page.goto("/");
  const toggles = page.locator(".titlebar .panel-toggle");
  const leftToggle = page.locator(".titlebar .left-sidebar-toggle");
  const rightToggle = page.locator(".titlebar .panel-toggle:not(.left-sidebar-toggle)");
  await expect(toggles).toHaveCount(2);
  await rightToggle.click();
  await expect(rightToggle).toHaveAttribute("aria-pressed", "true");

  await page.locator(".primary-navigation").getByRole("button", { name: "Home" }).click();
  await expect(toggles).toHaveCount(2);
  await expect(leftToggle).toBeHidden();
  await expect(rightToggle).toBeHidden();
  await expect(page.locator(".folder-shell.app-empty-left-sidebar, .details-shell")).toHaveCount(0);

  await page.locator(".rail-bottom").getByRole("button", { name: "Settings" }).click();
  await expect(leftToggle).toBeHidden();
  await expect(rightToggle).toBeHidden();
  await expect(page.locator(".folder-shell.app-empty-left-sidebar, .details-shell")).toHaveCount(0);

  await page.locator(".primary-navigation").getByRole("button", { name: "Library" }).click();
  await expect(leftToggle).toBeVisible();
  await expect(rightToggle).toBeVisible();
  await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
  await expect(rightToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".library-context-panel")).toBeVisible();
});

test("MyAnimeList gzip uploads reach native prepare with their filename and bytes intact", async ({ page }) => {
  await installNativeImportMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  const xml = Buffer.from('<?xml version="1.0"?><myanimelist><myinfo></myinfo></myanimelist>');
  const compressed = gzipSync(xml);
  const fileName = "animelist_1791138105_-_11816574.xml.gz";
  await page.locator('[data-testid="import-file-myAnimeList"]').setInputFiles({
    name: fileName,
    mimeType: "application/gzip",
    buffer: compressed,
  });
  await expect(page.getByTestId("import-provider-myAnimeList").locator(".import-file-pill")).toContainText(fileName);
  await page.getByTestId("import-prepare").click();
  await expect(page.getByTestId("import-categories-step")).toBeVisible();
  const upload = await page.evaluate(() => {
    const call = (window as any).__testCalls.find((item: any) => item.command === "prepare_library_import");
    return call?.args.input.uploads[0] ?? null;
  });
  expect(upload?.provider).toBe("myAnimeList");
  expect(upload?.fileName).toBe(fileName);
  expect(Buffer.from(upload.contentBase64, "base64")).toEqual(compressed);
  await expect(page.getByRole("radio", { name: "No imported tags" })).toBeChecked();
});

test("batch-tag MAL import displays the structured native validation message", async ({ page }) => {
  const nativeError = { code: "Validation", message: "NOT NULL constraint failed: tag.normalized_name" };
  await installNativeImportMock(page, { malSeasonRows: true, commitError: nativeError });
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-myAnimeList"]').setInputFiles({
    name: "animelist.xml.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from("<myanimelist />")),
  });
  await page.getByTestId("import-prepare").click();
  await page.getByTestId("import-categories-step").waitFor();
  await page.getByRole("radio", { name: "Apply selected tags to this batch" }).check();
  await page.getByPlaceholder("New tag name").fill("anime");
  await page.getByRole("button", { name: "Create tag" }).click();
  await expect(page.getByRole("radio", { name: "Apply selected tags to this batch" })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-commit").click();

  await expect(page.getByRole("alert")).toHaveText(nativeError.message);
  const commit = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import"));
  expect(commit.args.input.decisions).toHaveLength(2);
  expect(commit.args.input.decisions.map((decision: any) => decision.newTagNames)).toEqual([["anime"], ["anime"]]);
  expect(commit.args.input.decisions.every((decision: any) => decision.tagIds.length === 0)).toBe(true);
});

test("switching a MAL batch back to no tags omits staged batch tag names", async ({ page }) => {
  await installNativeImportMock(page, { malSeasonRows: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-myAnimeList"]').setInputFiles({
    name: "animelist.xml.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from("<myanimelist />")),
  });
  await page.getByTestId("import-prepare").click();
  await page.getByTestId("import-categories-step").waitFor();
  await page.getByRole("radio", { name: "Apply selected tags to this batch" }).check();
  await page.getByPlaceholder("New tag name").fill("anime");
  await page.getByRole("button", { name: "Create tag" }).click();
  await page.getByRole("radio", { name: "No imported tags" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-commit").click();
  await expect(page.getByTestId("import-receipt")).toBeVisible();

  const commit = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import"));
  expect(commit.args.input.decisions).toHaveLength(2);
  expect(commit.args.input.decisions.every((decision: any) => decision.tagIds.length === 0 && decision.newTagNames.length === 0)).toBe(true);
});

test("import wizard enriches a reviewed row, ignores stale results, and commits the default cover locally", async ({ page }) => {
  await installNativeImportMock(page);
  await mockCatalogCover(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-imdb"]').setInputFiles("tests/fixtures/imports/imdb-source-only-synthetic.csv");
  await page.getByTestId("import-prepare").click();
  await expect(page.getByTestId("import-categories-step")).toBeVisible();
  await expect(page.getByRole("radio", { name: "No imported tags" })).toBeChecked();
  const batchStatus = page.getByRole("combobox", { name: "Status for this import" });
  await batchStatus.click();
  await page.getByRole("option", { name: "Plan to Watch", exact: true }).click();
  await expect(batchStatus).toContainText("Plan to Watch");
  await batchStatus.click();
  await page.getByRole("option", { name: /Use source status/ }).click();
  await expect(batchStatus).toContainText("Use source status");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("import-matches-step")).toBeVisible();
  await expect(page.getByRole("link", { name: "Provider terms" })).toHaveCount(0);
  await expect(page.locator(".import-match-card").first().getByRole("combobox", { name: "Status" })).toContainText("Already experienced");
  await page.getByTestId("import-enrich-imdb:0:2").click();
  await expect(page.getByTestId("import-enrichment-panel")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(2);
  const catalogSource = page.locator(".catalog-search-filters .select-control-trigger").first();
  await expect(catalogSource).toContainText("TMDb");
  await expect(page.getByRole("link", { name: "Provider terms" })).toHaveCount(0);

  const query = page.getByTestId("catalog-search-input");
  await query.fill("Slow Query");
  await query.press("Enter");
  await page.waitForFunction(() => (window as any).__testCalls.some((call: any) => call.command === "search_catalog" && call.args.input.query === "Slow Query"));
  await query.fill("Fast Query");
  await expect(page.getByTestId("catalog-result-tmdb-42")).toBeVisible();
  const catalogRequests = await page.evaluate(() => (window as any).__testCalls.filter((call: any) => call.command === "search_catalog").map((call: any) => call.args.input.providers));
  expect(catalogRequests.every((providers: string[]) => providers.length === 1 && providers[0] === "tmdb")).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "The selected catalog returned incomplete results" })).toBeVisible();
  await page.waitForFunction(() => (window as any).__testCalls.some((call: any) => call.command === "search_catalog" && call.args.input.query === "Slow Query" && call.completed));
  await expect(page.getByTestId("catalog-result-tmdb-42")).toBeVisible();
  await expect(page.getByText("Stale title", { exact: true })).toHaveCount(0);
  await page.getByTestId("catalog-result-tmdb-42").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/private/tmp/tastellar-import-catalog-e2e.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("catalog-result-tmdb-42").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/private/tmp/tastellar-import-catalog-mobile-e2e.png", fullPage: false });
  await expect(page.getByTestId("catalog-result-tmdb-42")).toBeVisible();

  await page.getByRole("button", { name: "Use details" }).click();
  await expect(page.getByRole("checkbox", { name: "Download cover" })).toBeChecked();
  await expect(page.locator(".import-enrichment-choice")).toContainText("Fresh catalog title");
  await expect(page.getByTestId("catalog-result-tmdb-42")).toBeVisible();
  await page.setViewportSize({ width: 1320, height: 920 });
  await page.screenshot({ path: "/private/tmp/tastellar-import-catalog-selected-e2e.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/private/tmp/tastellar-import-catalog-selected-mobile-e2e.png", fullPage: false });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByTestId("import-matches-step")).toBeVisible();
  const commandsBeforeCommit = await page.evaluate(() => (window as any).__testCalls.map((call: any) => call.command));
  expect(commandsBeforeCommit).not.toContain("save_entry");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("import-ratings-step")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("import-confirm-step")).toBeVisible();
  await page.getByTestId("import-commit").click();
  await expect(page.getByTestId("import-receipt")).toBeVisible();
  const commit = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import"));
  expect(commit.args.input.decisions[0].enrichments[0].title).toBe("Fresh catalog title");
  expect(commit.args.input.decisions[0].enrichments[0].remoteCover.provider).toBe("tmdb");
  expect(commit.result.library.entries[0].coverAssetId).toBe("downloaded-cover-asset");
  expect(commit.result.library.entries[0].remoteCover).toBeNull();
  const finalCommands = await page.evaluate(() => (window as any).__testCalls.map((call: any) => call.command));
  expect(finalCommands.filter((command: string) => command === "commit_library_import")).toHaveLength(1);
  await page.locator(".import-wizard-actions").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator('.library-group-list button[aria-current="page"]')).toHaveText(/^7/);

  await page.reload();
  await page.getByRole("button", { name: "Add work" }).click();
  const nextMediaType = page.getByRole("combobox", { name: "Media type" });
  await nextMediaType.click();
  await page.getByRole("option", { name: "Literature", exact: true }).click();
  await page.getByTestId("catalog-tab").click();
  const nextCatalogSource = page.locator(".catalog-search-filters .select-control-trigger").first();
  await expect(nextCatalogSource).toContainText("Open Library");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tastellar.catalog.lastProvider"))).toBe("openLibrary");
  await page.reload();
  await page.getByRole("button", { name: "Add work" }).click();
  await page.getByTestId("catalog-tab").click();
  await expect(page.locator(".catalog-search-filters .select-control-trigger").first()).toContainText("Open Library");
});

test("new-entry catalog tab preserves the draft and local cover selection clears the provider reference", async ({ page }) => {
  await installNativeImportMock(page);
  await mockCatalogCover(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Add work" }).click();
  const title = page.locator(".entry-editor-scroll input[required]");
  await title.fill("Manually staged title");
  const catalogType = page.getByRole("combobox", { name: "Media type" });
  await catalogType.click();
  await page.getByRole("option", { name: "Films", exact: true }).click();
  await page.getByTestId("catalog-tab").click();
  const catalogQuery = page.getByTestId("catalog-search-input");
  await expect(catalogQuery).toHaveValue("Manually staged title");
  await expect(catalogType).toContainText("Films");
  await catalogQuery.fill("Fast Query");
  await catalogQuery.press("Enter");
  await expect(page.getByTestId("catalog-result-tmdb-42")).toBeVisible();

  await page.getByTestId("manual-entry-tab").click();
  await expect(title).toHaveValue("Manually staged title");
  await page.getByTestId("catalog-tab").click();
  await expect(catalogQuery).toHaveValue("Fast Query");
  await expect(catalogType).toContainText("Films");
  await expect(page.getByTestId("catalog-result-tmdb-42")).toBeVisible();

  await page.getByRole("button", { name: "Use details" }).click();
  await expect(title).toHaveValue("Fresh catalog title");
  await page.getByRole("checkbox", { name: "Download cover" }).check();
  await expect(page.getByText("This cover will be downloaded when you save.", { exact: true })).toBeVisible();
  await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({
    name: "manual-cover.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByRole("checkbox", { name: "Download cover" })).not.toBeChecked();
  await expect(page.getByText("This cover will be downloaded when you save.", { exact: true })).toHaveCount(0);
  const commands = await page.evaluate(() => (window as any).__testCalls.map((call: any) => call.command));
  expect(commands).not.toContain("save_entry");
  await page.getByRole("button", { name: "Save work", exact: true }).click();
  await page.waitForFunction(() => (window as any).__testCalls.some((call: any) => call.command === "save_entry_cover"));
  const save = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "save_entry"));
  expect(save.args.entry.remoteCover).toBeNull();
  const coverSave = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "save_entry_cover"));
  expect(coverSave.args.mimeType).toBe("image/png");
  const finalCommands = await page.evaluate(() => (window as any).__testCalls.map((call: any) => call.command));
  expect(finalCommands.filter((command: string) => command === "save_entry")).toHaveLength(1);
});

test("a later Letterboxd catalog match links the existing TMDb owner and keeps its score and status", async ({ page }) => {
  const seedEntry = {
    id: "existing-glass-harbour", importOrder: 1, version: 1, title: "Glass Harbour",
    disposition: "experienced", mediaTypeId: "films", overallRating: 8, coverAssetId: null,
    externalIdentities: [{ provider: "tmdb", entityKind: "movie", externalId: "42", sourceUrl: "https://www.themoviedb.org/movie/42" }],
    remoteCover: null, releaseDate: { year: 2019, month: null, day: null, precision: "year" },
    reviewText: "Local review", shortLabel: null, criterionRatings: {}, tagIds: [],
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  };
  await installNativeImportMock(page, { seedEntry });
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-letterboxd"]').setInputFiles("tests/fixtures/imports/letterboxd-source-only-synthetic.zip");
  await page.getByTestId("import-prepare").click();
  await page.getByRole("radio", { name: "No imported tags" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-enrich-letterboxd:watchlist:synthetic").click();
  const catalogQuery = page.getByTestId("catalog-search-input");
  await catalogQuery.fill("Glass Harbour");
  await catalogQuery.press("Enter");
  await page.getByTestId("catalog-result-tmdb-42").getByRole("button", { name: "Use details" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Linked to the existing work “Glass Harbour”/)).toBeVisible();

  const match = page.locator(".import-match-card").first().getByRole("combobox", { name: "Match this source row" });
  await expect(match).toHaveValue("entry:existing-glass-harbour");
  await expect(page.locator(".import-match-card").first().getByRole("combobox", { name: "Tastellar status" })).toContainText("Already experienced");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".import-rating-card")).toContainText("Your existing Tastellar score (8/10) is kept unless you explicitly replace it.");
  await expect(page.locator(".import-source-ratings input").first()).not.toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-commit").click();
  const commit = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import"));
  const decision = commit.args.input.decisions[0];
  expect(decision.action).toBe("link");
  expect(decision.targetEntryId).toBe("existing-glass-harbour");
  expect(decision.disposition).toBe("experienced");
  expect(decision.ratingSelections[0].acceptNative).toBe(false);
});

test("batch catalog lookup stages the first result and default cover on the import row", async ({ page }) => {
  await installNativeImportMock(page);
  await mockCatalogCover(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-imdb"]').setInputFiles("tests/fixtures/imports/imdb-source-only-synthetic.csv");
  await page.getByTestId("import-prepare").click();
  await expect(page.getByTestId("import-categories-step")).toBeVisible();
  await page.getByRole("radio", { name: "No imported tags" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("import-matches-step")).toBeVisible();

  await page.getByRole("button", { name: "Find details and covers for this batch" }).click();
  await expect(page.getByText(/Checked 1 works; catalog results are available for 1 source rows/)).toBeVisible();
  const row = page.locator(".import-match-card").first();
  await expect(row).toContainText("Fresh catalog title");
  await expect(row).toContainText("Catalog match: Fresh catalog title");
  await expect(page.getByTestId("import-enrichment-panel")).toHaveCount(0);
  const lookup = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "search_catalog"));
  expect(lookup.args.input.externalId).toBe("tt99000001");
  expect(lookup.args.input.externalIdProvider).toBe("imdb");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("import-ratings-step")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-commit").click();
  await expect(page.getByTestId("import-receipt")).toBeVisible();
  const commit = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import"));
  expect(commit.args.input.decisions[0].enrichments[0].title).toBe("Fresh catalog title");
  expect(commit.args.input.decisions[0].enrichments[0].remoteCover.provider).toBe("tmdb");
});

test("automatic TMDb matches keep MAL season titles, source ratings, and importable separate covers", async ({ page }) => {
  await installNativeImportMock(page, { malSeasonRows: true, commitDelay: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-myAnimeList"]').setInputFiles({
    name: "seasons.xml.gz", mimeType: "application/gzip",
    buffer: gzipSync(Buffer.from("<myanimelist />")),
  });
  await page.getByTestId("import-prepare").click();
  await expect(page.getByTestId("import-categories-step")).toBeVisible();
  await page.getByRole("radio", { name: "No imported tags" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Find details and covers for this batch" }).click();

  await expect(page.getByText(/Checked 2 works; catalog results are available for 2 source rows/)).toBeVisible({ timeout: 10_000 });
  const cards = page.locator(".import-match-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Season One");
  await expect(cards.nth(0)).toContainText("Catalog match: Fresh catalog title");
  await expect(cards.nth(1)).toContainText("Season Two");
  await expect(cards.nth(1)).toContainText("The selected catalog ID also appears for");
  await expect(cards.nth(1).getByRole("combobox", { name: "Match this source row" })).toHaveValue("separate");

  const searches = await page.evaluate(() => (window as any).__testCalls.filter((call: any) => call.command === "search_catalog").map((call: any) => call.args.input));
  expect(searches.map((search: any) => search.query)).toEqual(["Season One", "Season Two"]);
  expect(searches.every((search: any) => search.externalId == null && search.externalIdProvider == null)).toBe(true);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("import-ratings-step")).toBeVisible();
  const proposals = page.locator(".import-score-proposal input[type=checkbox]");
  await expect(proposals).toHaveCount(2);
  await proposals.nth(0).check();
  await proposals.nth(1).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-commit").click();
  await expect(page.getByRole("status").filter({ hasText: "Import groups: 2. Selected covers: 2. Cover downloads run one at a time" })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/tastellar-import-cover-progress-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/private/tmp/tastellar-import-cover-progress-narrow.png" });
  await expect(page.getByTestId("import-receipt")).toBeVisible();

  const commit = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import"));
  const decisions = commit.args.input.decisions;
  expect(decisions).toHaveLength(2);
  expect(decisions.map((decision: any) => decision.rowIds)).toEqual([["myAnimeList:0:1"], ["myAnimeList:0:2"]]);
  expect(decisions.map((decision: any) => decision.title)).toEqual(["Season One", "Season Two"]);
  expect(decisions[0].enrichments[0].title).toBe("Season One");
  expect(decisions[1].enrichments[0].title).toBe("Season Two");
  expect(decisions[0].enrichments[0].externalIdentities).toHaveLength(2);
  expect(decisions[1].enrichments[0].externalIdentities).toEqual([]);
  expect(decisions.every((decision: any) => decision.enrichments[0].remoteCover?.provider === "tmdb")).toBe(true);
  expect(decisions.map((decision: any) => decision.ratingSelections)).toEqual([
    [{ sourceRowId: "myAnimeList:0:1", acceptNative: true }],
    [{ sourceRowId: "myAnimeList:0:2", acceptNative: true }],
  ]);
  expect(commit.result.library.entries.map((entry: any) => [entry.title, entry.overallRating])).toEqual([["Season One", 9], ["Season Two", 8]]);
  expect(commit.result.library.entries.every((entry: any) => entry.coverAssetId)).toBe(true);
});

test("same-batch exact catalog IDs offer a visible merge choice without merging rows automatically", async ({ page }) => {
  await installNativeImportMock(page, { duplicateRows: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-imdb"]').setInputFiles("tests/fixtures/imports/imdb-source-only-synthetic.csv");
  await page.locator('[data-testid="import-file-letterboxd"]').setInputFiles("tests/fixtures/imports/letterboxd-source-only-synthetic.zip");
  await page.getByTestId("import-prepare").click();
  await page.getByRole("radio", { name: "No imported tags" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Find details and covers for this batch" }).click();
  const secondRow = page.locator(".import-match-card").nth(1);
  await expect(secondRow).toContainText("Catalog match: Fresh catalog title");
  await expect(secondRow).toContainText("The selected catalog ID also appears for");
  const secondMatch = secondRow.getByRole("combobox", { name: "Match this source row" });
  await expect(secondMatch).toHaveValue("separate");
  await secondRow.getByRole("button", { name: "Combine with this match" }).click();
  await expect(secondMatch).toHaveValue("row:imdb:0:2");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-commit").click();
  const commit = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import"));
  expect(commit.args.input.decisions).toHaveLength(1);
  expect(commit.args.input.decisions[0].rowIds).toEqual(["imdb:0:2", "letterboxd:watched:synthetic"]);
  expect(commit.args.input.decisions[0].enrichments).toHaveLength(1);
});

test("a cover download failure leaves the import saved and can retry the cover separately", async ({ page }) => {
  await installNativeImportMock(page, { failCover: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Import / export" }).click();
  await page.getByTestId("open-import-wizard").click();
  await page.locator('[data-testid="import-file-imdb"]').setInputFiles("tests/fixtures/imports/imdb-source-only-synthetic.csv");
  await page.getByTestId("import-prepare").click();
  await page.getByRole("radio", { name: "No imported tags" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Find details and covers for this batch" }).click();
  await expect(page.locator(".import-match-card").first()).toContainText("Catalog match: Fresh catalog title");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("import-commit").click();

  await expect(page.getByRole("heading", { name: "1 cover(s) could not be saved" })).toBeVisible();
  await expect(page.locator(".import-receipt")).toContainText("Synthetic cover download failed.");
  const entryBeforeRetry = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "commit_library_import").result.library.entries[0]);
  expect(entryBeforeRetry.title).toBe("Fresh catalog title");
  expect(entryBeforeRetry.overallRating).toBe(7);
  expect(entryBeforeRetry.coverAssetId).toBeNull();
  await page.getByRole("button", { name: "Retry cover" }).click();
  await expect(page.getByRole("heading", { name: "1 cover(s) could not be saved" })).toHaveCount(0);
  const retry = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "retry_import_cover"));
  expect(retry.args.batchId).toBe("synthetic-batch-1");
  expect(retry.result.entries[0].coverAssetId).toBe("retried-cover-asset");
});

test("same-provider movie and TV results with the same ID remain distinct and highlight independently", async ({ page }) => {
  await installNativeImportMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Add work" }).click();
  await page.getByTestId("catalog-tab").click();
  const catalogQuery = page.getByTestId("catalog-search-input");
  await catalogQuery.fill("Collision Query");
  await catalogQuery.press("Enter");
  const collidedResults = page.locator('.catalog-result-card[data-testid="catalog-result-tmdb-42"]');
  await expect(collidedResults).toHaveCount(2);
  await collidedResults.first().getByRole("button", { name: "Use details" }).click();
  await expect(page.locator(".catalog-result-card.selected")).toHaveCount(1);
  await expect(page.locator(".catalog-result-card.selected")).toContainText("Same ID Movie");
});
