import { invoke, isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { loadCachedCoverSource, loadEntryCover } from "./libraryBridge";
import type { RemoteCoverReference } from "./libraryTypes";
import { t } from "../ui/i18n";

const remoteCoverHosts: Record<string, string[]> = {
  tmdb: ["image.tmdb.org"],
  openlibrary: ["covers.openlibrary.org"],
  googlebooks: ["books.google.com", "books.googleusercontent.com"],
  igdb: ["images.igdb.com"],
  steam: ["shared.akamai.steamstatic.com", "cdn.akamai.steamstatic.com"],
};

const tmdbImageSizes = new Set([
  "w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "h632", "original",
]);
const MAX_REMOTE_COVER_BYTES = 10 * 1024 * 1024;

function safeProviderImagePath(path: string): boolean {
  const parts = path.split("/");
  return path.length <= 300 && parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part));
}

function safeSteamCover(url: URL): boolean {
  const rest = url.pathname.startsWith("/store_item_assets/steam/apps/")
    ? url.pathname.slice("/store_item_assets/steam/apps/".length)
    : url.pathname.startsWith("/steam/apps/")
      ? url.pathname.slice("/steam/apps/".length)
      : null;
  if (!rest) return false;
  const parts = rest.split("/");
  const [appId, ...assets] = parts;
  if (!appId || appId.length > 12 || !/^\d+$/.test(appId) || assets.length < 1 || assets.length > 2) return false;
  if (assets.some((part) => !part || part === "." || part === "..")) return false;
  if (assets.length === 2 && !/^[A-Fa-f0-9]{40}$/.test(assets[0])) return false;
  const file = assets[assets.length - 1];
  const extension = file.match(/\.(jpg|jpeg|png|webp)$/)?.[1];
  const stem = extension ? file.slice(0, -(extension.length + 1)) : "";
  if (!stem || stem.length > 160 || !/^[A-Za-z0-9_-]+$/.test(stem)) return false;
  const pairs = [...url.searchParams.entries()];
  return pairs.length === 0 || (pairs.length === 1 && pairs[0][0] === "t" && /^\d{1,20}$/.test(pairs[0][1]));
}

function safeProviderImageUrl(cover: RemoteCoverReference, url: URL): boolean {
  const path = url.pathname;
  switch (cover.provider) {
    case "tmdb": {
      const parts = path.split("/");
      return url.search === "" && parts.length >= 5 && parts[1] === "t" && parts[2] === "p" &&
        tmdbImageSizes.has(parts[3]) && safeProviderImagePath(parts.slice(4).join("/"));
    }
    case "openlibrary":
      return url.search === "" && /^\/b\/id\/\d+-(S|M|L)\.jpg$/.test(path);
    case "googlebooks":
      return path === "/books/content" && url.search !== "";
    case "igdb":
      return /^\/igdb\/image\/upload\/t_cover_big(?:_2x)?\/[A-Za-z0-9_-]+\.jpg$/.test(path) && url.search === "";
    case "steam":
      return safeSteamCover(url);
    default:
      return false;
  }
}

function isSupportedRemoteCover(cover: RemoteCoverReference): boolean {
  try {
    const url = new URL(cover.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.href.length <= 4096 && remoteCoverHosts[cover.provider]?.includes(url.hostname) === true &&
      !url.href.includes("#") && safeProviderImageUrl(cover, url);
  } catch {
    return false;
  }
}

async function fetchRemoteCoverDataUrl(cover: RemoteCoverReference): Promise<string | null> {
  if (!isSupportedRemoteCover(cover)) return null;
  try {
    const response = await fetch(cover.url, {
      // Cross-origin CORS hides redirect targets, so web mode rejects redirects. Tauri handles its
      // separately validated Open Library archive redirects in the native downloader.
      mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
    });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_COVER_BYTES) return null;
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return null;

    let bytes: Uint8Array;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_REMOTE_COVER_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (length === 0) return null;
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > MAX_REMOTE_COVER_BYTES) return null;
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

export async function loadRecapCover(
  entryId: string,
  assetId?: string | null,
  remoteCover?: RemoteCoverReference | null,
): Promise<string | null> {
  if (isTauri() && assetId) {
    return loadCachedCoverSource(`recap:${assetId}`, () => invoke<string | null>("load_recap_cover", { assetId }));
  }
  if (remoteCover) {
    const key = `recap:remote:${remoteCover.provider}:${remoteCover.url}`;
    return loadCachedCoverSource(key, () => isTauri()
      ? invoke<string | null>("load_recap_remote_cover", { provider: remoteCover.provider, url: remoteCover.url })
      : fetchRemoteCoverDataUrl(remoteCover));
  }
  return loadEntryCover(entryId, assetId);
}

/** Returns false when the user cancels the native destination picker. */
export async function saveRecapImage(blob: Blob, filename: string): Promise<boolean> {
  if (!isTauri()) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  const path = await save({
    title: t("recap.export.dialogTitle"),
    defaultPath: filename,
    filters: [{ name: t("recap.export.pngFormat"), extensions: ["png"] }],
  });
  if (!path) return false;
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  await invoke("export_recap_image", { path, base64 });
  return true;
}
