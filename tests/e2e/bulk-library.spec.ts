import { expect, test, type Page } from "@playwright/test";

async function installNativeLibraryMock(
  page: Page,
  disposition = "planned",
  overallRating: number | null = null,
  catalogOptions: { enabled?: boolean; failDownloadFor?: string } = {},
) {
  await page.addInitScript(({ initialDisposition, initialRating, enabled, failDownloadFor }) => {
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
    const entry = (id: string, title: string, coverAssetId: string) => ({
      id, version: 1, title, disposition: initialDisposition, mediaTypeId: "games",
      overallRating: initialRating, coverAssetId, releaseDate: null, reviewText: "",
      externalIdentities: [], remoteCover: null, shortLabel: null,
      criterionRatings: {}, tagIds: [], createdAt: "2026-10-04T00:00:00Z",
      updatedAt: "2026-10-04T00:00:00Z",
    });
    let library: any = {
      revision: 1,
      entries: [entry("entry-one", "Bulk target one", "cover-one"), entry("entry-two", "Bulk target two", "cover-two")],
      mediaTypes, criteria: [], tags: [],
    };
    const preferences = {
      theme: "dark", textScale: 1, reducedMotion: "off", graphics: "low",
      scenesEnabled: false, rememberSidebarsPerTab: true, restoreTabs: false,
      startupSection: "library", previousTabShortcut: "Alt+ArrowLeft",
      nextTabShortcut: "Alt+ArrowRight", radarMode: "explicit", visibleCriteria: [],
      analyticsBoundaryReviews: [], recapDrafts: JSON.stringify({ version: 1, drafts: [] }), recapWatermark: false,
    };
    const home = {
      version: 1,
      profile: { nickname: "", statedTastes: "", avatarAssetId: null },
      guidelines: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), ""])),
      tasteInputs: {}, preferences,
      workspace: { tabs: [], activeTabId: null, railCollapsed: true, detailsOpen: true, detailsWidth: 320, folderOpen: true },
    };
    const calls: any[] = [];
    g.__testCalls = calls;
    g.__testGetLibrary = () => structuredClone(library);
    g.isTauri = true;
    g.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (command: string, args: any = {}) => {
        const call: any = { command, args, completed: false };
        calls.push(call);
        let result: any;
        if (command === "load_home") result = structuredClone(home);
        else if (command === "load_library") result = structuredClone(library);
        else if (command === "load_ranking") result = {
          revision: library.revision, library: structuredClone(library), unscoredIds: [],
          tiers: Array.from({ length: 10 }, (_, index) => ({ score: 10 - index, placedIds: [], unplacedIds: [], inputSequence: 0, fittedSequence: 0, pendingReconcile: false })),
          activeSession: null,
        };
        else if (command === "load_avatar") result = null;
        else if (command === "catalog_capabilities") result = enabled ? [{
          provider: "igdb", label: "IGDB", enabled: true, configured: true, reason: null,
          mediaTypeIds: ["games"], termsUrl: "https://www.igdb.com/api", attributionText: "IGDB",
        }] : [];
        else if (command === "search_catalog") {
          const coverFile = args.input.query === "Bulk target two"
            ? "bulk-fixture-second.jpg"
            : "bulk-fixture-first.jpg";
          result = {
            results: [{
              provider: "igdb", id: `synthetic-${args.input.query}`, mediaType: "game",
              title: `${args.input.query} catalog match`, originalTitle: null, creators: [], year: null,
              suggestedMediaTypeId: "games", identities: [],
              coverUrl: `https://images.igdb.com/igdb/image/upload/t_cover_big/${coverFile}`,
              coverMode: "persistReference", coverProvider: "igdb",
              remoteCover: {
                provider: "igdb",
                url: `https://images.igdb.com/igdb/image/upload/t_cover_big/${coverFile}`,
                sourceUrl: null, attribution: "IGDB",
              },
              attribution: "IGDB", sourceUrl: null,
            }], nextPage: null, warnings: [],
          };
        } else if (command === "load_recap_remote_cover") {
          result = Boolean(failDownloadFor) && args.url.includes(failDownloadFor)
            ? null
            : `data:image/jpeg;base64,${btoa("synthetic-cover-bytes")}`;
        } else if (command === "save_entry_cover") {
          const entry = library.entries.find((item: any) => item.id === args.entryId);
          if (!entry || args.expectedRevision !== library.revision) throw new Error("Stale library revision");
          entry.coverAssetId = `replacement-${args.entryId}`;
          entry.remoteCover = null;
          entry.version += 1;
          library.revision += 1;
          result = structuredClone(library);
        }
        else if (command === "save_workspace") result = structuredClone(home);
        else if (command === "batch_update_entries") {
          const input = args.input;
          const selected = new Set(input.entryIds);
          if (input.trash) library.entries = library.entries.filter((item: any) => !selected.has(item.id));
          else library.entries = library.entries.map((item: any) => {
            if (!selected.has(item.id)) return item;
            const disposition = input.disposition ?? item.disposition;
            return {
              ...item,
              disposition,
              mediaTypeId: input.mediaTypeId ?? item.mediaTypeId,
              overallRating: disposition === "experienced" ? item.overallRating : null,
              ...(input.removeCovers ? { coverAssetId: null, remoteCover: null } : {}),
              version: item.version + 1,
            };
          });
          library.revision += 1;
          result = structuredClone(library);
        } else throw new Error(`Unexpected test bridge command: ${command}`);
        call.result = structuredClone(result);
        call.completed = true;
        return result;
      },
    };
  }, {
    initialDisposition: disposition,
    initialRating: overallRating,
    enabled: catalogOptions.enabled ?? false,
    failDownloadFor: catalogOptions.failDownloadFor ?? "",
  });
}

test("bulk selection applies one native batch update and removes covers as a batch", async ({ page }) => {
  await installNativeLibraryMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Select works", exact: true }).click();

  const first = page.locator(".library-work-card").filter({ hasText: "Bulk target one" });
  const second = page.locator(".library-work-card").filter({ hasText: "Bulk target two" });
  await first.locator(".work-card-select").click();
  await second.locator(".work-card-select").click();
  await expect(page.getByText("Selected · 2", { exact: true })).toBeVisible();

  const mediaType = page.getByRole("combobox", { name: "Media type", exact: true });
  await mediaType.click();
  await page.getByRole("option", { name: "Animation", exact: true }).click();
  const disposition = page.getByRole("combobox", { name: "Tastellar status", exact: true });
  await disposition.click();
  await page.getByRole("option", { name: "Dropped", exact: true }).click();
  await page.screenshot({ path: "/private/tmp/tastellar-bulk-library-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/private/tmp/tastellar-bulk-library-mobile.png", fullPage: false });

  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await page.waitForFunction(() => (window as any).__testCalls.some((call: any) => call.command === "batch_update_entries" && call.completed));
  let batchCalls = await page.evaluate(() => (window as any).__testCalls.filter((call: any) => call.command === "batch_update_entries"));
  expect(batchCalls[0].args.input).toEqual({
    expectedRevision: 1,
    entryIds: ["entry-one", "entry-two"],
    mediaTypeId: "anime",
    disposition: "dropped",
  });
  expect(batchCalls[0].result.entries.every((entry: any) => entry.disposition === "dropped" && entry.mediaTypeId === "anime")).toBe(true);

  await page.getByRole("button", { name: "Remove covers", exact: true }).click();
  await page.waitForFunction(() => (window as any).__testCalls.filter((call: any) => call.command === "batch_update_entries").length === 2);
  batchCalls = await page.evaluate(() => (window as any).__testCalls.filter((call: any) => call.command === "batch_update_entries"));
  expect(batchCalls[1].args.input).toEqual({
    expectedRevision: 2,
    entryIds: ["entry-one", "entry-two"],
    removeCovers: true,
  });
  expect(batchCalls[1].result.entries.every((entry: any) => entry.coverAssetId === null && entry.remoteCover === null)).toBe(true);
});

test("bulk catalog cover fetch replaces successful covers and leaves failed downloads untouched", async ({ page }) => {
  await installNativeLibraryMock(page, "planned", null, { enabled: true, failDownloadFor: "bulk-fixture-second.jpg" });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Select works", exact: true }).click();

  const first = page.locator(".library-work-card").filter({ hasText: "Bulk target one" });
  const second = page.locator(".library-work-card").filter({ hasText: "Bulk target two" });
  await first.locator(".work-card-select").click();
  await second.locator(".work-card-select").click();
  await expect(page.getByText("Selected · 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Catalog source", exact: true })).toContainText("IGDB");
  await page.getByRole("button", { name: "Fetch covers", exact: true }).click();

  await expect(page.getByRole("status").filter({ hasText: "Updated 1 cover." })).toBeVisible({ timeout: 5000 });
  const calls = await page.evaluate(() => (window as any).__testCalls);
  const searches = calls.filter((call: any) => call.command === "search_catalog");
  const downloads = calls.filter((call: any) => call.command === "load_recap_remote_cover");
  const saves = calls.filter((call: any) => call.command === "save_entry_cover");
  expect(searches).toHaveLength(2);
  expect(searches[0].args.input).toMatchObject({
    query: "Bulk target one",
    mediaTypeId: "games",
    providers: ["igdb"],
    page: null,
  });
  expect(downloads).toHaveLength(2);
  expect(saves).toHaveLength(1);
  expect(saves[0].args).toMatchObject({ entryId: "entry-one", expectedRevision: 1, mimeType: "image/jpeg" });
  const library = await page.evaluate(() => (window as any).__testGetLibrary());
  expect(library.entries[0].coverAssetId).toBe("replacement-entry-one");
  expect(library.entries[1].coverAssetId).toBe("cover-two");
});

test("opens the Unrated group when all existing works are experienced without ratings", async ({ page }) => {
  await installNativeLibraryMock(page, "experienced", null);
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator('.library-group-list button[aria-current="page"]')).toContainText("Unrated");
});
