import { invoke, isTauri } from "@tauri-apps/api/core";
import { loadLibrary } from "./libraryBridge";
import type { LibraryState, ReleaseDate } from "./libraryTypes";
import type {
  ImportCommitInput,
  ImportCommitResult,
  ImportPreview,
  ImportProvider,
  ImportSourceRow,
  ImportUndoResult,
  ImportUpload,
  PrepareImportInput,
} from "./importTypes";

const native = isTauri();
const mockSessions = new Map<string, ImportPreview>();

function decodeBase64(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Small RFC-4180-style parser for the browser preview adapter, not production authority. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function cell(record: Record<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const found = Object.entries(record).find(
      ([header]) => header.trim().toLowerCase() === key.toLowerCase(),
    )?.[1];
    if (found?.trim()) return found.trim();
  }
  return null;
}

function mapProviderCategory(provider: ImportProvider, kind: string | null) {
  const normalized = kind?.toLowerCase() ?? "";
  if (provider === "letterboxd" || provider === "imdb") {
    if (normalized.includes("tv") || normalized.includes("series")) return "tv-series";
    return "films";
  }
  if (provider === "goodreads") return "literature";
  if (provider === "myAnimeList") {
    if (normalized.includes("manga")) return "comic";
    return "anime";
  }
  return null;
}

function parseBrowserCsv(upload: ImportUpload, uploadIndex: number): ImportSourceRow[] {
  if (upload.fileName.toLowerCase().endsWith(".zip")) return [];
  const [headerRow, ...dataRows] = parseCsv(decodeBase64(upload.contentBase64));
  if (!headerRow) return [];
  const headers = headerRow.map((header) => header.replace(/^\uFEFF/, "").trim());
  return dataRows.flatMap((values, rowIndex) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const title = cell(record, "Title", "Name", "Original Title", "OriginalTitle");
    if (!title) return [];
    const yearText = cell(record, "Year", "Release Year");
    const yearValue = yearText ? Number.parseInt(yearText.slice(0, 4), 10) : NaN;
    const year = Number.isFinite(yearValue) && yearValue > 0 ? yearValue : null;
    const sourceId = cell(record, "Const", "IMDb ID", "ISBN13", "ISBN 13", "ISBN", "Book Id", "BookID", "Letterboxd URI", "MAL ID", "ID");
    const providerType = cell(record, "Title Type", "Type", "Media Type");
    const ratingText = cell(record, "Your Rating", "Rating", "My Rating", "Score");
    const ratingValue = ratingText ? Number(ratingText) : NaN;
    let scale = "unknown";
    if (upload.provider === "imdb") scale = "1-10";
    if (upload.provider === "letterboxd") scale = "0.5-5";
    if (upload.provider === "goodreads") scale = "0-5";
    if (upload.provider === "myAnimeList") scale = "0-10";
    const sourceRating = Number.isFinite(ratingValue) && ratingValue > 0
      ? { value: ratingValue, scale }
      : null;
    const sourceDates = Object.fromEntries(
      Object.entries(record).filter(([header, value]) => /date/i.test(header) && value.trim()),
    );
    const externalId = sourceId?.replace(/^=\"|\"$/g, "") ?? null;
    const providerNamespace = upload.provider === "myAnimeList" ? "myanimelist" : upload.provider === "genericCsv" ? "genericcsv" : upload.provider;
    const entityKind = upload.provider === "imdb" ? "title" : upload.provider === "letterboxd" ? "film" : upload.provider === "goodreads" ? (sourceId?.match(/^\d+$/) ? "book" : "edition") : providerType?.toLowerCase().includes("manga") ? "manga" : "anime";
    const mappedType = mapProviderCategory(upload.provider, providerType);
    const releaseDate: ReleaseDate | null = year
      ? { year, month: null, day: null, precision: "year" }
      : null;
    return [{
      rowId: `${upload.provider}:${uploadIndex}:${rowIndex + 2}`,
      provider: upload.provider,
      providerMediaType: providerType,
      externalId,
      sourceIdentities: externalId ? [{ provider: providerNamespace, entityKind, externalId, sourceUrl: null }] : [],
      sourceUrl: upload.provider === "letterboxd" && externalId?.startsWith("http") ? externalId : null,
      title,
      originalTitle: cell(record, "OriginalTitle", "Original Title"),
      creators: (cell(record, "Authors", "Author", "Directors", "Director") ?? "")
        .split(/\s*[,;]\s*/).filter(Boolean),
      year,
      releaseDate,
      sourceStatus: cell(record, "Status", "Watch Status", "Shelf", "Exclusive Shelf"),
      sourceRating,
      sourceDates,
      sourceActivities: [],
      sourceMetadata: {},
      tags: (cell(record, "Tags", "Shelves") ?? "").split(/\s*[,;]\s*/).filter(Boolean),
      progress: null,
      suggestedMediaTypeId: mappedType,
      exactEntryId: null,
      candidates: [],
      warnings: [],
    }];
  });
}

async function mockPreview(input: PrepareImportInput): Promise<ImportPreview> {
  const sessionId = crypto.randomUUID();
  const rows = input.uploads.flatMap(parseBrowserCsv);
  const library = await loadLibrary();
  const unsupported = input.uploads
    .filter((upload) => upload.fileName.toLowerCase().endsWith(".zip"))
    .map((upload) => `${upload.fileName}: ZIP preview is available in the desktop backend.`);
  const preview: ImportPreview = {
    schemaVersion: 1,
    sessionId,
    expectedRevision: library.revision,
    sources: input.uploads.map((upload) => ({
      provider: upload.provider,
      sourceName: upload.fileName,
      rowCount: rows.filter((row) => row.provider === upload.provider).length,
      warnings: [],
    })),
    rows,
    warnings: unsupported,
  };
  mockSessions.set(sessionId, preview);
  return preview;
}

export function prepareImport(input: PrepareImportInput): Promise<ImportPreview> {
  if (input.schemaVersion !== 1) throw new Error("Unsupported import request version");
  if (native) return invoke<ImportPreview>("prepare_library_import", { input });
  return mockPreview(input);
}

export async function commitImport(input: ImportCommitInput): Promise<ImportCommitResult> {
  if (input.schemaVersion !== 1) throw new Error("Unsupported import commit version");
  if (!native) throw new Error("Imports can be previewed in the browser, but committing requires the desktop app.");
  return invoke<ImportCommitResult>("commit_library_import", { input });
}

export async function retryImportCover(
  expectedRevision: number,
  batchId: string,
  entryId: string,
  provider: string,
  url: string,
): Promise<LibraryState> {
  if (!native) throw new Error("Cover retry requires the desktop app.");
  return invoke<LibraryState>("retry_import_cover", {
    expectedRevision,
    batchId,
    entryId,
    provider,
    url,
  });
}

export async function cancelImport(sessionId: string): Promise<void> {
  if (native) return invoke("cancel_library_import", { sessionId });
  mockSessions.delete(sessionId);
}

export function undoImportBatch(batchId: string, expectedRevision: number): Promise<ImportUndoResult> {
  if (native) return invoke<ImportUndoResult>("undo_library_import", { batchId, expectedRevision });
  throw new Error("Undo for browser preview imports is not supported. Use the desktop app to commit imports.");
}
