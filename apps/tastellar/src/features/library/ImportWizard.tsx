import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  FileArchive,
  FileText,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { SelectControl } from "../../shared/ui/SelectControl";
import type { Entry, LibraryState, MediaType } from "../../shared/bridge/libraryTypes";
import type { CatalogCapability } from "../../shared/bridge/catalogTypes";
import type { CatalogSearchResult } from "../../shared/bridge/catalogTypes";
import { searchCatalog } from "../../shared/bridge/catalogBridge";
import { preferredCatalogProvider, rememberCatalogProvider } from "../../shared/bridge/catalogPreferences";
import { CatalogSearchPanel } from "./CatalogSearchPanel";
import {
  IMPORT_CONTRACT_VERSION,
  type ImportCommitInput,
  type ImportCommitResult,
  type ImportDecision,
  type ImportFileProvider,
  type ImportPreview,
  type ImportSourceRow,
  type ImportUpload,
  type ImportRatingPolicy,
} from "../../shared/bridge/importTypes";
import { cancelImport, commitImport, prepareImport, retryImportCover, undoImportBatch } from "../../shared/bridge/importBridge";
import { importFailureMessage } from "./importError";
import { t } from "../../shared/ui/i18n";
import "./import-wizard.css";

type Step = "sources" | "categories" | "matches" | "ratings" | "confirm";
type RowAction = "create" | "link" | "skip" | "merge";
type RowPlan = {
  action: RowAction;
  targetEntryId: string | null;
  mergeIntoRowId: string | null;
  mediaTypeId: string | null;
  disposition: Entry["disposition"];
  importReviews: boolean;
  applyBatchTags: boolean;
};
type SourceTagPlan = { action: "ignore" | "existing" | "create"; tagId?: string; newTagName?: string };
type SelectedUpload = { upload: ImportUpload; size: number; id: string };

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_BATCH_BYTES = 24 * 1024 * 1024;
const importSources: Array<{ provider: ImportFileProvider; labelKey: string; hintKey: string; accept: string; icon: "zip" | "csv" }> = [
  { provider: "letterboxd", labelKey: "library.import.letterboxd", hintKey: "library.import.letterboxdHint", accept: ".zip,application/zip", icon: "zip" },
  { provider: "imdb", labelKey: "library.import.imdb", hintKey: "library.import.imdbHint", accept: ".csv,text/csv", icon: "csv" },
  { provider: "goodreads", labelKey: "library.import.goodreads", hintKey: "library.import.goodreadsHint", accept: ".csv,text/csv", icon: "csv" },
  { provider: "myAnimeList", labelKey: "library.import.mal", hintKey: "library.import.malHint", accept: ".xml,.xml.gz,.gz,.csv,.tsv,.txt,application/xml,application/gzip,text/csv,text/plain", icon: "csv" },
  { provider: "genericCsv", labelKey: "library.import.generic", hintKey: "library.import.genericHint", accept: ".csv,.tsv,text/csv,text/tab-separated-values", icon: "csv" },
];

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

function sourceName(provider: string) {
  return importSources.find((item) => item.provider === provider)?.labelKey ?? provider;
}

function mappedDisposition(row: ImportSourceRow): Entry["disposition"] {
  const value = `${row.sourceStatus ?? ""} ${row.providerMediaType ?? ""}`.toLowerCase();
  if (/\b(dropped|abandoned)\b/.test(value)) return "dropped";
  if (/\b(plan.?to|planned|watchlist|to.?read|planning)\b/.test(value)) return "planned";
  if (/\b(completed|complete|watched|read|finished)\b/.test(value)) return "experienced";
  return "experienced";
}

function normalizeScore(value: number, scale: string): number | null {
  const normalized = scale.trim().toLowerCase().replaceAll(" ", "");
  if (!Number.isFinite(value)) return null;
  if (normalized === "1-10") return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
  if (normalized === "0-10") return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
  if (normalized === "0.5-5") return value >= 0.5 && value <= 5 && Number.isInteger(value * 2) ? value * 2 : null;
  if (normalized === "0-5" || normalized === "1-5") return Number.isInteger(value) && value >= 1 && value <= 5 ? value * 2 : null;
  return null;
}

function providerLabel(provider: string) {
  return t(sourceName(provider));
}

function catalogLookupForRow(row: ImportSourceRow): { externalId: string; provider: string } | null {
  if (row.provider === "imdb" && row.externalId?.startsWith("tt")) return { externalId: row.externalId, provider: "imdb" };
  if (row.provider === "goodreads") {
    const isbn = row.sourceIdentities.find((identity) => identity.provider === "isbn" && identity.entityKind === "edition")?.externalId;
    if (isbn && /^(?:\d{9}[\dXx]|\d{13})$/.test(isbn)) return { externalId: isbn, provider: "isbn" };
  }
  return null;
}

function candidateValue(candidate: ImportSourceRow["candidates"][number]) {
  if (candidate.sourceRowId) return `row:${candidate.sourceRowId}`;
  if (candidate.entryId) return `entry:${candidate.entryId}`;
  return "separate";
}

function catalogIdentityKey(identity: { provider: string; entityKind: string; externalId: string }): string {
  return `${identity.provider.trim().toLocaleLowerCase()}\0${identity.entityKind.trim().toLocaleLowerCase()}\0${identity.externalId.trim().toLocaleLowerCase()}`;
}

function catalogIdentityOwners(result: Pick<CatalogSearchResult, "identities">, entries: Entry[]): Entry[] {
  if (!result.identities.length) return [];
  const selectedIdentities = new Set(result.identities.map(catalogIdentityKey));
  return entries.filter((entry) => entry.externalIdentities?.some((identity) => selectedIdentities.has(catalogIdentityKey(identity))));
}

function sharedCatalogIdentity(left: CatalogSearchResult, right: CatalogSearchResult): boolean {
  const leftIds = new Set(left.identities.map(catalogIdentityKey));
  return right.identities.some((identity) => leftIds.has(catalogIdentityKey(identity)));
}

function resolveRowRoot(rowId: string, plans: Record<string, RowPlan>, seen = new Set<string>()): string {
  if (seen.has(rowId)) return rowId;
  seen.add(rowId);
  const next = plans[rowId]?.mergeIntoRowId;
  return next && plans[next] ? resolveRowRoot(next, plans, seen) : rowId;
}

function buildGroups(rows: ImportSourceRow[], plans: Record<string, RowPlan>) {
  const groups = new Map<string, ImportSourceRow[]>();
  const linkedRoots = new Map<string, string>();
  for (const row of rows) {
    const plan = plans[row.rowId];
    if (!plan || plan.action === "skip") continue;
    const resolvedRoot = resolveRowRoot(row.rowId, plans);
    const linkedTarget = plans[resolvedRoot]?.targetEntryId ?? plan.targetEntryId;
    let rootId = resolvedRoot;
    if (linkedTarget) {
      const firstRoot = linkedRoots.get(linkedTarget);
      if (firstRoot) rootId = firstRoot;
      else linkedRoots.set(linkedTarget, resolvedRoot);
    }
    const current = groups.get(rootId) ?? [];
    current.push(row);
    groups.set(rootId, current);
  }
  return [...groups.entries()].map(([rootId, groupedRows]) => ({ rootId, rows: groupedRows }));
}

function makeInitialPlans(preview: ImportPreview, library: LibraryState): Record<string, RowPlan> {
  const plans: Record<string, RowPlan> = Object.fromEntries(preview.rows.map((row) => {
    const exactId = row.exactEntryId ?? null;
    const existing = exactId ? library.entries.find((entry) => entry.id === exactId) : null;
    const exactCandidate = row.candidates.find((candidate) => candidate.reason === "exact-id" && candidate.entryId);
    const candidateId = exactCandidate?.entryId ?? null;
    const existingMatch = existing?.id ?? candidateId;
    return [row.rowId, {
      action: existingMatch ? "link" : "create",
      targetEntryId: existingMatch,
      mergeIntoRowId: null,
      mediaTypeId: row.suggestedMediaTypeId,
      disposition: existing?.disposition ?? mappedDisposition(row),
      importReviews: false,
      applyBatchTags: true,
    } satisfies RowPlan];
  }));
  const earlierRows = new Map(preview.rows.map((row, index) => [row.rowId, { row, index }]));
  for (const row of preview.rows) {
    const exactMatch = row.candidates.find((candidate) => candidate.reason === "exact-id" && candidate.sourceRowId);
    const earlier = exactMatch?.sourceRowId ? earlierRows.get(exactMatch.sourceRowId) : null;
    if (!earlier || earlier.index >= preview.rows.findIndex((item) => item.rowId === row.rowId)) continue;
    if (!row.suggestedMediaTypeId || row.suggestedMediaTypeId !== earlier.row.suggestedMediaTypeId) continue;
    const targetRoot = resolveRowRoot(earlier.row.rowId, plans);
    plans[row.rowId] = { ...plans[row.rowId], action: "merge", targetEntryId: null, mergeIntoRowId: targetRoot };
  }
  return plans;
}

function isComparableDate(row: ImportSourceRow): string | null {
  if (row.provider === "imdb") {
    const key = Object.keys(row.sourceDates).find((field) => field.trim().toLowerCase() === "date rated");
    return key ? row.sourceDates[key] ?? null : null;
  }
  return null;
}

function comparableDateValue(row: ImportSourceRow): number | null {
  const value = isComparableDate(row);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null;
}

function FileSourceCard({
  provider,
  labelKey,
  hintKey,
  accept,
  icon,
  files,
  busy,
  onFiles,
}: {
  provider: ImportFileProvider;
  labelKey: string;
  hintKey: string;
  accept: string;
  icon: "zip" | "csv";
  files: SelectedUpload[];
  busy: boolean;
  onFiles: (provider: ImportFileProvider, files: FileList | null) => void;
}) {
  const Icon = icon === "zip" ? FileArchive : FileText;
  const selected = files.filter((item) => item.upload.provider === provider);
  return (
    <div className="import-source-card" data-testid={`import-provider-${provider}`}>
      <div className="import-source-icon"><Icon size={17} /></div>
      <div className="import-source-copy">
        <strong>{t(labelKey)}</strong>
        <span>{t(hintKey)}</span>
        {selected.map((item) => (
          <small key={item.id} className="import-file-pill">{item.upload.fileName} · {formatBytes(item.size)}</small>
        ))}
      </div>
      <label className="button secondary import-source-button">
        <Plus size={14} /> {t("library.import.chooseFiles")}
        <input
          data-testid={`import-file-${provider}`}
          type="file"
          accept={accept}
          multiple
          disabled={busy}
          onChange={(event) => {
            onFiles(provider, event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </label>
    </div>
  );
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function ImportWizard({
  state,
  capabilities,
  onClose,
  onCommitLibrary,
}: {
  state: LibraryState;
  capabilities: CatalogCapability[];
  onClose: () => void;
  onCommitLibrary: (library: LibraryState) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>("sources");
  const [uploads, setUploads] = useState<SelectedUpload[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [plans, setPlans] = useState<Record<string, RowPlan>>({});
  const [categoryDefaults, setCategoryDefaults] = useState<Record<string, string | null>>({});
  const [tagMode, setTagMode] = useState<"none" | "batch" | "source" | null>("none");
  const [batchTagIds, setBatchTagIds] = useState<string[]>([]);
  const [newTagNames, setNewTagNames] = useState<string[]>([]);
  const [tagText, setTagText] = useState("");
  const [sourceTagPlans, setSourceTagPlans] = useState<Record<string, SourceTagPlan>>({});
  const [ratingMode, setRatingMode] = useState<ImportRatingPolicy["mode"]>("manual");
  const [priority, setPriority] = useState<string[]>([]);
  const [manualSelections, setManualSelections] = useState<Record<string, string>>({});
  const [manualRatings, setManualRatings] = useState<Record<string, string>>({});
  const [ratingChoices, setRatingChoices] = useState<Record<string, { sourceRowId: string | null; accepted: boolean; overwrite: boolean }>>({});
  const [steamId, setSteamId] = useState("");
  const [includePlayedFreeGames, setIncludePlayedFreeGames] = useState(false);
  const [providerCaps, setProviderCaps] = useState(capabilities);
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);
  const [coverRetryErrors, setCoverRetryErrors] = useState<Record<string, string>>({});
  const [undoDone, setUndoDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewSourceReviews, setReviewSourceReviews] = useState(false);
  const [overwriteLocalReviews, setOverwriteLocalReviews] = useState(false);
  const [catalogRowId, setCatalogRowId] = useState<string | null>(null);
  const [catalogSelections, setCatalogSelections] = useState<Record<string, CatalogSearchResult>>({});
  const [catalogCoverSelections, setCatalogCoverSelections] = useState<Record<string, boolean>>({});
  const [batchLookupCandidates, setBatchLookupCandidates] = useState<Record<string, CatalogSearchResult[]>>({});
  const [batchLookupBusy, setBatchLookupBusy] = useState(false);
  const [batchLookupSummary, setBatchLookupSummary] = useState<{ checked: number; withResults: number; capped: boolean; unsupported: number } | null>(null);
  const [automaticBatchMatchRows, setAutomaticBatchMatchRows] = useState<Set<string>>(() => new Set());
  const [commitProgress, setCommitProgress] = useState<{ works: number; covers: number } | null>(null);
  const [explicitSeparateRows, setExplicitSeparateRows] = useState<Set<string>>(() => new Set());

  const totalBytes = uploads.reduce((sum, item) => sum + item.size, 0);
  const rows = preview?.rows ?? [];
  const groups = useMemo(() => buildGroups(rows, plans), [rows, plans]);
  const replaceableReviewCount = groups.filter((group) => {
    const existing = existingForGroup(group.rows, plans, state);
    return Boolean(existing?.reviewText.trim() && group.rows.some((row) => row.reviewText?.trim()));
  }).length;
  const sourceReviewCount = rows.filter((row) => Boolean(row.reviewText?.trim())).length;
  const sourceTags = useMemo(() => {
    const values = new Map<string, { provider: string; tag: string; rowIds: string[] }>();
    for (const row of rows) for (const tag of row.tags) {
      const key = `${row.provider}\0${tag}`;
      const value = values.get(key) ?? { provider: row.provider, tag, rowIds: [] };
      value.rowIds.push(row.rowId);
      values.set(key, value);
    }
    return [...values.entries()].map(([key, value]) => ({ key, ...value }));
  }, [rows]);
  const anyComparableRatingDates = groups.some(({ rows: grouped }) => {
    const rated = grouped.filter((row) => row.sourceRating);
    return rated.length > 1 && rated.every((row) => comparableDateValue(row) !== null);
  });
  const steamCapability = providerCaps.find((item) => item.provider === "steam");
  const lookupProviders = providerCaps.filter((item) => item.enabled && item.provider !== "steam");
  const [bulkProvider, setBulkProvider] = useState<string>(() => preferredCatalogProvider(capabilities));
  const [bulkStatus, setBulkStatus] = useState("");
  const lookupCancelled = useRef(false);
  useEffect(() => () => { lookupCancelled.current = true; }, []);
  const selectedLookupProvider = bulkProvider || preferredCatalogProvider(providerCaps);
  useEffect(() => {
    const nextProvider = preferredCatalogProvider(providerCaps, null, bulkProvider);
    if (nextProvider !== bulkProvider) {
      setBulkProvider(nextProvider);
      if (nextProvider) rememberCatalogProvider(nextProvider);
    }
  }, [providerCaps, bulkProvider]);
  const stepOrder: Step[] = ["sources", "categories", "matches", "ratings", "confirm"];
  const stepIndex = stepOrder.indexOf(step);

  const setFiles = async (provider: ImportFileProvider, fileList: FileList | null) => {
    if (!fileList?.length) return;
    setBusy(true);
    setError("");
    try {
      const selected: SelectedUpload[] = [];
      for (const file of Array.from(fileList)) {
        if (file.size > MAX_FILE_BYTES) throw new Error(t("library.import.fileTooLarge", { max: "12 MB" }));
        const encoded = bytesToBase64(await file.arrayBuffer());
        selected.push({
          id: crypto.randomUUID(),
          size: file.size,
          upload: { provider, fileName: file.name, contentBase64: encoded },
        });
      }
      const newTotal = uploads.reduce((sum, item) => sum + item.size, 0) + selected.reduce((sum, item) => sum + item.size, 0);
      if (newTotal > MAX_BATCH_BYTES) throw new Error(t("library.import.batchTooLarge", { max: "24 MB" }));
      setUploads((current) => [...current, ...selected]);
    } catch (cause) {
      setError(importFailureMessage(cause, t("library.import.readFailed")));
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    if (!uploads.length && !steamId.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await prepareImport({
        schemaVersion: IMPORT_CONTRACT_VERSION,
        uploads: uploads.map(({ upload }) => upload),
        ...(steamId.trim() ? { steam: { steamId: steamId.trim(), includePlayedFreeGames } } : {}),
      });
      setPreview(result);
      const initialPlans = makeInitialPlans(result, state);
      setPlans(initialPlans);
      setCategoryDefaults(Object.fromEntries(result.sources.map((source) => [source.provider, result.rows.find((row) => row.provider === source.provider)?.suggestedMediaTypeId ?? null])));
      setPriority([...new Set(result.rows.map((row) => row.provider))].sort((a, b) => a.localeCompare(b)));
      setRatingMode("manual");
      setTagMode("none");
      setCommitResult(null);
      setUndoDone(false);
      setReviewSourceReviews(false);
      setOverwriteLocalReviews(false);
      setAutomaticBatchMatchRows(new Set());
      setBatchLookupSummary(null);
      setCommitProgress(null);
      const initialGroups = buildGroups(result.rows, initialPlans);
      setRatingChoices(Object.fromEntries(initialGroups.map((group) => {
        const existing = existingForGroup(group.rows, initialPlans, state);
        const plan = initialPlans[group.rootId];
        const choice = initialRatingChoice(group, existing, plan);
        return [group.rootId, choice];
      })));
      setStep("categories");
    } catch (cause) {
      setError(importFailureMessage(cause, t("library.import.prepareFailed")));
    } finally {
      setBusy(false);
    }
  };

  const updatePlan = (rowId: string, patch: Partial<RowPlan>) => {
    setPlans((current) => ({ ...current, [rowId]: { ...current[rowId], ...patch } }));
  };
  const selectCatalogMatch = (row: ImportSourceRow, result: CatalogSearchResult) => {
    const root = resolveRowRoot(row.rowId, plans);
    const groupRowIds = rows.filter((item) => resolveRowRoot(item.rowId, plans) === root).map((item) => item.rowId);
    setCatalogSelections((current) => {
      const next = { ...current };
      groupRowIds.forEach((rowId) => delete next[rowId]);
      next[row.rowId] = result;
      return next;
    });
    setAutomaticBatchMatchRows((current) => {
      const next = new Set(current);
      groupRowIds.forEach((rowId) => next.delete(rowId));
      return next;
    });
    setCatalogCoverSelections((current) => ({ ...current, [row.rowId]: true }));

    const owners = catalogIdentityOwners(result, state.entries);
    if (owners.length !== 1 || explicitSeparateRows.has(row.rowId) || plans[row.rowId]?.action !== "create") return;
    const owner = owners[0];
    const linkedPlan = {
      ...plans[row.rowId],
      action: "link" as const,
      targetEntryId: owner.id,
      mergeIntoRowId: null,
      disposition: bulkStatus ? plans[row.rowId].disposition : owner.disposition,
    };
    setPlans((current) => current[row.rowId]?.action === "create"
      ? { ...current, [row.rowId]: linkedPlan }
      : current);
    const groupRows = rows.filter((item) => resolveRowRoot(item.rowId, plans) === row.rowId);
    const rootId = row.rowId;
    setRatingChoices((current) => ({
      ...current,
      [rootId]: initialRatingChoice({ rows: groupRows.length ? groupRows : [row] }, owner, linkedPlan),
    }));
    setManualSelections((current) => { const next = { ...current }; delete next[rootId]; return next; });
    setManualRatings((current) => { const next = { ...current }; delete next[rootId]; return next; });
  };
  const applyCategoryDefault = (provider: string, value: string) => {
    const mediaTypeId = value || null;
    setCategoryDefaults((current) => ({ ...current, [provider]: mediaTypeId }));
    setPlans((current) => Object.fromEntries(Object.entries(current).map(([rowId, plan]) => {
      const row = rows.find((item) => item.rowId === rowId);
      return [rowId, row?.provider === provider ? { ...plan, mediaTypeId } : plan];
    })));
  };
  const updateChoice = (row: ImportSourceRow, value: string) => {
    if (value === "separate") {
      setExplicitSeparateRows((current) => new Set(current).add(row.rowId));
      updatePlan(row.rowId, { action: "create", targetEntryId: null, mergeIntoRowId: null });
    } else if (value === "skip") {
      setExplicitSeparateRows((current) => { const next = new Set(current); next.delete(row.rowId); return next; });
      updatePlan(row.rowId, { action: "skip", targetEntryId: null, mergeIntoRowId: null });
    } else if (value.startsWith("entry:")) {
      setExplicitSeparateRows((current) => { const next = new Set(current); next.delete(row.rowId); return next; });
      updatePlan(row.rowId, { action: "link", targetEntryId: value.slice(6), mergeIntoRowId: null });
    } else if (value.startsWith("row:")) {
      setExplicitSeparateRows((current) => { const next = new Set(current); next.delete(row.rowId); return next; });
      updatePlan(row.rowId, { action: "merge", targetEntryId: null, mergeIntoRowId: value.slice(4) });
    }
  };
  const addNewTag = () => {
    const value = tagText.trim();
    if (!value || newTagNames.some((name) => name.toLocaleLowerCase() === value.toLocaleLowerCase())) return;
    setNewTagNames((current) => [...current, value]);
    setTagText("");
    setTagMode("batch");
  };
  const toggleBatchTag = (tagId: string) => setBatchTagIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]);
  const updateTagMap = (key: string, plan: SourceTagPlan) => setSourceTagPlans((current) => ({ ...current, [key]: plan }));

  const findCatalogMatchesByIds = async () => {
    lookupCancelled.current = false;
    setBatchLookupBusy(true);
    setError("");
    setBatchLookupSummary({ checked: 0, withResults: 0, capped: false, unsupported: 0 });
    let checked = 0;
    let found = 0;
    let unsupported = 0;
    let failed = 0;
    let partialWarnings = 0;
    try {
      for (const group of groups) {
        if (lookupCancelled.current) break;
        const startedAt = Date.now();
        const row = group.rows.find((item) => item.rowId === group.rootId) ?? group.rows[0];
        const mediaTypeId = plans[group.rootId]?.mediaTypeId ?? null;
        const selectedCapability = lookupProviders.find((item) => item.provider === selectedLookupProvider);
        if (mediaTypeId && !selectedCapability?.mediaTypeIds.includes(mediaTypeId)) {
          unsupported++;
          checked++;
          setBatchLookupSummary({ checked, withResults: found, capped: false, unsupported });
          continue;
        }
        const lookup = catalogLookupForRow(row);
        try {
          const response = await searchCatalog({
            query: row.originalTitle || row.title,
            mediaTypeId,
            providers: [selectedLookupProvider], year: row.year, page: null,
            ...(lookup && ((lookup.provider === "imdb" && selectedLookupProvider === "tmdb") || (lookup.provider === "isbn" && ["openLibrary", "googleBooks"].includes(selectedLookupProvider)))
              ? { externalId: lookup.externalId, externalIdProvider: lookup.provider } : {}),
          });
          if (response.warnings?.length) partialWarnings += response.warnings.length;
          if (lookupCancelled.current) break;
          const first = response.results[0];
          if (first) {
            found++;
            setBatchLookupCandidates((current) => ({ ...current, [row.rowId]: [first] }));
            setCatalogSelections((current) => {
              const next = { ...current };
              group.rows.forEach((item) => delete next[item.rowId]);
              next[row.rowId] = first;
              return next;
            });
            setAutomaticBatchMatchRows((current) => new Set(current).add(row.rowId));
            setCatalogCoverSelections((current) => ({ ...current, [row.rowId]: true }));
          }
        } catch { failed++; }
        checked++;
        setBatchLookupSummary({ checked, withResults: found, capped: false, unsupported });
        const remaining = 1000 - (Date.now() - startedAt);
        if (remaining > 0 && !lookupCancelled.current) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      }
      const messages = [
        failed ? t("library.import.lookupFailures", { count: failed }) : "",
        partialWarnings ? t("library.import.lookupPartialWarnings") : "",
        unsupported ? t("library.import.lookupSkippedUnsupported", { count: unsupported }) : "",
      ].filter(Boolean);
      if (messages.length) setError(messages.join(" "));
    } finally { setBatchLookupBusy(false); }
  };

  const updateRatingSelection = (groupId: string, sourceRowId: string | null, accepted: boolean, overwrite = false) => {
    setRatingChoices((current) => ({ ...current, [groupId]: { sourceRowId, accepted, overwrite } }));
  };
  const calculatePolicyChoices = (mode: ImportRatingPolicy["mode"], priorityOrder: string[]) => {
    if (mode === "preserveOnly") return Object.fromEntries(groups.map((group) => [group.rootId, { sourceRowId: null, accepted: false, overwrite: false }]));
    if (mode === "manual") return Object.fromEntries(groups.map((group) => {
      const existing = existingForGroup(group.rows, plans, state);
      return [group.rootId, initialRatingChoice(group, existing, plans[group.rootId])];
    }));
    const next: Record<string, { sourceRowId: string | null; accepted: boolean; overwrite: boolean }> = {};
    for (const group of groups) {
      const existing = existingForGroup(group.rows, plans, state);
      if (existing?.overallRating !== null && existing) {
        next[group.rootId] = { sourceRowId: null, accepted: false, overwrite: false };
        continue;
      }
      if (mode === "priority") {
        const available = group.rows.filter((row) => row.sourceRating && normalizeScore(row.sourceRating.value, row.sourceRating.scale) !== null);
        const provider = priorityOrder.find((name) => available.some((row) => row.provider === name));
        const candidates = available.filter((row) => row.provider === provider);
        const normalized = new Set(candidates.map((row) => normalizeScore(row.sourceRating!.value, row.sourceRating!.scale)));
        next[group.rootId] = candidates.length && normalized.size === 1 && plans[group.rootId]?.disposition === "experienced"
          ? { sourceRowId: candidates[0].rowId, accepted: true, overwrite: false }
          : { sourceRowId: null, accepted: false, overwrite: false };
        continue;
      }
      const dated = group.rows
        .filter((row) => row.sourceRating)
        .map((row) => ({ row, date: comparableDateValue(row), normalized: normalizeScore(row.sourceRating!.value, row.sourceRating!.scale) }));
      if (dated.length > 1 && dated.every((item) => item.date !== null && item.normalized !== null)) {
        const latestDate = Math.max(...dated.map((item) => item.date!));
        const latest = dated.filter((item) => item.date === latestDate);
        const tiedScores = new Set(latest.map((item) => item.normalized));
        next[group.rootId] = tiedScores.size === 1 && plans[group.rootId]?.disposition === "experienced"
          ? { sourceRowId: latest[0].row.rowId, accepted: true, overwrite: false }
          : { sourceRowId: null, accepted: false, overwrite: false };
      } else next[group.rootId] = { sourceRowId: null, accepted: false, overwrite: false };
    }
    return next;
  };
  const setBatchRatingPolicy = (mode: ImportRatingPolicy["mode"]) => {
    setRatingMode(mode);
    setManualSelections({});
    setManualRatings({});
    const choices = calculatePolicyChoices(mode, priority);
    if (choices) setRatingChoices(choices);
  };
  const movePriority = (index: number, direction: -1 | 1) => {
    const next = [...priority];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setPriority(next);
    if (ratingMode === "priority") {
      const choices = calculatePolicyChoices("priority", next);
      if (choices) setRatingChoices(choices);
    }
  };

  const checkStep = (currentStep: Step): string | null => {
    if (!preview) return t("library.import.prepareFirst");
    if (currentStep === "categories") {
      const included = rows.filter((row) => plans[row.rowId]?.action !== "skip");
      if (included.some((row) => !plans[row.rowId]?.mediaTypeId)) return t("library.import.chooseCategoryEach");
      if (tagMode === null) return t("library.import.chooseTagMode");
    }
    if (currentStep === "matches") {
      const groupsById = buildGroups(rows, plans);
      for (const group of groupsById) {
        const choices = group.rows.map((row) => plans[row.rowId]);
        if (new Set(choices.map((item) => item.mediaTypeId)).size > 1) return t("library.import.groupCategoryConflict");
        if (new Set(choices.map((item) => item.disposition)).size > 1) return t("library.import.groupStatusConflict");
      }
    }
    if (currentStep === "ratings") {
      for (const group of groups) {
        const ratingRows = group.rows.filter((row) => row.sourceRating);
        if (ratingRows.length < 2 || plans[group.rootId]?.disposition !== "experienced") continue;
        const existing = existingForGroup(group.rows, plans, state);
        if (existing?.overallRating !== null && existing) continue;
        const normalized = ratingRows.map((row) => normalizeScore(row.sourceRating!.value, row.sourceRating!.scale));
        const isConflict = new Set(normalized.filter((value): value is number => value !== null)).size > 1 || normalized.some((value) => value === null);
        const explicitChoice = ratingMode === "preserveOnly" || Boolean(manualSelections[group.rootId]) || Boolean(manualRatings[group.rootId]) || ratingChoices[group.rootId]?.accepted;
        if (isConflict && !explicitChoice) return t("library.import.resolveRatingConflict");
      }
    }
    return null;
  };

  const makeDecisions = (): ImportDecision[] => {
    if (!preview) return [];
    const decisions: ImportDecision[] = [];
    const groupedRowIds = new Set<string>();
    const seenCatalogIdentityKeys = new Set<string>();
    for (const row of rows) {
      if (groupedRowIds.has(row.rowId)) continue;
      const plan = plans[row.rowId];
      if (!plan || plan.action === "skip") {
        decisions.push({ rowIds: [row.rowId], action: "skip", disposition: null });
        groupedRowIds.add(row.rowId);
        continue;
      }
      const groupRoot = resolveRowRoot(row.rowId, plans);
      const group = groups.find((item) => item.rootId === groupRoot)?.rows ?? [row];
      const rowIds = group.map((item) => item.rowId);
      rowIds.forEach((id) => groupedRowIds.add(id));
      const rootPlan = plans[groupRoot] ?? plan;
      const linkedTarget = group.map((item) => plans[item.rowId]?.targetEntryId).find(Boolean) ?? null;
      const action = linkedTarget ? "link" : "create";
      const tagMappings = group.flatMap((item) => {
        if (!item.tags.length || tagMode !== "source") return [];
        return item.tags.map((tag) => {
          const map = sourceTagPlans[`${item.provider}\0${tag}`] ?? { action: "ignore" as const };
          return { rowId: item.rowId, sourceTag: tag, ...map };
        });
      });
      const preserveThisGroup = manualRatings[groupRoot] === "none";
      const ratings = group.filter((item) => item.sourceRating).map((item) => ({
        sourceRowId: item.rowId,
        acceptNative: rootPlan.disposition === "experienced" && ratingMode !== "preserveOnly" && !preserveThisGroup && ratingChoices[groupRoot]?.accepted === true && ratingChoices[groupRoot]?.sourceRowId === item.rowId,
        ...(ratingChoices[groupRoot]?.overwrite ? { overwriteExistingRating: true } : {}),
      }));
      const manual = ratingMode === "preserveOnly" || rootPlan.disposition !== "experienced" ? undefined : manualSelections[groupRoot];
      const manualRatingValue = manualRatings[groupRoot];
      const manualOverallRating = rootPlan.disposition === "experienced" && manualRatingValue && manualRatingValue !== "none" && Number.isFinite(Number(manualRatingValue))
        ? Number(manualRatingValue)
        : null;
      const tagsEnabled = tagMode === "batch" && group.some((item) => plans[item.rowId]?.applyBatchTags);
      const enrichmentRow = group.find((item) => catalogSelections[item.rowId]);
      const catalogResult = enrichmentRow ? catalogSelections[enrichmentRow.rowId] : null;
      const isAutomaticMalMatch = Boolean(enrichmentRow && catalogResult &&
        enrichmentRow.provider === "myAnimeList" && catalogResult.provider === "tmdb" &&
        automaticBatchMatchRows.has(enrichmentRow.rowId));
      const enrichments = enrichmentRow && catalogResult ? [{
        sourceRowId: enrichmentRow.rowId,
        title: isAutomaticMalMatch ? enrichmentRow.title : catalogResult.title,
        releaseDate: catalogResult.year ? { year: catalogResult.year, precision: "year" as const } : null,
        externalIdentities: catalogResult.identities.filter((identity) => {
          const key = catalogIdentityKey(identity);
          const owners = catalogIdentityOwners({ identities: [identity] }, state.entries);
          const conflictingOwner = owners.some((entry) => entry.id !== linkedTarget);
          const duplicateEarlierInBatch = seenCatalogIdentityKeys.has(key);
          seenCatalogIdentityKeys.add(key);
          return !conflictingOwner && !duplicateEarlierInBatch;
        }),
        remoteCover: (catalogCoverSelections[enrichmentRow.rowId] ?? true) && catalogResult.coverMode === "persistReference" ? catalogResult.remoteCover : null,
        ...(!linkedTarget ? { overwriteExistingMetadata: true } : {}),
      }] : [];
      decisions.push({
        rowIds,
        action,
        ...(linkedTarget ? { targetEntryId: linkedTarget } : {}),
        ...(action === "create" ? { title: enrichments[0]?.title ?? (plans[groupRoot]?.action === "merge" ? group.find((item) => item.rowId === groupRoot)?.title ?? row.title : row.title) } : {}),
        mediaTypeId: rootPlan.mediaTypeId,
        disposition: rootPlan.disposition,
        ...(bulkStatus ? { overwriteExistingDisposition: true } : {}),
        importReviews: reviewSourceReviews,
        overwriteExistingReview: reviewSourceReviews && overwriteLocalReviews,
        ...(tagsEnabled ? { tagIds: batchTagIds, newTagNames } : { tagIds: [], newTagNames: [] }),
        ...(manualOverallRating !== null ? { manualOverallRating } : {}),
        ...(manual ? { ratingSelections: group.filter((item) => item.sourceRating).map((item) => ({ sourceRowId: item.rowId, acceptNative: item.rowId === manual, ...(ratingChoices[groupRoot]?.overwrite ? { overwriteExistingRating: true } : {}) })) } : { ratingSelections: ratings }),
        ...(tagMappings.length ? { tagMappings } : {}),
        ...(enrichments.length ? { enrichments } : {}),
      });
    }
    return decisions;
  };

  const commit = async () => {
    if (!preview) return;
    const invalidStep = checkStep("categories") ?? checkStep("matches") ?? checkStep("ratings");
    if (invalidStep) { setError(invalidStep); return; }
    setBusy(true);
    setError("");
    const decisions = makeDecisions();
    const works = decisions.filter((decision) => decision.action !== "skip").length;
    const covers = decisions.reduce((count, decision) => {
      if (decision.action === "skip") return count;
      const target = decision.targetEntryId ? state.entries.find((entry) => entry.id === decision.targetEntryId) : null;
      return count + (decision.enrichments ?? []).filter((enrichment) => Boolean(enrichment.remoteCover) &&
        (decision.action !== "link" || enrichment.overwriteExistingMetadata || !target?.coverAssetId)).length;
    }, 0);
    setCommitProgress({ works, covers });
    try {
      const input: ImportCommitInput = {
        schemaVersion: IMPORT_CONTRACT_VERSION,
        sessionId: preview.sessionId,
        expectedRevision: preview.expectedRevision,
        decisions,
        ratingPolicy: {
          mode: ratingMode,
          priority,
          manualSelections: Object.entries(manualSelections).flatMap(([rootId, sourceRowId]) => {
            const group = groups.find((item) => item.rootId === rootId);
            return group ? [{ rowIds: group.rows.map((row) => row.rowId), sourceRowId }] : [];
          }),
        },
      };
      const result = await commitImport(input);
      await onCommitLibrary(result.library);
      setCommitResult(result);
      setUndoDone(false);
    } catch (cause) {
      setError(importFailureMessage(cause, t("library.import.commitFailed")));
    } finally {
      setCommitProgress(null);
      setBusy(false);
    }
  };

  const close = () => {
    if (preview?.sessionId && !commitResult) void cancelImport(preview.sessionId).catch(() => undefined);
    lookupCancelled.current = true;
    onClose();
  };

  const undo = async () => {
    if (!commitResult || undoDone) return;
    setBusy(true);
    setError("");
    try {
      const result = await undoImportBatch(commitResult.batchId, state.revision);
      await onCommitLibrary(result.library);
      setUndoDone(true);
    } catch (cause) {
      setError(importFailureMessage(cause, t("library.import.undoFailed")));
    } finally {
      setBusy(false);
    }
  };

  const retryCover = async (failure: ImportCommitResult["coverFailures"][number]) => {
    if (!commitResult || busy) return;
    setBusy(true);
    setCoverRetryErrors((current) => { const next = { ...current }; delete next[failure.sourceRowId]; return next; });
    try {
      const library = await retryImportCover(commitResult.library.revision, commitResult.batchId, failure.entryId, failure.provider, failure.url);
      await onCommitLibrary(library);
      setCommitResult((current) => current ? {
        ...current,
        library,
        coverFailures: current.coverFailures.filter((item) => item.sourceRowId !== failure.sourceRowId),
      } : current);
    } catch {
      setCoverRetryErrors((current) => ({ ...current, [failure.sourceRowId]: t("library.import.coverRetryFailed") }));
    } finally {
      setBusy(false);
    }
  };

  const dismissCoverFailure = (sourceRowId: string) => {
    setCommitResult((current) => current ? {
      ...current,
      coverFailures: current.coverFailures.filter((item) => item.sourceRowId !== sourceRowId),
    } : current);
    setCoverRetryErrors((current) => { const next = { ...current }; delete next[sourceRowId]; return next; });
  };

  const stepTitle = t(`library.import.step.${step}`);
  const doneCount = groups.length;
  const skippedCount = rows.filter((row) => plans[row.rowId]?.action === "skip").length;
  const catalogRow = catalogRowId ? rows.find((row) => row.rowId === catalogRowId) ?? null : null;
  const catalogLookup = catalogRow ? catalogLookupForRow(catalogRow) : null;

  return (
    <>
    <Modal
      title={t("library.import.title")}
      description={t("library.import.description")}
      onClose={close}
      busy={busy}
      dirty={!commitResult && (uploads.length > 0 || Boolean(preview))}
      wide
    >
      <div className="import-wizard" data-testid="import-wizard">
        {!commitResult && <ol className="import-stepper" aria-label={t("library.import.steps")}>
          {stepOrder.map((item, index) => (
            <li key={item} className={index === stepIndex ? "active" : index < stepIndex ? "complete" : ""}>
              <span>{index < stepIndex ? <Check size={13} /> : index + 1}</span>
              <small>{t(`library.import.step.${item}`)}</small>
            </li>
          ))}
        </ol>}
        <div className="import-wizard-body" data-testid={commitResult ? "import-receipt-step" : `import-${step}-step`} data-import-step={commitResult ? "receipt" : step}>
          {commitResult ? (
            <div className="import-receipt" data-testid="import-receipt" role="status">
              <div className="import-receipt-icon"><Check size={22} /></div>
              <h3>{undoDone ? t("library.import.undoComplete") : t("library.import.complete")}</h3>
              <p>{undoDone ? t("library.import.undoCompleteHint") : t("library.import.completeHint")}</p>
              <div className="import-final-counts"><span>{t("library.import.newWorks", { count: commitResult.created })}</span><span>{t("library.import.linkedWorks", { count: commitResult.linked })}</span><span>{t("library.import.skippedRows", { count: commitResult.skipped })}</span></div>
              {!undoDone && commitResult.coverFailures.length > 0 && <section className="import-cover-failures" aria-label={t("library.import.coverFailureHeading", { count: commitResult.coverFailures.length })}>
                <h4>{t("library.import.coverFailureHeading", { count: commitResult.coverFailures.length })}</h4>
                <p>{t("library.import.coverFailureHint")}</p>
                {commitResult.coverFailures.map((failure) => <article key={failure.sourceRowId}>
                  <div><strong>{failure.title}</strong><small>{failure.message}</small>{coverRetryErrors[failure.sourceRowId] && <small role="alert" className="import-row-warning">{coverRetryErrors[failure.sourceRowId]}</small>}</div>
                  <button type="button" className="button secondary" disabled={busy} onClick={() => void retryCover(failure)}>{busy ? t("library.import.coverRetrying") : t("library.import.retryCover")}</button>
                  <button type="button" className="text-button" disabled={busy} onClick={() => dismissCoverFailure(failure.sourceRowId)}>{t("library.import.skipCover")}</button>
                </article>)}
              </section>}
              {!undoDone && !commitResult.batchId.startsWith("preview-") && <p className="field-hint">{t("library.import.undoHint")}</p>}
            </div>
          ) : <>
          <div className="import-step-heading"><h3>{stepTitle}</h3>{preview && <span>{t("library.import.reviewCounts", { works: doneCount, rows: rows.length, skipped: skippedCount })}</span>}</div>
          {step === "sources" && (
            <div className="import-source-step">
              <p className="import-step-copy">{t("library.import.sourcesIntro")}</p>
              <div className="import-source-list">
                {importSources.map((source) => (
                  <FileSourceCard key={source.provider} {...source} files={uploads} busy={busy} onFiles={setFiles} />
                ))}
              </div>
              <div className="import-limit-note">{t("library.import.fileLimits", { file: "12 MB", batch: "24 MB" })} {formatBytes(totalBytes)} / 24 MB</div>
              {uploads.length > 0 && <div className="import-selected-files">
                {uploads.map(({ id, upload }) => <div key={id}><span>{providerLabel(upload.provider)} · {upload.fileName}</span><button type="button" aria-label={t("library.import.removeFile", { name: upload.fileName })} onClick={() => setUploads((current) => current.filter((item) => item.id !== id))}><X size={13} /></button></div>)}
              </div>}
              {steamCapability && (
                <section className="import-steam-setup">
                  <div><strong>{t("library.import.steamTitle")}</strong><small>{t("library.import.steamDisclosure")}</small></div>
                  <label className="field"><span>{t("library.import.steamId")}</span><input value={steamId} onChange={(event) => setSteamId(event.target.value)} placeholder={t("library.import.steamIdHint")} /></label>
                  <label className="import-checkbox"><input type="checkbox" checked={includePlayedFreeGames} onChange={(event) => setIncludePlayedFreeGames(event.target.checked)} />{t("library.import.includeFreeGames")}</label>
                </section>
              )}
              {preview?.warnings.map((warning) => <p key={warning} className="import-warning"><AlertTriangle size={14} />{warning}</p>)}
            </div>
          )}

          {step === "categories" && preview && (
            <div className="import-category-step">
              <p className="import-step-copy">{t("library.import.categoryIntro")}</p>
              <label className="field"><span>{t("library.import.batchStatus")}</span><SelectControl value={bulkStatus} onValueChange={(value) => {
                setBulkStatus(value);
                if (value) setPlans((current) => Object.fromEntries(Object.entries(current).map(([id, plan]) => [id, { ...plan, disposition: value as Entry["disposition"] }])));
                else if (preview) {
                  const defaults = makeInitialPlans(preview, state);
                  setPlans((current) => Object.fromEntries(Object.entries(current).map(([id, plan]) => [id, { ...plan, disposition: defaults[id]?.disposition ?? plan.disposition }])));
                }
              }}><option value="">{t("library.import.keepSourceStatus")}</option><option value="experienced">{t("library.ui.alreadyExperienced")}</option><option value="planned">{t("library.ui.group.planned")}</option><option value="dropped">{t("library.ui.group.dropped")}</option></SelectControl></label>
              <div className="import-provider-defaults">
                {preview.sources.map((source) => (
                  <label className="field" key={source.provider}>
                    <span>{t("library.import.defaultCategory", { provider: providerLabel(source.provider) })}</span>
                    <MediaTypeSelect value={categoryDefaults[source.provider] ?? ""} state={state} onChange={(value) => applyCategoryDefault(source.provider, value)} />
                  </label>
                ))}
              </div>
              <div className="import-row-list">
                {rows.map((row) => (
                  <article key={row.rowId} className="import-row-card" data-testid={`import-source-row-${row.rowId}`}>
                    <div className="import-row-title"><strong>{row.title}</strong><span>{[providerLabel(row.provider), row.year, row.providerMediaType].filter(Boolean).join(" · ")}</span>{row.originalTitle && <small>{row.originalTitle}</small>}</div>
                    <label className="field"><span>{t("library.import.rowCategory")}</span><MediaTypeSelect value={plans[row.rowId]?.mediaTypeId ?? ""} state={state} onChange={(value) => updatePlan(row.rowId, { mediaTypeId: value || null })} /></label>
                    {tagMode === "batch" && <label className="import-checkbox import-row-tag-choice"><input type="checkbox" checked={plans[row.rowId]?.applyBatchTags ?? true} onChange={(event) => updatePlan(row.rowId, { applyBatchTags: event.target.checked })} />{t("library.import.applyBatchTagsToRow")}</label>}
                  </article>
                ))}
              </div>
              <div className="import-tag-step">
                <h4>{t("library.import.tagsHeading")}</h4>
                <p>{t("library.import.tagsIntro")}</p>
                <div className="import-choice-row">
                  <label><input type="radio" name="import-tag-mode" checked={tagMode === "none"} onChange={() => setTagMode("none")} />{t("library.import.noTags")}</label>
                  <label><input type="radio" name="import-tag-mode" checked={tagMode === "batch"} onChange={() => setTagMode("batch")} />{t("library.import.batchTags")}</label>
                  {sourceTags.length > 0 && <label><input type="radio" name="import-tag-mode" checked={tagMode === "source"} onChange={() => setTagMode("source")} />{t("library.import.mapSourceTags")}</label>}
                </div>
                {tagMode === "batch" && <div className="import-batch-tags">
                  {state.tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={batchTagIds.includes(tag.id)} onChange={() => toggleBatchTag(tag.id)} />{tag.name}</label>)}
                  <div className="import-new-tag"><input value={tagText} maxLength={100} onChange={(event) => setTagText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addNewTag(); } }} placeholder={t("library.import.newTagPlaceholder")} /><button className="button secondary" type="button" onClick={addNewTag} disabled={!tagText.trim()}>{t("library.import.createTag")}</button></div>
                  {newTagNames.map((name) => <button key={name} type="button" className="import-new-tag-pill" onClick={() => setNewTagNames((current) => current.filter((item) => item !== name))}>{name} <X size={11} /></button>)}
                </div>}
                {tagMode === "source" && <div className="import-source-tag-map">
                  {sourceTags.map(({ key, provider, tag }) => {
                    const plan = sourceTagPlans[key] ?? { action: "ignore" as const };
                    return <div key={key}><span>{providerLabel(provider)} · {tag}</span><select value={plan.action === "existing" ? `existing:${plan.tagId}` : plan.action === "create" ? `create:${plan.newTagName}` : "ignore"} onChange={(event) => {
                      const value = event.target.value;
                      if (value === "ignore") updateTagMap(key, { action: "ignore" });
                      else if (value.startsWith("existing:")) updateTagMap(key, { action: "existing", tagId: value.slice(9) });
                      else if (value.startsWith("create:")) updateTagMap(key, { action: "create", newTagName: value.slice(7) });
                    }}><option value="ignore">{t("library.import.ignoreSourceTag")}</option>{state.tags.map((item) => <option key={item.id} value={`existing:${item.id}`}>{t("library.import.mapToTag", { name: item.name })}</option>)}<option value={`create:${tag}`}>{t("library.import.createMappedTag", { name: tag })}</option></select></div>;
                  })}
                </div>}
              </div>
            </div>
          )}

          {step === "matches" && preview && (
            <div className="import-match-step">
              <p className="import-step-copy">{t("library.import.matchIntro")}</p>
              <div className="import-id-lookup">
                <label className="field"><span>{t("library.import.lookupCatalog")}</span><SelectControl value={selectedLookupProvider} disabled={batchLookupBusy} onValueChange={(value) => { setBulkProvider(value); rememberCatalogProvider(value); }}>{lookupProviders.map((item) => <option key={item.provider} value={item.provider}>{item.label}</option>)}</SelectControl></label>
                <button type="button" className="button secondary" disabled={!lookupProviders.some((item) => item.provider === selectedLookupProvider) || batchLookupBusy} onClick={() => void findCatalogMatchesByIds()}>
                  <Search size={14} />{batchLookupBusy ? t("library.import.findingIds") : t("library.import.findByIds")}
                </button>
                {batchLookupBusy && <button type="button" className="text-button" onClick={() => { lookupCancelled.current = true; }}>{t("library.import.stopLookup")}</button>}
                <p className="field-hint">{t("library.import.lookupHint")}</p>
                {batchLookupSummary && <span>{t("library.import.idLookupSummary", { checked: batchLookupSummary.checked, found: batchLookupSummary.withResults })}{batchLookupSummary.capped ? ` ${t("library.import.idLookupLimit", { max: 100 })}` : ""}{batchLookupSummary.unsupported ? ` ${t("library.import.lookupSkippedUnsupported", { count: batchLookupSummary.unsupported })}` : ""}</span>}
              </div>
              <div className="import-match-list">
                {rows.map((row) => {
                  const plan = plans[row.rowId];
                  const options = row.candidates.filter((candidate) => candidate.entryId || candidate.sourceRowId);
                  const choice = plan.action === "skip" ? "skip" : plan.action === "merge" ? `row:${plan.mergeIntoRowId}` : plan.action === "link" ? `entry:${plan.targetEntryId}` : "separate";
                  return <article key={row.rowId} className={`import-match-card ${plan.action === "skip" ? "skipped" : ""}`}>
                    <div><strong>{row.title}</strong><span>{[providerLabel(row.provider), row.year, row.externalId].filter(Boolean).join(" · ")}</span>
                      {row.progress && <small>{t("library.import.progress", { current: row.progress.current, unit: row.progress.unit, total: row.progress.total === null ? "" : ` / ${row.progress.total}` })}</small>}
                      {row.warnings.map((warning) => <small className="import-row-warning" key={warning}><AlertTriangle size={12} />{warning}</small>)}
                    </div>
                    {(batchLookupCandidates[row.rowId] ?? []).map((candidate) => <div className="import-id-candidate" key={`${candidate.provider}:${candidate.mediaType}:${candidate.id}`}>
                      {candidate.coverUrl && <img src={candidate.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" decoding="async" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />}
                      <span>{candidate.title}{candidate.year ? ` · ${candidate.year}` : ""} · {candidate.provider}</span>
                      <button type="button" className="text-button" onClick={() => { selectCatalogMatch(row, candidate); setCatalogRowId(row.rowId); }}>{t("library.import.useExactCatalogMatch")}</button>
                    </div>)}
                    <button type="button" className="text-button import-enrich-toggle" data-testid={`import-enrich-${row.rowId}`} aria-haspopup="dialog" aria-expanded={catalogRowId === row.rowId} onClick={() => setCatalogRowId((current) => current === row.rowId ? null : row.rowId)}>
                      {catalogSelections[row.rowId] ? t("library.import.enrichmentSelected", { title: catalogSelections[row.rowId].title }) : t("library.import.enrichFromCatalog")}
                    </button>
                    {catalogSelections[row.rowId] && (() => {
                      const selected = catalogSelections[row.rowId];
                      const owners = catalogIdentityOwners(selected, state.entries);
                      const owner = owners.length === 1 ? owners[0] : null;
                      const sharedRows = rows.filter((other) => other.rowId !== row.rowId &&
                        resolveRowRoot(other.rowId, plans) !== resolveRowRoot(row.rowId, plans) &&
                        catalogSelections[other.rowId] && sharedCatalogIdentity(selected, catalogSelections[other.rowId]));
                      const conflictingOwners = owners.filter((item) => item.id !== plan.targetEntryId);
                      return <>
                        {owner && plan.action === "link" && plan.targetEntryId === owner.id && <small className="import-catalog-overlap" role="status">{t("library.import.enrichmentLinkedExisting", { title: owner.title })}</small>}
                        {conflictingOwners.length > 0 && plan.action === "create" && <small className="import-row-warning import-catalog-overlap" role="status">{t("library.import.enrichmentIdOmittedForSeparate", { title: conflictingOwners[0].title })}</small>}
                        {owners.length > 1 && <small className="import-row-warning import-catalog-overlap" role="status">{t("library.import.enrichmentOwnerAmbiguous")}</small>}
                        {sharedRows.map((other) => <small className="import-catalog-overlap" role="status" key={other.rowId}>
                          {t("library.import.catalogIdentityShared", { title: other.title })}{" "}
                          <button type="button" className="text-button" onClick={() => updateChoice(row, `row:${other.rowId}`)}>{t("library.import.combineCatalogMatches")}</button>
                        </small>)}
                      </>;
                    })()}
                    <label className="field"><span>{t("library.import.matchAction")}</span><select value={choice} onChange={(event) => updateChoice(row, event.target.value)}>
                      <option value="separate">{t("library.import.createSeparate")}</option>
                      {options.map((candidate, index) => <option value={candidateValue(candidate)} key={`${candidate.entryId ?? candidate.sourceRowId}:${index}`}>
                        {candidate.reason === "exact-id" ? t("library.import.exactMatch", { title: candidate.title }) : candidate.sourceRowId ? t("library.import.sameBatchMatch", { title: candidate.title }) : t("library.import.linkMatch", { title: candidate.title, year: candidate.year ?? "?" })}
                      </option>)}
                      {plan.action === "link" && plan.targetEntryId && !options.some((candidate) => candidate.entryId === plan.targetEntryId) && state.entries.find((entry) => entry.id === plan.targetEntryId) && <option value={`entry:${plan.targetEntryId}`}>{t("library.import.linkMatch", { title: state.entries.find((entry) => entry.id === plan.targetEntryId)!.title, year: state.entries.find((entry) => entry.id === plan.targetEntryId)!.releaseDate?.year ?? "?" })}</option>}
                      {plan.action === "merge" && plan.mergeIntoRowId && !options.some((candidate) => candidate.sourceRowId === plan.mergeIntoRowId) && rows.find((other) => other.rowId === plan.mergeIntoRowId) && <option value={`row:${plan.mergeIntoRowId}`}>{t("library.import.sameBatchMatch", { title: rows.find((other) => other.rowId === plan.mergeIntoRowId)!.title })}</option>}
                      {catalogSelections[row.rowId] && rows.filter((other) => other.rowId !== row.rowId && resolveRowRoot(other.rowId, plans) !== resolveRowRoot(row.rowId, plans) && catalogSelections[other.rowId] && sharedCatalogIdentity(catalogSelections[row.rowId], catalogSelections[other.rowId])).map((other) => <option key={`catalog-row:${other.rowId}`} value={`row:${other.rowId}`}>{t("library.import.sameBatchMatch", { title: other.title })}</option>)}
                      <option value="skip">{t("library.import.skipRow")}</option>
                    </select></label>
                    <label className="field"><span>{t("library.import.status")}</span><SelectControl value={plan.disposition} onValueChange={(value) => updatePlan(row.rowId, { disposition: value as Entry["disposition"] })}>
                      <option value="planned">{t("library.ui.group.planned")}</option><option value="experienced">{t("library.ui.alreadyExperienced")}</option><option value="dropped">{t("library.ui.group.dropped")}</option>
                    </SelectControl></label>
                    {row.sourceStatus && <small className="import-original-status">{t("library.import.sourceStatus", { status: row.sourceStatus })}</small>}
                    {Object.entries(row.sourceMetadata ?? {}).some(([, value]) => value) && <small className="import-original-status">{t("library.import.sourceMetadata", { values: Object.entries(row.sourceMetadata ?? {}).filter(([, value]) => value).map(([field, value]) => `${field.replace(/([A-Z])/g, " $1")}: ${value}`).join(" · ") })}</small>}
                    {row.sourceActivities.length > 0 && <small className="import-source-count">{t("library.import.activityCount", { count: row.sourceActivities.length })}</small>}
                    {Object.keys(row.sourceDates).length > 0 && <details className="import-source-date-fields"><summary>{t("library.import.sourceDateFields", { count: Object.keys(row.sourceDates).length })}</summary><dl>{Object.entries(row.sourceDates).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}</dl></details>}
                  </article>;
                })}
              </div>
              <div className="import-review-opt-in">
                {sourceReviewCount > 0 && <label className="import-checkbox"><input type="checkbox" checked={reviewSourceReviews} onChange={(event) => { setReviewSourceReviews(event.target.checked); if (!event.target.checked) setOverwriteLocalReviews(false); }} />{t("library.import.copyOwnReviews", { count: sourceReviewCount })}</label>}
                <span>{t("library.import.reviewPrivacy")}</span>
                {reviewSourceReviews && replaceableReviewCount > 0 && <label className="import-checkbox"><input type="checkbox" checked={overwriteLocalReviews} onChange={(event) => setOverwriteLocalReviews(event.target.checked)} />{t("library.import.replaceExistingReviews", { count: replaceableReviewCount })}</label>}
              </div>
            </div>
          )}

          {step === "ratings" && preview && (
            <div className="import-rating-step">
              <p className="import-step-copy">{t("library.import.ratingIntro")}</p>
              <div className="import-rating-policy">
                <label className="field"><span>{t("library.import.ratingPolicy")}</span><SelectControl value={ratingMode} onValueChange={(value) => setBatchRatingPolicy(value as ImportRatingPolicy["mode"])}>
                  <option value="manual">{t("library.import.ratingManual")}</option><option value="priority">{t("library.import.ratingPriority")}</option><option value="latestComparable" disabled={!anyComparableRatingDates}>{t("library.import.ratingLatest")}</option><option value="preserveOnly">{t("library.import.ratingPreserveOnly")}</option>
                </SelectControl></label>
                <p>{t("library.import.ratingPolicyHint")}</p>
                {ratingMode === "priority" && <ol className="import-priority-list">{priority.map((name, index) => <li key={name}><span>{providerLabel(name)}</span><button type="button" className="icon-button" disabled={index === 0} aria-label={t("library.import.movePriorityUp", { provider: providerLabel(name) })} onClick={() => movePriority(index, -1)}><ArrowUp size={13} /></button><button type="button" className="icon-button" disabled={index === priority.length - 1} aria-label={t("library.import.movePriorityDown", { provider: providerLabel(name) })} onClick={() => movePriority(index, 1)}><ArrowDown size={13} /></button></li>)}</ol>}
              </div>
              {groups.filter((group) => group.rows.some((row) => row.sourceRating)).map((group) => {
                const rootPlan = plans[group.rootId];
                const entry = existingForGroup(group.rows, plans, state);
                const ratingRows = group.rows.filter((row) => row.sourceRating);
                const values = ratingRows.map((row) => ({ row, normalized: normalizeScore(row.sourceRating!.value, row.sourceRating!.scale) }));
                const normalizedSet = new Set(values.map((value) => value.normalized).filter((value): value is number => value !== null));
                const conflict = normalizedSet.size > 1 || (values.length > 1 && values.some((item) => item.normalized === null));
                const ratingChoice = ratingChoices[group.rootId] ?? initialRatingChoice(group, entry, rootPlan);
                const proposal = values.find((item) => item.normalized !== null);
                const selectedManual = manualSelections[group.rootId] ?? "";
                const currentRating = entry?.overallRating ?? null;
                const canPromote = rootPlan?.disposition === "experienced";
                return <article key={group.rootId} className="import-rating-card">
                  <div className="import-row-title"><strong>{group.rows[0].title}</strong><span>{group.rows.map((row) => providerLabel(row.provider)).join(" · ")}</span></div>
                  <div className="import-source-ratings">
                  {values.map(({ row, normalized }) => <div key={row.rowId}>
                      <label><input type="radio" name={`rating-${group.rootId}`} disabled={!canPromote || normalized === null} checked={selectedManual ? selectedManual === row.rowId : ratingChoice.accepted && ratingChoice.sourceRowId === row.rowId} onChange={() => {
                        if (ratingMode === "preserveOnly") setRatingMode("manual");
                        setManualSelections((current) => ({ ...current, [group.rootId]: row.rowId }));
                        setManualRatings((current) => ({ ...current, [group.rootId]: "" }));
                        updateRatingSelection(group.rootId, row.rowId, true, false);
                      }} />
                        <span>{providerLabel(row.provider)}: {row.sourceRating!.value} ({row.sourceRating!.scale}){normalized !== null ? ` → ${normalized}/10` : ` · ${t("library.import.unknownScale")}`}</span>
                      </label>
                    </div>)}
                  </div>
                  {entry && currentRating !== null && <p className="import-local-score">{t("library.import.keepLocalScore", { score: currentRating })}</p>}
                  {conflict && <p className="import-row-warning"><AlertTriangle size={13} />{t("library.import.ratingConflict")}</p>}
                  {!canPromote && <p className="field-hint">{t("library.import.ratingNeedsExperienced")}</p>}
                  {ratingMode === "manual" && conflict && <label className="field"><span>{t("library.import.manualRating")}</span><SelectControl value={manualRatings[group.rootId] ?? ""} onValueChange={(value) => { setManualRatings((current) => ({ ...current, [group.rootId]: value })); setManualSelections((current) => { const next = { ...current }; delete next[group.rootId]; return next; }); updateRatingSelection(group.rootId, null, false, false); }}><option value="">{t("library.import.useSourceRating")}</option><option value="none">{t("library.import.preserveSourceOnly")}</option>{canPromote && Array.from({ length: 10 }, (_, index) => index + 1).map((score) => <option key={score} value={String(score)}>{t("library.import.manualScoreValue", { score })}</option>)}</SelectControl></label>}
                  <div className="import-score-proposal">
                    <label className="import-checkbox"><input type="checkbox" checked={ratingChoice.accepted && (currentRating === null || ratingChoice.overwrite)} disabled={!canPromote || ratingMode === "preserveOnly" || (!entry && !proposal)} onChange={(event) => updateRatingSelection(group.rootId, ratingChoice.sourceRowId ?? proposal?.row.rowId ?? null, event.target.checked, event.target.checked && currentRating !== null)} />
                      {currentRating !== null ? t("library.import.overwriteLocalScore", { score: currentRating }) : t("library.import.applyRatingProposal")}
                    </label>
                    {normalizedSet.size === 1 && proposal && <span>{t("library.import.consensusProposal", { score: proposal.normalized ?? 0, count: values.length })}</span>}
                  </div>
                  {group.rows.length > 1 && <small className="import-source-count">{t("library.import.originalRatingsPreserved", { count: values.length })}</small>}
                </article>;
              })}
              {!groups.some((group) => group.rows.some((row) => row.sourceRating)) && <p className="import-search-empty">{t("library.import.noPersonalRatings")}</p>}
              <p className="import-step-copy">{t("library.import.ratingDateCaveat")}</p>
            </div>
          )}

          {step === "confirm" && preview && (
            <div className="import-final-step">
              <p>{t("library.import.finalIntro")}</p>
              {busy && commitProgress && <p className="import-commit-progress" role="status">
                {commitProgress.covers > 0
                  ? t("library.import.commitProgressWithCovers", { works: commitProgress.works, covers: commitProgress.covers })
                  : t("library.import.commitProgressNoCovers", { works: commitProgress.works })}
              </p>}
              <ul className="import-summary-list">
                {preview.sources.map((source) => <li key={source.provider}><strong>{providerLabel(source.provider)}</strong><span>{source.sourceName} · {source.rowCount} rows</span></li>)}
              </ul>
              <div className="import-final-counts"><span>{t("library.import.newWorks", { count: groups.filter((group) => !group.rows.some((row) => plans[row.rowId]?.targetEntryId)).length })}</span><span>{t("library.import.linkedWorks", { count: groups.filter((group) => group.rows.some((row) => plans[row.rowId]?.targetEntryId)).length })}</span><span>{t("library.import.skippedRows", { count: skippedCount })}</span></div>
              {reviewSourceReviews && overwriteLocalReviews && <p className="import-warning">{t("library.import.replacingReviewsWarning", { count: replaceableReviewCount })}</p>}
              <p className="field-hint">{t("library.import.commitCaveat")}</p>
            </div>
          )}
          </>}
          {error && <p className="error-message import-error" role="alert">{error}</p>}
        </div>

        <footer className="modal-actions import-wizard-actions">
          <span className="field-hint">{commitResult ? t("library.import.savedReceipt") : preview ? t("library.import.previewRevision", { revision: preview.expectedRevision }) : t("library.import.localPreview")}</span>
          {commitResult ? <>
            <button type="button" className="button secondary" disabled={busy} onClick={close}>{t("common.close")}</button>
            {!undoDone && !commitResult.batchId.startsWith("preview-") && <button type="button" className="button secondary" disabled={busy} onClick={() => void undo()}>{busy ? t("library.import.undoing") : t("library.import.undo")}</button>}
          </> : <>
            {step === "sources" ? <button type="button" className="button secondary" data-modal-close-request disabled={busy}>{t("common.cancel")}</button> : <button type="button" className="button secondary" disabled={busy || batchLookupBusy} onClick={() => setStep(stepOrder[Math.max(0, stepIndex - 1)])}><ChevronLeft size={13} />{t("common.back")}</button>}
            {step === "sources" ? <button type="button" className="button primary" data-testid="import-prepare" disabled={busy || (!uploads.length && !steamId.trim())} onClick={() => void prepare()}><Search size={14} />{busy ? t("library.import.preparing") : t("library.import.reviewImport")}</button> : step === "confirm" ? <button type="button" className="button primary" data-testid="import-commit" disabled={busy} onClick={() => void commit()}>{busy ? t("library.import.committing") : t("library.import.importNow")}</button> : <button type="button" className="button primary" disabled={busy || batchLookupBusy || Boolean(checkStep(step))} onClick={() => { setError(""); setStep(stepOrder[Math.min(stepOrder.length - 1, stepIndex + 1)]); }}><span>{t("common.continue")}</span><ChevronRight size={13} /></button>}
          </>}
        </footer>
      </div>
    </Modal>
    {catalogRow && <Modal
      title={t("library.import.enrichHeading", { title: catalogRow.title })}
      description={t("library.import.enrichHint")}
      onClose={() => setCatalogRowId(null)}
      wide
      className="catalog-review-modal"
    >
      <div className="catalog-review-modal-body" data-testid="import-enrichment-panel">
        {catalogSelections[catalogRow.rowId] && <div className="import-enrichment-choice">
          {catalogSelections[catalogRow.rowId].coverUrl && <img src={catalogSelections[catalogRow.rowId].coverUrl ?? undefined} alt="" referrerPolicy="no-referrer" decoding="async" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
          <span>{t("library.import.selectedEnrichment", { title: catalogSelections[catalogRow.rowId].title, year: catalogSelections[catalogRow.rowId].year ?? "—" })}</span>
          {catalogSelections[catalogRow.rowId].coverMode === "persistReference" && catalogSelections[catalogRow.rowId].remoteCover && <label className="import-checkbox"><input type="checkbox" checked={catalogCoverSelections[catalogRow.rowId] ?? true} onChange={(event) => setCatalogCoverSelections((current) => ({ ...current, [catalogRow.rowId]: event.target.checked }))} />{t("library.catalog.useProviderCover")}</label>}
          {(() => {
            const targetId = plans[catalogRow.rowId]?.targetEntryId;
            const linkedEntry = targetId ? state.entries.find((entry) => entry.id === targetId) : null;
            return linkedEntry && (linkedEntry.coverAssetId || linkedEntry.remoteCover)
              ? <small className="import-existing-cover-note">{t("library.import.existingCoverKept", { title: linkedEntry.title })}</small>
              : null;
          })()}
        </div>}
        <CatalogSearchPanel
          key={catalogRow.rowId}
          mediaTypes={state.mediaTypes}
          initialQuery={[catalogRow.title, ...catalogRow.creators].filter(Boolean).join(" ")}
          initialYear={catalogRow.year}
          initialExternalId={catalogLookup?.externalId ?? null}
          initialExternalIdProvider={catalogLookup?.provider ?? null}
          initialMediaTypeId={plans[catalogRow.rowId]?.mediaTypeId ?? null}
          capabilities={providerCaps}
          onSelect={(result) => selectCatalogMatch(catalogRow, result)}
        />
      </div>
    </Modal>}
    </>
  );
}

function MediaTypeSelect({ value, state, onChange }: { value: string; state: LibraryState; onChange: (value: string) => void }) {
  return <SelectControl value={value} onValueChange={onChange}>
    <option value="">{t("library.import.chooseCategory")}</option>
    {state.mediaTypes.filter((type) => !type.archivedAt).map((type: MediaType) => <option key={type.id} value={type.id}>{type.id === "anime" ? t("library.type.animation") : type.id === "films" ? t("library.type.films") : type.id === "comic" ? t("library.type.comic") : type.name}</option>)}
  </SelectControl>;
}

function existingForGroup(rows: ImportSourceRow[], plans: Record<string, RowPlan>, state: LibraryState): Entry | null {
  for (const row of rows) {
    const entryId = plans[row.rowId]?.targetEntryId;
    if (!entryId) continue;
    const entry = state.entries.find((item) => item.id === entryId);
    if (entry) return entry;
  }
  return null;
}

function initialRatingChoice(group: { rows: ImportSourceRow[] }, existing: Entry | null, plan: RowPlan) {
  const ratedRows = group.rows.filter((row) => row.sourceRating);
  const values = ratedRows.map((row) => ({ row, normalized: normalizeScore(row.sourceRating!.value, row.sourceRating!.scale) })).filter((item) => item.normalized !== null);
  const normalized = new Set(values.map((item) => item.normalized));
  const proposal = values[0];
  const accepted = (existing?.overallRating ?? null) === null && plan.disposition === "experienced" && normalized.size === 1 && values.length === ratedRows.length && Boolean(proposal);
  return { sourceRowId: proposal?.row.rowId ?? null, accepted, overwrite: false };
}
