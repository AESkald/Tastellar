import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteCoverReference } from "./libraryTypes";
import { clearEntryCoverCache } from "./libraryBridge";
import { loadRecapCover } from "./recapBridge";

const tauriMock = vi.hoisted(() => ({ native: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauriMock.native,
  invoke: tauriMock.invoke,
}));

const cover: RemoteCoverReference = {
  provider: "igdb",
  url: "https://images.igdb.com/igdb/image/upload/t_cover_big/recap-bridge-fixture.jpg",
  sourceUrl: "https://www.igdb.com/games/recap-bridge-fixture",
  attribution: "IGDB",
};

const reportedTitleCovers: Array<{ title: string; remoteCover: RemoteCoverReference }> = [
  {
    title: "Silksong",
    remoteCover: {
      provider: "steam",
      url: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1030300/7983574d464e6559ac7e24275727f73a8bcca1f3/header.jpg?t=1776125736",
      sourceUrl: null,
      attribution: null,
    },
  },
  {
    title: "God of War 2018",
    remoteCover: {
      provider: "steam",
      url: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1593500/header.jpg?t=1763059412",
      sourceUrl: null,
      attribution: null,
    },
  },
  {
    title: "ReZero",
    remoteCover: {
      provider: "tmdb",
      url: "https://image.tmdb.org/t/p/w1280/5MrRCj7z92YLWMXHeWKp19eJPYv.jpg",
      sourceUrl: null,
      attribution: null,
    },
  },
  {
    title: "The Witcher 3",
    remoteCover: {
      provider: "steam",
      url: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/292030/49e4b8a02a3a3790886acf86ef0a6344e1fc9e63/header_alt_assets_1_czech.jpg?t=1790845156",
      sourceUrl: null,
      attribution: null,
    },
  },
  {
    title: "Vinland Saga",
    remoteCover: {
      provider: "tmdb",
      url: "https://image.tmdb.org/t/p/w1280/zh3VH700llCYUWaRLxrsEASoth3.jpg",
      sourceUrl: null,
      attribution: null,
    },
  },
];

describe("Recap cover bridge", () => {
  beforeEach(() => {
    clearEntryCoverCache();
    tauriMock.native = false;
    tauriMock.invoke.mockReset();
  });

  it("turns remote provider image bytes into a same-origin data URL for canvas use", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/webp", "content-length": "3" }),
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const source = await loadRecapCover("entry", null, cover);
      expect(source).toMatch(/^data:image\/webp;base64,/);
      expect(atob(source!.split(",")[1])).toBe(String.fromCharCode(1, 2, 3));
      await expect(loadRecapCover("entry", null, cover)).resolves.toBe(source);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(cover.url, {
        mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not fetch a URL outside the provider host allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(loadRecapCover("entry", null, { ...cover, url: "https://example.com/image.jpg" })).resolves.toBeNull();
      await expect(loadRecapCover("steam-entry", null, {
        provider: "steam",
        url: "https://shared.akamai.steamstatic.com/not-a-store-cover.jpg",
        sourceUrl: null,
        attribution: null,
      })).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes provider images through the validated native downloader in the desktop app", async () => {
    tauriMock.native = true;
    tauriMock.invoke.mockResolvedValue("data:image/jpeg;base64,native-source");

    await expect(loadRecapCover("entry", null, cover)).resolves.toBe("data:image/jpeg;base64,native-source");
    expect(tauriMock.invoke).toHaveBeenCalledWith("load_recap_remote_cover", {
      provider: "igdb", url: cover.url,
    });
  });

  it("routes the five reported library references through the same native cover loader", async () => {
    tauriMock.native = true;
    for (const { title, remoteCover } of reportedTitleCovers) {
      const dataUrl = "data:image/jpeg;base64," + btoa(title);
      tauriMock.invoke.mockResolvedValueOnce(dataUrl);
      await expect(loadRecapCover(title, null, remoteCover)).resolves.toBe(dataUrl);
    }
    expect(tauriMock.invoke).toHaveBeenCalledTimes(reportedTitleCovers.length);
    for (const { remoteCover } of reportedTitleCovers) {
      expect(tauriMock.invoke).toHaveBeenCalledWith("load_recap_remote_cover", {
        provider: remoteCover.provider,
        url: remoteCover.url,
      });
    }
  });

  it("accepts the same five trusted cover shapes in browser mode for canvas-safe loading", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg", "content-length": "3" }),
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const { title, remoteCover } of reportedTitleCovers) {
        await expect(loadRecapCover(title, null, remoteCover)).resolves.toMatch(/^data:image\/jpeg;base64,/);
      }
      expect(fetchMock).toHaveBeenCalledTimes(reportedTitleCovers.length);
      for (const { remoteCover } of reportedTitleCovers) {
        expect(fetchMock).toHaveBeenCalledWith(remoteCover.url, {
          mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
        });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries a reported provider reference after one transient native miss", async () => {
    tauriMock.native = true;
    const reference = reportedTitleCovers.find(({ title }) => title === "Silksong")!.remoteCover;
    const recovered = "data:image/jpeg;base64," + btoa("Silksong cover");
    tauriMock.invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(recovered);

    await expect(loadRecapCover("Silksong", null, reference)).resolves.toBeNull();
    await expect(loadRecapCover("Silksong", null, reference)).resolves.toBe(recovered);
    expect(tauriMock.invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized browser response from its declared length before reading its body", async () => {
    const blob = vi.fn();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg", "content-length": String(10 * 1024 * 1024 + 1) }),
      blob,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(loadRecapCover("Silksong", null, reportedTitleCovers[0].remoteCover)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(blob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a provider response with a non-raster MIME type", async () => {
    const blob = vi.fn();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/svg+xml", "content-length": "64" }),
      blob,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(loadRecapCover("Silksong", null, reportedTitleCovers[0].remoteCover)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(blob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops reading a streamed cover as soon as it exceeds the byte limit", async () => {
    const blob = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      body,
      blob,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(loadRecapCover("Silksong", null, reportedTitleCovers[0].remoteCover)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(blob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
