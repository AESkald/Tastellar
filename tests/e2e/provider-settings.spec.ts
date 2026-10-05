import { expect, test, type Page } from "@playwright/test";

const SYNTHETIC_TMDB_TOKEN = "SYNTHETIC-TMDB-READ-TOKEN-NOT-A-REAL-CREDENTIAL";
const SYNTHETIC_STEAM_KEY = "SYNTHETIC-STEAM-KEY-NOT-A-REAL-CREDENTIAL";

/** Native bridge mock: state contains only explicitly synthetic fixture strings. */
async function installNativeProviderMock(page: Page, initiallyConfigured: string[] = []) {
  await page.addInitScript((initiallyConfiguredProviders) => {
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
    const library: any = { revision: 0, entries: [], mediaTypes, criteria: [], tags: [] };
    const preferences = {
      theme: "dark", textScale: 1, reducedMotion: "off", graphics: "low",
      scenesEnabled: false, rememberSidebarsPerTab: true, restoreTabs: false,
      startupSection: "library", previousTabShortcut: "Alt+ArrowLeft",
      nextTabShortcut: "Alt+ArrowRight", radarMode: "explicit", visibleCriteria: [],
      analyticsBoundaryReviews: [], recapDrafts: JSON.stringify({ version: 1, drafts: [] }), recapWatermark: false,
    };
    const home: any = {
      version: 0,
      profile: { nickname: "", statedTastes: "", avatarAssetId: null },
      guidelines: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), ""])),
      tasteInputs: {}, preferences,
      workspace: { tabs: [], activeTabId: null, railCollapsed: true, detailsOpen: false, detailsWidth: 320, folderOpen: true },
    };
    const providers = [
      { provider: "tmdb", label: "TMDb", mediaTypeIds: ["films", "tv-series", "anime"], termsUrl: "https://www.themoviedb.org/api-terms-of-use", attributionText: "This product uses the TMDB API but is not endorsed or certified by TMDB." },
      { provider: "googleBooks", label: "Google Books", mediaTypeIds: ["literature", "comic"], termsUrl: "https://developers.google.com/books/terms", attributionText: "Google Books" },
      { provider: "igdb", label: "IGDB", mediaTypeIds: ["games"], termsUrl: "https://www.igdb.com/api", attributionText: "Data from IGDB" },
      { provider: "steam", label: "Steam", mediaTypeIds: ["games"], termsUrl: "https://steamcommunity.com/dev/apiterms", attributionText: "Steam" },
    ];
    const credentials: Record<string, any> = Object.fromEntries(
      initiallyConfiguredProviders.map((provider: string) => [provider, { apiKey: `SYNTHETIC-${provider}-NOT-A-REAL-CREDENTIAL` }]),
    );
    const calls: any[] = [];
    const clone = (value: any) => structuredClone(value);
    const capabilities = () => [
      { provider: "openLibrary", label: "Open Library", enabled: true, configured: true, reason: null, mediaTypeIds: ["literature", "comic"], termsUrl: "https://openlibrary.org/developers/api", attributionText: "Open Library" },
      ...providers.map((item) => {
        const configured = Boolean(credentials[item.provider]);
        return { ...item, enabled: configured, configured, reason: configured ? null : "Credentials are not configured.", };
      }),
    ];
    g.__testCalls = calls;
    g.__testCredentials = credentials;
    g.isTauri = true;
    g.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (command: string, args: any = {}) => {
        const call: any = { command, args, completed: false };
        calls.push(call);
        let result: any;
        if (command === "load_home") result = clone(home);
        else if (command === "load_library") result = clone(library);
        else if (command === "load_ranking") result = {
          revision: library.revision, library: clone(library), unscoredIds: [],
          tiers: Array.from({ length: 10 }, (_, index) => ({ score: 10 - index, placedIds: [], unplacedIds: [], inputSequence: 0, fittedSequence: 0, pendingReconcile: false })),
          activeSession: null,
        };
        else if (command === "load_avatar") result = null;
        else if (command === "catalog_capabilities") result = capabilities();
        else if (command === "configure_provider_credentials") {
          const input = args.input;
          if (input.clear) delete credentials[input.provider];
          else credentials[input.provider] = clone(input);
          result = { provider: input.provider, configured: !input.clear, sessionOnly: false };
        } else if (command === "prepare_library_import") {
          const row = {
            rowId: "imdb:0:2", provider: "imdb", providerMediaType: "Movie", externalId: "tt99000001",
            sourceIdentities: [{ provider: "imdb", entityKind: "title", externalId: "tt99000001", sourceUrl: "https://www.imdb.com/title/tt99000001/" }],
            sourceUrl: "https://www.imdb.com/title/tt99000001/", title: "Synthetic CSV Import", originalTitle: null,
            creators: ["Synthetic Creator"], year: 2020,
            releaseDate: { year: 2020, month: null, day: null, precision: "year" },
            sourceStatus: "watched", sourceRating: null, sourceDates: {}, sourceActivities: [], tags: [], progress: null,
            suggestedMediaTypeId: "films", exactEntryId: null, candidates: [], warnings: [],
          };
          result = {
            schemaVersion: 1, sessionId: "synthetic-provider-settings-import", expectedRevision: library.revision,
            sources: [{ provider: "imdb", sourceName: "synthetic-csv", rowCount: 1, warnings: [] }], rows: [row], warnings: [],
          };
        } else if (command === "search_catalog") {
          const input = args.input;
          const provider = input.providers[0];
          result = {
            results: [{
              provider, id: "synthetic-catalog-42", mediaType: "movie",
              title: "Synthetic Search Result", originalTitle: null,
              creators: ["Synthetic Creator"], year: 2020,
              suggestedMediaTypeId: "films",
              identities: [{ provider: "tmdb", entityKind: "movie", externalId: "synthetic-42", sourceUrl: "https://www.themoviedb.org/movie/synthetic-42" }],
              coverUrl: null, coverMode: "none", coverProvider: null, remoteCover: null,
              attribution: "TMDb", sourceUrl: "https://www.themoviedb.org/movie/synthetic-42",
            }], nextPage: null, warnings: [],
          };
        } else if (command === "save_preferences") {
          home.preferences = clone(args.preferences ?? home.preferences);
          home.version += 1;
          result = clone(home);
        } else if (command === "save_workspace") {
          home.workspace = clone(args.workspace ?? home.workspace);
          result = clone(home);
        } else {
          throw new Error(`Unexpected provider-settings mock command: ${command}`);
        }
        call.result = clone(result);
        call.completed = true;
        return result;
      },
    };
  }, initiallyConfigured);
}

test("Add Work can save a synthetic TMDb token and search the catalog", async ({ page }) => {
  await installNativeProviderMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  const mediaType = page.getByRole("combobox", { name: "Media type", exact: true });
  await mediaType.click();
  await page.getByRole("option", { name: "Films", exact: true }).click();
  await page.getByTestId("catalog-tab").click();
  await expect(page.getByRole("paragraph").filter({ hasText: "No catalog is enabled yet." })).toBeVisible();
  await page.getByTestId("catalog-search-input").fill("Synthetic Search");
  await page.getByTestId("provider-api-settings").click();

  const credentials = page.getByTestId("provider-credentials-modal");
  const tmdbKey = credentials.getByTestId("provider-credential-field-tmdb-apiKey");
  await expect(credentials).toBeVisible();
  await expect(tmdbKey).toHaveAttribute("type", "password");
  await tmdbKey.fill(SYNTHETIC_TMDB_TOKEN);
  await credentials.getByTestId("provider-credential-reveal-tmdb-apiKey").click();
  await expect(tmdbKey).toHaveAttribute("type", "text");
  await expect(tmdbKey).toHaveValue(SYNTHETIC_TMDB_TOKEN);
  await credentials.getByTestId("provider-credential-reveal-tmdb-apiKey").click();
  await expect(tmdbKey).toHaveAttribute("type", "password");
  await credentials.getByTestId("provider-credential-save").click();
  await expect(credentials.getByRole("status")).toContainText(/stored/i);
  await expect(tmdbKey).toHaveValue("");
  await expect(credentials.getByTestId("provider-credential-card-tmdb")).toContainText("Saved");

  const saved = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "configure_provider_credentials"));
  expect(saved.args.input).toEqual({ provider: "tmdb", apiKey: SYNTHETIC_TMDB_TOKEN });
  expect(saved.result).toMatchObject({ provider: "tmdb", configured: true, sessionOnly: false });
  expect(await page.locator("body").innerText()).not.toContain(SYNTHETIC_TMDB_TOKEN);

  await page.locator("dialog.provider-credentials-modal").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("catalog-search-input")).toHaveValue("Synthetic Search");
  await page.getByTestId("catalog-search-input").press("Enter");
  await expect(page.getByText("Synthetic Search Result", { exact: true })).toBeVisible();
  const search = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "search_catalog"));
  expect(search.args.input.providers).toEqual(["tmdb"]);
  expect(search.args.input.query).toBe("Synthetic Search");

  await page.getByTestId("provider-api-settings").click();
  const reopened = page.getByTestId("provider-credentials-modal");
  await expect(reopened.getByTestId("provider-credential-card-tmdb")).toContainText("Saved");
  await reopened.getByTestId("provider-credential-remove").click();
  await expect(reopened.getByTestId("provider-credential-card-tmdb")).toContainText("Credentials not configured");
  const removed = await page.evaluate(() => (window as any).__testCalls.filter((call: any) => call.command === "configure_provider_credentials").at(-1));
  expect(removed.args.input).toEqual({ provider: "tmdb", clear: true });
  expect(await page.locator("body").innerText()).not.toContain(SYNTHETIC_TMDB_TOKEN);
});

test("IGDB setup requires both Twitch application credentials", async ({ page }) => {
  await installNativeProviderMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  await page.getByTestId("catalog-tab").click();
  await page.getByTestId("provider-api-settings").click();

  const modal = page.getByTestId("provider-credentials-modal");
  const igdb = modal.getByTestId("provider-credential-card-igdb");
  await igdb.getByRole("button").click();
  const clientId = modal.getByTestId("provider-credential-field-igdb-clientId");
  const clientSecret = modal.getByTestId("provider-credential-field-igdb-clientSecret");
  const save = modal.getByTestId("provider-credential-save");
  await clientId.fill("SYNTHETIC-TWITCH-CLIENT-ID");
  await expect(save).toBeDisabled();
  await expect(clientSecret).toHaveAttribute("type", "password");
  await clientSecret.fill("SYNTHETIC-TWITCH-CLIENT-SECRET-NOT-REAL");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(igdb).toContainText("Saved");

  const saved = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "configure_provider_credentials"));
  expect(saved.args.input).toEqual({
    provider: "igdb",
    clientId: "SYNTHETIC-TWITCH-CLIENT-ID",
    clientSecret: "SYNTHETIC-TWITCH-CLIENT-SECRET-NOT-REAL",
  });
  expect(await page.locator("body").innerText()).not.toContain("SYNTHETIC-TWITCH-CLIENT-SECRET-NOT-REAL");
});

test("Import Steam exposes missing-key setup and saves its synthetic key", async ({ page }) => {
  await installNativeProviderMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Import / export", exact: true }).click();
  await page.getByTestId("open-import-wizard").click();

  const steamSetup = page.locator(".import-steam-setup");
  await expect(steamSetup).toBeVisible();
  await expect(steamSetup).toContainText("Add a Steam API key to import owned games.");
  await expect(steamSetup.getByLabel("SteamID64 or profile URL")).toBeVisible();
  await steamSetup.getByTestId("provider-api-settings").click();

  const credentials = page.getByTestId("provider-credentials-modal");
  const steamKey = credentials.getByTestId("provider-credential-field-steam-apiKey");
  await expect(steamKey).toHaveAttribute("type", "password");
  await steamKey.fill(SYNTHETIC_STEAM_KEY);
  await credentials.getByTestId("provider-credential-save").click();
  await expect(credentials.getByRole("status")).toContainText(/stored/i);
  await expect(steamSetup).toContainText("Saved");
  await expect(steamKey).toHaveValue("");

  const saved = await page.evaluate(() => (window as any).__testCalls.find((call: any) => call.command === "configure_provider_credentials"));
  expect(saved.args.input).toEqual({ provider: "steam", apiKey: SYNTHETIC_STEAM_KEY });
  expect(await page.locator("body").innerText()).not.toContain(SYNTHETIC_STEAM_KEY);
});

test("CSV import exposes TMDb credentials from the Matches heading without opening a row editor", async ({ page }) => {
  await installNativeProviderMock(page);
  await page.setViewportSize({ width: 900, height: 820 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Import / export", exact: true }).click();
  await page.getByTestId("open-import-wizard").click();

  const globalSettings = page.getByTestId("import-provider-api-settings");
  await expect(globalSettings).toBeVisible();
  await page.locator('[data-testid="import-file-imdb"]').setInputFiles("tests/fixtures/imports/imdb-source-only-synthetic.csv");
  await page.getByTestId("import-prepare").click();
  await expect(page.getByTestId("import-categories-step")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("import-matches-step")).toBeVisible();

  await expect(globalSettings).toBeVisible();
  await globalSettings.click();
  const credentialsDialog = page.locator("dialog.provider-credentials-modal");
  await expect(credentialsDialog).toBeVisible();
  const tmdbCard = credentialsDialog.getByTestId("provider-credential-card-tmdb");
  await expect(tmdbCard).toContainText("TMDb");
  await expect(credentialsDialog.getByTestId("provider-credential-field-tmdb-apiKey")).toBeVisible();
  await expect(credentialsDialog.getByTestId("provider-credential-field-steam-apiKey")).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/tastellar-import-global-api-900.png", fullPage: false, animations: "disabled" });
});

test("JSON archive warns when saved provider credentials are present", async ({ page }) => {
  await installNativeProviderMock(page, ["tmdb"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Data & privacy", exact: true }).click();
  const warning = page.getByTestId("export-credentials-warning");
  await expect(warning).toContainText("This JSON backup includes saved API credentials. Keep it private.");
});

test("provider credential setup modal fits desktop widths in dark and light themes", async ({ page }) => {
  await installNativeProviderMock(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  await page.getByTestId("catalog-tab").click();
  await page.getByTestId("provider-api-settings").click();
  const dialog = page.locator("dialog.provider-credentials-modal");
  await expect(dialog).toBeVisible();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 900, height: 820 }]) {
    await page.setViewportSize(viewport);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `/private/tmp/tastellar-provider-credentials-dark-${viewport.width}.png`, fullPage: false, animations: "disabled" });
  }

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog", { name: "Add work" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: /Daylight/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  await page.getByTestId("catalog-tab").click();
  await page.getByTestId("provider-api-settings").click();
  const lightDialog = page.locator("dialog.provider-credentials-modal");
  for (const viewport of [{ width: 1280, height: 900 }, { width: 900, height: 820 }]) {
    await page.setViewportSize(viewport);
    const bounds = await lightDialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `/private/tmp/tastellar-provider-credentials-light-${viewport.width}.png`, fullPage: false, animations: "disabled" });
  }
});

test("keyless Open Library does not trigger the saved-credentials archive warning", async ({ page }) => {
  await installNativeProviderMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Data & privacy", exact: true }).click();
  await expect(page.getByTestId("export-credentials-warning")).toHaveCount(0);
});
