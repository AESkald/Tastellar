import type { CatalogCapability, CatalogRemoteCover, CatalogSearchRequest } from "../../../shared/bridge/catalogTypes";
import type { Entry } from "../../../shared/bridge/libraryTypes";

export type BulkCoverEntry = Pick<Entry, "id" | "title" | "mediaTypeId" | "releaseDate">;

export interface BulkCoverProgress {
  completed: number;
  total: number;
  updated: number;
  missing: number;
  failed: number;
  unsupported: number;
  currentTitle: string | null;
}

export interface BulkCoverResult extends Omit<BulkCoverProgress, "currentTitle"> {
  cancelled: boolean;
}

export interface BulkCoverDependencies {
  search: (input: CatalogSearchRequest) => Promise<{
    results: Array<{
      coverMode: "none" | "transient" | "persistReference";
      remoteCover: CatalogRemoteCover | null;
    }>;
  }>;
  loadCover: (entryId: string, cover: CatalogRemoteCover) => Promise<string | null>;
  saveCover: (entry: BulkCoverEntry, mimeType: string, base64: string) => Promise<void>;
  onProgress?: (progress: BulkCoverProgress) => void;
  isCancelled?: () => boolean;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

function savedCoverParts(dataUrl: string | null) {
  const match = dataUrl?.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Looks up and saves one cover at a time. A failed lookup, download, or save
 * never writes to the entry, so an existing cover remains intact.
 */
export async function fetchBulkLibraryCovers(
  entries: readonly BulkCoverEntry[],
  capability: CatalogCapability,
  dependencies: BulkCoverDependencies,
): Promise<BulkCoverResult> {
  const result: BulkCoverResult = {
    completed: 0,
    total: entries.length,
    updated: 0,
    missing: 0,
    failed: 0,
    unsupported: 0,
    cancelled: false,
  };
  const report = (currentTitle: string | null) => {
    dependencies.onProgress?.({
      completed: result.completed,
      total: result.total,
      updated: result.updated,
      missing: result.missing,
      failed: result.failed,
      unsupported: result.unsupported,
      currentTitle,
    });
  };
  const wait = dependencies.wait ?? delay;
  const now = dependencies.now ?? Date.now;

  for (const entry of entries) {
    if (dependencies.isCancelled?.()) {
      result.cancelled = true;
      break;
    }

    report(entry.title);
    const startedAt = now();
    let requestedCatalog = false;
    if (entry.mediaTypeId && !capability.mediaTypeIds.includes(entry.mediaTypeId)) {
      result.unsupported += 1;
    } else {
      requestedCatalog = true;
      try {
        const response = await dependencies.search({
          query: entry.title,
          mediaTypeId: entry.mediaTypeId,
          providers: [capability.provider],
          year: entry.releaseDate?.year ?? null,
          page: null,
        });
        if (dependencies.isCancelled?.()) {
          result.cancelled = true;
          break;
        }
        const match = response.results.find(
          (candidate) => candidate.coverMode === "persistReference" && candidate.remoteCover,
        );
        if (!match?.remoteCover) {
          result.missing += 1;
        } else {
          const source = await dependencies.loadCover(entry.id, match.remoteCover);
          if (dependencies.isCancelled?.()) {
            result.cancelled = true;
            break;
          }
          const cover = savedCoverParts(source);
          if (!cover) {
            result.failed += 1;
          } else {
            await dependencies.saveCover(entry, cover.mimeType, cover.base64);
            result.updated += 1;
          }
        }
      } catch {
        if (dependencies.isCancelled?.()) {
          result.cancelled = true;
          break;
        }
        result.failed += 1;
      }
    }

    result.completed += 1;
    report(null);
    const remaining = 1000 - (now() - startedAt);
    if (requestedCatalog && remaining > 0 && !dependencies.isCancelled?.()) {
      await wait(remaining);
    }
  }

  if (dependencies.isCancelled?.()) {
    result.cancelled = true;
  }
  report(null);
  return result;
}
