import { describe, expect, it, vi } from "vitest";
import type { CatalogCapability, CatalogSearchRequest } from "../../../shared/bridge/catalogTypes";
import type { Entry } from "../../../shared/bridge/libraryTypes";
import { fetchBulkLibraryCovers } from "./bulkCoverAction";

const capability: CatalogCapability = {
  provider: "tmdb",
  label: "TMDb",
  enabled: true,
  configured: true,
  reason: null,
  mediaTypeIds: ["films", "tv-series"],
  termsUrl: null,
  attributionText: null,
};

const remoteCover = {
  provider: "tmdb",
  url: "https://image.tmdb.org/t/p/w500/bulk-cover-fixture.jpg",
  sourceUrl: null,
  attribution: null,
};

const entries: Array<Pick<Entry, "id" | "title" | "mediaTypeId" | "releaseDate">> = [
  {
    id: "film",
    title: "A Film",
    mediaTypeId: "films",
    releaseDate: { year: 2024, precision: "year" },
  },
  {
    id: "second-film",
    title: "Another Film",
    mediaTypeId: "films",
    releaseDate: null,
  },
];

describe("bulk library cover fetch", () => {
  it("replaces existing covers after successful catalog downloads", async () => {
    const covers = new Map([["film", "existing-cover"], ["second-film", "existing-cover-2"]]);
    const requests: CatalogSearchRequest[] = [];
    const saveCover = vi.fn(async (entry: typeof entries[number], _mimeType: string, base64: string) => {
      covers.set(entry.id, base64);
    });

    const result = await fetchBulkLibraryCovers(entries.slice(0, 1), capability, {
      search: async (request) => {
        requests.push(request);
        return { results: [{ coverMode: "persistReference", remoteCover }] };
      },
      loadCover: async () => "data:image/jpeg;base64,bmV3LWNvdmVy",
      saveCover,
      now: () => 1000,
      wait: async () => undefined,
    });

    expect(requests).toEqual([{
      query: "A Film",
      mediaTypeId: "films",
      providers: ["tmdb"],
      year: 2024,
      page: null,
    }]);
    expect(saveCover).toHaveBeenCalledWith(entries[0], "image/jpeg", "bmV3LWNvdmVy");
    expect(covers.get("film")).toBe("bmV3LWNvdmVy");
    expect(covers.get("second-film")).toBe("existing-cover-2");
    expect(result).toMatchObject({ completed: 1, total: 1, updated: 1, missing: 0, failed: 0, unsupported: 0 });
  });

  it("preserves existing covers for missing results and failed downloads", async () => {
    const covers = new Map([["film", "existing-cover"], ["second-film", "existing-cover-2"]]);
    const saveCover = vi.fn(async (entry: typeof entries[number], _mimeType: string, base64: string) => {
      covers.set(entry.id, base64);
    });
    const search = vi.fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [{ coverMode: "persistReference", remoteCover }] });

    const result = await fetchBulkLibraryCovers(entries, capability, {
      search,
      loadCover: async () => null,
      saveCover,
      now: () => 1000,
      wait: async () => undefined,
    });

    expect(saveCover).not.toHaveBeenCalled();
    expect(covers).toEqual(new Map([["film", "existing-cover"], ["second-film", "existing-cover-2"]]));
    expect(result).toMatchObject({ completed: 2, total: 2, updated: 0, missing: 1, failed: 1, unsupported: 0 });
  });

  it("preserves covers when catalog search or the cover save fails", async () => {
    const covers = new Map([["film", "existing-cover"], ["second-film", "existing-cover-2"]]);
    const search = vi.fn()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({ results: [{ coverMode: "persistReference", remoteCover }] });

    const result = await fetchBulkLibraryCovers(entries, capability, {
      search,
      loadCover: async () => "data:image/jpeg;base64,bmV3LWNvdmVy",
      saveCover: async () => { throw new Error("save failed"); },
      now: () => 1000,
      wait: async () => undefined,
    });

    expect(covers).toEqual(new Map([["film", "existing-cover"], ["second-film", "existing-cover-2"]]));
    expect(result).toMatchObject({ completed: 2, total: 2, updated: 0, missing: 0, failed: 2, unsupported: 0 });
  });

  it("skips media types the selected provider does not support and reports progress", async () => {
    const onProgress = vi.fn();
    const search = vi.fn();
    const result = await fetchBulkLibraryCovers([
      ...entries,
      { id: "book", title: "A Book", mediaTypeId: "literature", releaseDate: null },
    ], capability, {
      search,
      loadCover: async () => null,
      saveCover: async () => undefined,
      onProgress,
      now: () => 1000,
      wait: async () => undefined,
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ completed: 3, total: 3, unsupported: 1 });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      completed: 3,
      total: 3,
      unsupported: 1,
      currentTitle: null,
    }));
  });

  it("does not download or save a result when cancellation arrives during lookup", async () => {
    let cancelled = false;
    const loadCover = vi.fn(async () => "data:image/jpeg;base64,bmV3LWNvdmVy");
    const saveCover = vi.fn(async () => undefined);
    const result = await fetchBulkLibraryCovers(entries, capability, {
      search: async () => {
        cancelled = true;
        return { results: [{ coverMode: "persistReference", remoteCover }] };
      },
      loadCover,
      saveCover,
      isCancelled: () => cancelled,
      now: () => 1000,
      wait: async () => undefined,
    });

    expect(loadCover).not.toHaveBeenCalled();
    expect(saveCover).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: 0, total: 2, updated: 0, cancelled: true });
  });
});
