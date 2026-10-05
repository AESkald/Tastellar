import type { Entry, ExternalIdentity, LibraryState, ReleaseDate, RemoteCoverReference } from "./libraryTypes";

/** Versioned request/response contract for the local, review-before-commit importer. */
export const IMPORT_CONTRACT_VERSION = 1 as const;

export type ImportFileProvider =
  | "letterboxd"
  | "imdb"
  | "goodreads"
  | "myAnimeList"
  | "genericCsv";

export type ImportProvider = ImportFileProvider | "steam";

export interface ImportUpload {
  provider: ImportFileProvider;
  fileName: string;
  /** Base64 of the selected file bytes. Never a filesystem path. */
  contentBase64: string;
}

export interface ImportSourceSummary {
  provider: ImportProvider;
  sourceName: string;
  rowCount: number;
  warnings: string[];
}

export interface SourceRating {
  value: number;
  scale: string;
}

export interface SourceProgress {
  unit: string;
  current: number;
  total: number | null;
}

export interface ImportSourceActivity {
  fingerprint: string;
  kind: "watched" | "diary" | "rating" | "review" | "watchlist" | "read" | "owned" | "item" | "other";
  dateFields: Record<string, string>;
  rating: SourceRating | null;
  rewatch: boolean | null;
  tags: string[];
  hasReview: boolean;
}

export interface ImportCandidate {
  entryId: string | null;
  sourceRowId: string | null;
  title: string;
  mediaTypeId: string | null;
  year: number | null;
  provider: string | null;
  externalId: string | null;
  reason: "exact-id" | "title-year" | "same-batch";
  confidence: "high" | "medium";
}

export interface ImportSourceRow {
  rowId: string;
  provider: ImportProvider;
  providerMediaType: string | null;
  externalId: string | null;
  sourceIdentities: ExternalIdentity[];
  sourceUrl: string | null;
  title: string;
  originalTitle: string | null;
  creators: string[];
  year: number | null;
  releaseDate: ReleaseDate | null;
  sourceStatus: string | null;
  /** User-authored source review, inert plain text; never committed unless opted in. */
  reviewText?: string | null;
  sourceRating: SourceRating | null;
  /** Retains each provider date field independently (e.g. Date Added vs Date Read). */
  sourceDates: Record<string, string>;
  sourceActivities: ImportSourceActivity[];
  /** Provider-specific values retained for provenance, such as Steam playtime. */
  sourceMetadata?: Record<string, string>;
  tags: string[];
  progress: SourceProgress | null;
  suggestedMediaTypeId: string | null;
  exactEntryId: string | null;
  candidates: ImportCandidate[];
  warnings: string[];
}

export interface ImportPreview {
  schemaVersion: typeof IMPORT_CONTRACT_VERSION;
  sessionId: string;
  expectedRevision: number;
  sources: ImportSourceSummary[];
  rows: ImportSourceRow[];
  warnings: string[];
}

export type ImportRowAction = "create" | "link" | "skip";

export interface ImportRatingSelection {
  sourceRowId: string;
  acceptNative: boolean;
  /** Existing local score is kept unless this is explicitly true. */
  overwriteExistingRating?: boolean;
}

export interface ImportTagMapping {
  rowId: string;
  sourceTag: string;
  action: "ignore" | "existing" | "create";
  tagId?: string;
  newTagName?: string;
}

/** Rows can be grouped only through a user-reviewed create/link decision. */
export interface ImportDecision {
  rowIds: string[];
  action: ImportRowAction;
  targetEntryId?: string;
  title?: string;
  mediaTypeId?: string | null;
  disposition: Entry["disposition"] | null;
  overwriteExistingMetadata?: boolean;
  overwriteExistingDisposition?: boolean;
  importReviews?: boolean;
  overwriteExistingReview?: boolean;
  /** Explicit user-created/existing tags to apply to the canonical work. */
  tagIds?: string[];
  newTagNames?: string[];
  /** Optional manual Tastellar score, distinct from accepting a provider score. */
  manualOverallRating?: number | null;
  ratingSelections?: ImportRatingSelection[];
  tagMappings?: ImportTagMapping[];
  /** Only explicit user-selected catalog matches are persisted. */
  enrichments?: Array<{
    sourceRowId: string;
    title: string;
    releaseDate: ReleaseDate | null;
    externalIdentities: ExternalIdentity[];
    remoteCover: RemoteCoverReference | null;
    overwriteExistingMetadata?: boolean;
  }>;
}

export interface ImportRatingPolicy {
  mode: "priority" | "latestComparable" | "manual" | "preserveOnly";
  /** Provider IDs, ordered from highest priority to lowest. */
  priority: string[];
  manualSelections: Array<{ rowIds: string[]; sourceRowId: string }>;
}

export interface ImportCommitInput {
  schemaVersion: typeof IMPORT_CONTRACT_VERSION;
  sessionId: string;
  expectedRevision: number;
  decisions: ImportDecision[];
  ratingPolicy: ImportRatingPolicy;
}

export interface ImportCommitResult {
  library: LibraryState;
  batchId: string;
  created: number;
  linked: number;
  skipped: number;
  coverFailures: ImportCoverFailure[];
}

export interface ImportCoverFailure {
  sourceRowId: string;
  title: string;
  message: string;
  provider: string;
  url: string;
  entryId: string;
}

export interface ImportUndoResult {
  library: LibraryState;
  batchId: string;
  created: number;
  linked: number;
  skipped: number;
}

export interface SteamImportOptions {
  /** SteamID64 or a canonical Steam profile URL; validated by the backend. */
  steamId: string;
  includePlayedFreeGames: boolean;
}

export interface PrepareImportInput {
  schemaVersion: typeof IMPORT_CONTRACT_VERSION;
  uploads: ImportUpload[];
  /** When present, explicitly requests a Steam library query as part of this batch. */
  steam?: SteamImportOptions;
}

export interface ImportProviderCapabilities {
  provider: ImportProvider;
  configured: boolean;
  enabled: boolean;
  disabledReason: string | null;
  supportedMediaTypeIds: string[];
  acquisition: "file" | "official-api";
}
