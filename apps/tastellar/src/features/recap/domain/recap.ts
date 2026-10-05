import type { Entry, MediaType, MediaTypeIconKey, RemoteCoverReference } from "../../../shared/bridge/libraryTypes";

/** Templates users can create in the active Recap gallery. */
export type RecapTemplateId =
  | "topTen"
  | "challengers"
  | "grid3x3"
  | "releaseYear"
  | "decade"
  | "format";

/** Kept only so existing saved Selection drafts remain losslessly readable. */
export type RecapStoredTemplateId = RecapTemplateId | "selection";

type RecapTagFilter = {
  /** Selected tag IDs. Missing or empty means no tag filter. */
  tagIds?: string[];
  /** Matches Library semantics; omitted is equivalent to "any". */
  tagMode?: "any" | "all";
};

export type RecapFilter =
  | ({ kind: "all" } & RecapTagFilter)
  | ({ kind: "types"; typeIds: string[] } & RecapTagFilter);

export type RecapStyle = "dark" | "daylight" | "dusk" | "reading";
export type RecapMode = "cover" | "text";
export type RecapOrientation = "portrait" | "landscape";
export type RecapRankingLabel = "canonical" | "mySelection";

export interface RecapRankedTier {
  score: number;
  placedIds: readonly string[];
}

export interface RecapEntrySnapshot {
  id: string;
  title: string;
  shortLabel?: string | null;
  mediaTypeId: string | null;
  mediaTypeName: string | null;
  iconKey?: MediaTypeIconKey | string | null;
  year: number | null;
  coverAssetId: string | null;
  /** Provider cover reference used when the entry has no downloaded local asset. */
  remoteCover?: RemoteCoverReference | null;
}

export type RecapSlotPredicate =
  | { kind: "any" }
  | { kind: "year"; value: number }
  | { kind: "decade"; value: number }
  | { kind: "format"; value: string };

export interface RecapSlot {
  id: string;
  page: number;
  entry: RecapEntrySnapshot | null;
  rank: number | null;
  label: string | null;
  /** Matching rated library entries in this period after the recap filters. */
  populationCount?: number;
  predicate: RecapSlotPredicate;
  titleOverride: string | null;
}

/** A portable draft value. Persist this JSON snapshot through the application bridge. */
export interface RecapComposition {
  version: 1;
  id: string;
  templateId: RecapStoredTemplateId;
  libraryRevision: number;
  /** Stable signature of the library/ranking inputs used to create these slots. */
  sourceFingerprint?: string;
  filter: RecapFilter;
  style: RecapStyle;
  mode: RecapMode;
  orientation: RecapOrientation;
  /** Distinguishes a user-selected period orientation from legacy template defaults. */
  orientationChosen?: boolean;
  showTitles: boolean;
  /** Optional on old saved drafts; normalization defaults this to true. */
  showMediaTypes?: boolean;
  watermark: boolean;
  heading: string;
  caption: string;
  rankingLabel: RecapRankingLabel;
  slots: RecapSlot[];
  createdAt: string;
  updatedAt: string;
}

export type RecapIneligibilityReason =
  | "tooFewRated"
  | "tooFewYears"
  | "tooFewDecades"
  | "tooFewFormats";

export interface RecapTemplateAvailability {
  id: RecapTemplateId;
  eligible: boolean;
  eligibleCount: number;
  requiredCount: number;
  reason: RecapIneligibilityReason | null;
  missingReleaseDateCount: number;
  /** Selected consecutive period window and its filtered library population. */
  periods: RecapPeriodAvailability[];
}

export interface RecapPeriodAvailability {
  value: number;
  label: string;
  count: number;
}

export interface RecapCatalog {
  /** All active rated entries matching the chosen type/tag filters. */
  ratedCount: number;
  /** Rated entries with a canonical placed position, after the chosen filter. */
  rankedCount: number;
  templates: RecapTemplateAvailability[];
}

export interface CreateRecapOptions {
  id?: string;
  revision?: number;
  now?: string;
  style?: RecapStyle;
  defaultStyle?: RecapStyle;
  mode?: RecapMode;
  orientation?: RecapOrientation;
  showTitles?: boolean;
  showMediaTypes?: boolean;
  watermark?: boolean;
  heading?: string;
  caption?: string;
}

const DEFAULT_FILTER: RecapFilter = { kind: "all" };

export function getDefaultRecapStyle(theme: string): RecapStyle {
  if (theme === "light") return "daylight";
  if (theme === "dusk") return "dusk";
  if (theme === "reading" || theme === "forest") return "reading";
  return "dark";
}

/** Explicit orientation controls are limited to the three templates that need them. */
export function recapSupportsOrientation(templateId: RecapTemplateId): boolean {
  return templateId === "topTen" || templateId === "challengers" || templateId === "format" ||
    templateId === "releaseYear" || templateId === "decade";
}

export function getDefaultRecapOrientation(templateId: RecapStoredTemplateId): RecapOrientation {
  if (templateId === "grid3x3" || templateId === "selection") return "portrait";
  return "landscape";
}

function pageCapacity(templateId: RecapStoredTemplateId, orientation: RecapOrientation): number {
  if (templateId === "releaseYear" || templateId === "decade") return 12;
  if (templateId === "format") return 6;
  if (templateId === "selection") return orientation === "landscape" ? 10 : 6;
  return Number.MAX_SAFE_INTEGER;
}

function assignCompositionPages(
  templateId: RecapStoredTemplateId,
  orientation: RecapOrientation,
  slots: RecapSlot[],
): RecapSlot[] {
  const capacity = pageCapacity(templateId, orientation);
  return slots.map((slot, index) => ({ ...slot, page: Math.floor(index / capacity) }));
}

function normalizeStoredPeriodSlots(
  slots: RecapSlot[],
  step: 1 | 10,
  entries?: readonly Entry[],
  filter: RecapFilter = DEFAULT_FILTER,
  orientation: RecapOrientation = "landscape",
): RecapSlot[] {
  const hasStoredPopulations = slots.every((slot) => Number.isInteger(slot.populationCount));
  if (!entries && !hasStoredPopulations) return latestCompatiblePeriodSlots(slots, step, orientation);

  const populations = entries
    ? getRatedRecapEntries(entries, filter).reduce((counts, entry) => {
        if (entry.releaseDate) {
          const value = periodValue(entry.releaseDate.year, step);
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return counts;
      }, new Map<number, number>())
    : null;
  const seenValues = new Set<number>();
  const periodSlots = slots
    .flatMap((slot): RecapSlot[] => {
      if (slot.predicate.kind !== (step === 1 ? "year" : "decade")) return [];
      if (seenValues.has(slot.predicate.value)) return [];
      seenValues.add(slot.predicate.value);
      const count = populations ? populations.get(slot.predicate.value) : slot.populationCount;
      return count !== undefined && count >= MIN_PERIOD_POPULATION ? [{ ...slot, populationCount: count }] : [];
    })
    .sort((first, second) => {
      const firstValue = first.predicate.kind === "any" || first.predicate.kind === "format" ? 0 : first.predicate.value;
      const secondValue = second.predicate.kind === "any" || second.predicate.kind === "format" ? 0 : second.predicate.value;
      return firstValue - secondValue;
    });
  return latestCompatiblePeriodSlots(periodSlots, step, orientation);
}

function recapMediaTypeLabel(type: Pick<MediaType, "id" | "name">): string {
  // `anime` is a stable legacy ID; its built-in display name is Animation.
  // Keep user tags named “anime” independent from this media-type label.
  return type.id === "anime" && type.name === "Anime" ? "Animation" : type.name;
}

const recapTemplateIds: readonly RecapStoredTemplateId[] = [
  "selection", "topTen", "challengers", "grid3x3", "releaseYear", "decade", "format",
];

/** Normalize both current and legacy filter snapshots without changing their meaning. */
export function normalizeRecapFilter(value: unknown): RecapFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.kind !== "all" && source.kind !== "types") return null;
  const validIdList = (ids: unknown): ids is string[] =>
    Array.isArray(ids) && ids.length <= 100 &&
    ids.every((id) => typeof id === "string" && id.length > 0 && Array.from(id).length <= 100);
  const rawTypeIds = source.kind === "types" ? source.typeIds : undefined;
  if (source.kind === "types" && !validIdList(rawTypeIds)) return null;
  const rawTagIds = source.tagIds;
  if (rawTagIds !== undefined && !validIdList(rawTagIds)) return null;
  if (source.tagMode !== undefined && source.tagMode !== "any" && source.tagMode !== "all") return null;
  const tagIds = rawTagIds === undefined ? undefined : [...new Set(rawTagIds as string[])];
  const tagMode = source.tagMode as "any" | "all" | undefined;
  return source.kind === "types"
    ? {
        kind: "types",
        typeIds: [...new Set(rawTypeIds as string[])],
        ...(tagIds ? { tagIds } : {}),
        ...(tagMode ? { tagMode } : {}),
      }
    : {
        kind: "all",
        ...(tagIds ? { tagIds } : {}),
        ...(tagMode ? { tagMode } : {}),
      };
}

/** Applies the combined media type + OR/AND tag filter used by Recap and Library. */
export function matchesRecapFilter(
  entry: Pick<Entry, "mediaTypeId" | "tagIds">,
  filter: RecapFilter = DEFAULT_FILTER,
): boolean {
  if (filter.kind === "types" && !filter.typeIds.includes(entry.mediaTypeId ?? "")) return false;
  const tagIds = [...new Set(filter.tagIds ?? [])];
  if (!tagIds.length) return true;
  const entryTagIds = new Set(entry.tagIds ?? []);
  const matchedCount = tagIds.filter((id) => entryTagIds.has(id)).length;
  return filter.tagMode === "all" ? matchedCount === tagIds.length : matchedCount > 0;
}

function copyRecapFilter(filter: RecapFilter): RecapFilter {
  return filter.kind === "types"
    ? {
        kind: "types",
        typeIds: [...filter.typeIds],
        ...(filter.tagIds ? { tagIds: [...filter.tagIds] } : {}),
        ...(filter.tagMode ? { tagMode: filter.tagMode } : {}),
      }
    : {
        kind: "all",
        ...(filter.tagIds ? { tagIds: [...filter.tagIds] } : {}),
        ...(filter.tagMode ? { tagMode: filter.tagMode } : {}),
      };
}

/** Normalize persisted legacy drafts without replacing their saved composition. */
export function normalizeRecapComposition(
  value: unknown,
  entries?: readonly Entry[],
  mediaTypes?: readonly MediaType[],
): RecapComposition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const filter = normalizeRecapFilter(source.filter);
  if (source.version !== 1 || typeof source.id !== "string" ||
      !recapTemplateIds.includes(source.templateId as RecapStoredTemplateId) || !Array.isArray(source.slots) || !filter) return null;
  const legacyStyleMap: Record<string, RecapStyle> = {
    quiet: "dark", paper: "reading", editorial: "dusk",
    dark: "dark", daylight: "daylight", dusk: "dusk", reading: "reading",
  };
  const style = typeof source.style === "string" ? legacyStyleMap[source.style] ?? "dark" : "dark";
  const mode: RecapMode = source.mode === "text" ? "text" : "cover";
  const storedOrientation: RecapOrientation = source.orientation === "portrait" ? "portrait" : "landscape";
  const periodTemplate = source.templateId === "releaseYear" || source.templateId === "decade";
  const orientationChosen = periodTemplate && source.orientationChosen === true;
  const orientation = source.templateId === "grid3x3"
    ? "portrait"
    : periodTemplate && !orientationChosen
      ? "landscape"
      : storedOrientation;
  const entriesById = entries ? new Map(entries.map((entry) => [entry.id, entry])) : null;
  const typesById = mediaTypes ? new Map(mediaTypes.map((type) => [type.id, type])) : null;
  const slots = source.slots.map((slotValue) => {
    if (!slotValue || typeof slotValue !== "object" || Array.isArray(slotValue)) return slotValue;
    const slot = slotValue as Record<string, unknown>;
    const predicate = slot.predicate && typeof slot.predicate === "object" && !Array.isArray(slot.predicate)
      ? slot.predicate as Record<string, unknown>
      : null;
    const formatType = predicate?.kind === "format" && typeof predicate.value === "string"
      ? typesById?.get(predicate.value)
      : undefined;
    if (!slot.entry || typeof slot.entry !== "object" || Array.isArray(slot.entry)) {
      const label = formatType ? recapMediaTypeLabel(formatType) : slot.label;
      return label !== slot.label ? { ...slot, label } : slotValue;
    }
    const snapshot = slot.entry as Record<string, unknown>;
    const matchingEntry = typeof snapshot.id === "string" ? entriesById?.get(snapshot.id) : undefined;
    const matchingType = typeof snapshot.mediaTypeId === "string" ? typesById?.get(snapshot.mediaTypeId) : undefined;
    const nextSnapshot = { ...snapshot };
    if (!("shortLabel" in snapshot) && matchingEntry) nextSnapshot.shortLabel = matchingEntry.shortLabel;
    if (!("iconKey" in snapshot) && matchingType) nextSnapshot.iconKey = matchingType.iconKey;
    if (snapshot.remoteCover !== undefined && snapshot.remoteCover !== null) {
      nextSnapshot.remoteCover = normalizeRemoteCoverReference(snapshot.remoteCover);
    }
    if (matchingEntry && !snapshot.coverAssetId && !nextSnapshot.remoteCover) {
      // Older snapshots can predate a cover added to the library. Hydrate only
      // when the snapshot has no cover reference at all.
      if (matchingEntry.coverAssetId) {
        nextSnapshot.coverAssetId = matchingEntry.coverAssetId;
        nextSnapshot.remoteCover = null;
      }
      else if (matchingEntry.remoteCover) nextSnapshot.remoteCover = matchingEntry.remoteCover;
      else nextSnapshot.remoteCover = null;
    } else if (nextSnapshot.remoteCover === undefined) {
      nextSnapshot.remoteCover = null;
    }
    const label = formatType ? recapMediaTypeLabel(formatType) : slot.label;
    return { ...slot, ...(label !== slot.label ? { label } : {}), entry: nextSnapshot };
  });
  let normalizedSlots = slots as RecapSlot[];
  if (source.templateId === "releaseYear") normalizedSlots = normalizeStoredPeriodSlots(normalizedSlots, 1, entries, filter, orientation);
  if (source.templateId === "decade") normalizedSlots = normalizeStoredPeriodSlots(normalizedSlots, 10, entries, filter, orientation);
  return {
    ...source,
    style,
    mode,
    orientation,
    ...(periodTemplate ? { orientationChosen } : {}),
    filter,
    showTitles: typeof source.showTitles === "boolean" ? source.showTitles : false,
    showMediaTypes: typeof source.showMediaTypes === "boolean" ? source.showMediaTypes : true,
    watermark: typeof source.watermark === "boolean" ? source.watermark : true,
    slots: assignCompositionPages(source.templateId as RecapStoredTemplateId, orientation, normalizedSlots),
  } as unknown as RecapComposition;
}

export function getRecapEntryCaption(entry: Pick<RecapEntrySnapshot, "title" | "shortLabel">): string {
  return entry.shortLabel?.trim() || entry.title;
}

export function isRecapEligibleEntry(entry: Entry): boolean {
  return (
    entry.disposition === "experienced" &&
    typeof entry.overallRating === "number" &&
    Number.isInteger(entry.overallRating) &&
    entry.overallRating >= 1 &&
    entry.overallRating <= 10
  );
}

export function getRatedRecapEntries(
  entries: readonly Entry[],
  filter: RecapFilter = DEFAULT_FILTER,
): Entry[] {
  return entries.filter((entry) =>
    isRecapEligibleEntry(entry) &&
    matchesRecapFilter(entry, filter),
  );
}

/**
 * Recap reads only the canonical placed order. Unplaced rated works do not have
 * an ordinal position and are therefore excluded from ranked compositions.
 */
export function getCanonicalRecapEntries(
  entries: readonly Entry[],
  tiers: readonly RecapRankedTier[],
  mediaTypes: readonly MediaType[],
  filter: RecapFilter = DEFAULT_FILTER,
): Array<{ entry: Entry; rank: number }> {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const result: Array<{ entry: Entry; rank: number }> = [];
  const orderedTiers = [...tiers].sort((a, b) => b.score - a.score);

  for (const tier of orderedTiers) {
    for (const id of tier.placedIds) {
      const entry = entryById.get(id);
      if (
        !entry ||
        !isRecapEligibleEntry(entry) ||
        entry.overallRating !== tier.score ||
        seen.has(id)
      ) {
        continue;
      }
      seen.add(id);
      if (!matchesRecapFilter(entry, filter)) continue;
      result.push({ entry, rank: result.length + 1 });
    }
  }
  return result;
}

/**
 * Fingerprints only the inputs that can affect a Recap: active rated entries,
 * their visible metadata/covers, relevant media-type labels, and canonical
 * placed order. Preferences and storage revision counters are intentionally
 * excluded because unrelated preference writes must not stale an image.
 */
export function getRecapSourceFingerprint(
  entries: readonly Entry[],
  tiers: readonly RecapRankedTier[],
  mediaTypes: readonly MediaType[],
  filter: RecapFilter = DEFAULT_FILTER,
): string {
  const rated = getRatedRecapEntries(entries, filter);
  const ratedIds = new Set(rated.map((entry) => entry.id));
  const relevantTypeIds = new Set(rated.flatMap((entry) => entry.mediaTypeId ? [entry.mediaTypeId] : []));
  const canonicalOrder = getCanonicalRecapEntries(entries, tiers, mediaTypes, filter).map(({ entry }) => entry.id);
  const payload = JSON.stringify({
    filter: filterFingerprintValue(filter),
    entries: [...rated]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        shortLabel: entry.shortLabel,
        mediaTypeId: entry.mediaTypeId,
        rating: entry.overallRating,
        disposition: entry.disposition,
        year: entry.releaseDate?.year ?? null,
        coverAssetId: entry.coverAssetId,
        remoteCover: entry.remoteCover ? { provider: entry.remoteCover.provider, url: entry.remoteCover.url } : null,
      })),
    order: canonicalOrder.filter((id) => ratedIds.has(id)),
    mediaTypes: [...mediaTypes]
      .filter((type) => relevantTypeIds.has(type.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((type) => ({ id: type.id, name: type.name, iconKey: type.iconKey, archivedAt: type.archivedAt, sortOrder: type.sortOrder })),
  });
  // Two independent 32-bit FNV-1a streams keep the persisted signature short
  // while remaining stable in browser and native JS runtimes.
  let first = 0x811c9dc5;
  let second = 0x811c9dc5 ^ 0x9e3779b9;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x01000193);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  return `v1-${hex(first)}${hex(second)}`;
}

function filterFingerprintValue(filter: RecapFilter): unknown {
  const tagIds = [...new Set(filter.tagIds ?? [])].sort();
  return {
    kind: filter.kind,
    ...(filter.kind === "types" ? { typeIds: [...new Set(filter.typeIds)].sort() } : {}),
    ...(tagIds.length ? { tagIds, tagMode: filter.tagMode ?? "any" } : {}),
  };
}

function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

const MIN_PERIOD_POPULATION = 5;
const MIN_CONSECUTIVE_PERIODS = 2;
const MAX_PERIOD_CARDS = 12;
const PERIOD_GRID_COUNTS: Record<RecapOrientation, readonly number[]> = {
  landscape: [12, 8, 6, 4, 3, 2],
  portrait: [12, 9, 8, 6, 4, 3, 2],
};

function periodValue(year: number, step: 1 | 10): number {
  return step === 1 ? year : decadeOf(year);
}

function latestCompatiblePeriodSlots(slots: RecapSlot[], step: 1 | 10, orientation: RecapOrientation): RecapSlot[] {
  const kind = step === 1 ? "year" : "decade";
  const byValue = new Map<number, RecapSlot>();
  for (const slot of slots) {
    if (slot.predicate.kind === kind && !byValue.has(slot.predicate.value)) byValue.set(slot.predicate.value, slot);
  }
  const periodSlots = [...byValue.values()].sort((first, second) => {
    if (first.predicate.kind !== kind || second.predicate.kind !== kind) return 0;
    return first.predicate.value - second.predicate.value;
  });
  let bestRun: RecapSlot[] = [];
  let currentRun: RecapSlot[] = [];
  const newest = (run: RecapSlot[]) => {
    const last = run[run.length - 1];
    return last?.predicate.kind === kind ? last.predicate.value : -Infinity;
  };
  for (const slot of periodSlots) {
    const previous = currentRun[currentRun.length - 1];
    if (!previous || previous.predicate.kind === kind && slot.predicate.kind === kind && slot.predicate.value === previous.predicate.value + step) {
      currentRun.push(slot);
    } else currentRun = [slot];
    if (currentRun.length > bestRun.length || (currentRun.length === bestRun.length && newest(currentRun) > newest(bestRun))) {
      bestRun = [...currentRun];
    }
  }
  if (bestRun.length < MIN_CONSECUTIVE_PERIODS) return [];
  const cardCount = PERIOD_GRID_COUNTS[orientation].find((count) => count <= Math.min(bestRun.length, MAX_PERIOD_CARDS));
  return cardCount ? bestRun.slice(-cardCount).map((slot) => ({ ...slot, page: 0 })) : [];
}

function selectedPeriodWindow(
  allRated: readonly Entry[],
  ranked: readonly { entry: Entry; rank: number }[],
  step: 1 | 10,
  orientation: RecapOrientation = "landscape",
): RecapPeriodAvailability[] {
  const populations = new Map<number, number>();
  for (const entry of allRated) {
    if (entry.releaseDate) {
      const value = periodValue(entry.releaseDate.year, step);
      populations.set(value, (populations.get(value) ?? 0) + 1);
    }
  }

  const hasRankedWinner = new Set(
    ranked.flatMap(({ entry }) => entry.releaseDate ? [periodValue(entry.releaseDate.year, step)] : []),
  );
  const eligible = [...populations]
    .filter(([value, count]) => count >= MIN_PERIOD_POPULATION && hasRankedWinner.has(value))
    .sort(([first], [second]) => first - second)
    .map(([value, count]) => ({ value, label: step === 1 ? String(value) : `${value}s`, count }));

  let bestRun: RecapPeriodAvailability[] = [];
  let currentRun: RecapPeriodAvailability[] = [];
  for (const period of eligible) {
    const previous = currentRun[currentRun.length - 1];
    if (!previous || period.value === previous.value + step) currentRun.push(period);
    else currentRun = [period];

    const bestNewest = bestRun[bestRun.length - 1]?.value ?? -Infinity;
    const currentNewest = currentRun[currentRun.length - 1]?.value ?? -Infinity;
    if (currentRun.length > bestRun.length || (currentRun.length === bestRun.length && currentNewest > bestNewest)) {
      bestRun = [...currentRun];
    }
  }

  if (bestRun.length < MIN_CONSECUTIVE_PERIODS) return [];
  const cardCount = PERIOD_GRID_COUNTS[orientation].find((count) => count <= Math.min(bestRun.length, MAX_PERIOD_CARDS));
  return cardCount ? bestRun.slice(-cardCount) : [];
}

export function getRecapTemplates(
  entries: readonly Entry[],
  tiers: readonly RecapRankedTier[],
  mediaTypes: readonly MediaType[],
  filter: RecapFilter = DEFAULT_FILTER,
): RecapCatalog {
  const rated = getCanonicalRecapEntries(entries, tiers, mediaTypes, filter);
  const allRated = getRatedRecapEntries(entries, filter);
  const dates = allRated.filter((entry) => entry.releaseDate !== null);
  const yearPeriods = selectedPeriodWindow(allRated, rated, 1, "landscape");
  const decadePeriods = selectedPeriodWindow(allRated, rated, 10, "landscape");
  const placedTypeIds = new Set(rated.flatMap(({ entry }) => entry.mediaTypeId ? [entry.mediaTypeId] : []));
  const activeTypeIds = new Set(mediaTypes.filter((type) => type.archivedAt === null).map((type) => type.id));
  const typesWithFiveOrMore = new Set(
    [...allRated
      .filter((entry) => entry.mediaTypeId !== null)
      .reduce((counts, entry) => {
        const id = entry.mediaTypeId!;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())
      .entries()]
      .filter(([, count]) => count >= 5)
      .map(([id]) => id)
      .filter((id) => activeTypeIds.has(id) && placedTypeIds.has(id)),
  );

  const enoughWorks = (requiredCount: number): boolean => rated.length >= requiredCount;
  return {
    ratedCount: allRated.length,
    rankedCount: rated.length,
    templates: [
      { id: "topTen", requiredCount: 10, eligibleCount: rated.length, eligible: enoughWorks(10), reason: enoughWorks(10) ? null : "tooFewRated", missingReleaseDateCount: 0, periods: [] },
      { id: "challengers", requiredCount: 5, eligibleCount: rated.length, eligible: enoughWorks(5), reason: enoughWorks(5) ? null : "tooFewRated", missingReleaseDateCount: 0, periods: [] },
      { id: "grid3x3", requiredCount: 9, eligibleCount: rated.length, eligible: enoughWorks(9), reason: enoughWorks(9) ? null : "tooFewRated", missingReleaseDateCount: 0, periods: [] },
      { id: "releaseYear", requiredCount: MIN_CONSECUTIVE_PERIODS, eligibleCount: yearPeriods.length, eligible: yearPeriods.length >= MIN_CONSECUTIVE_PERIODS, reason: yearPeriods.length >= MIN_CONSECUTIVE_PERIODS ? null : "tooFewYears", missingReleaseDateCount: allRated.length - dates.length, periods: yearPeriods },
      { id: "decade", requiredCount: MIN_CONSECUTIVE_PERIODS, eligibleCount: decadePeriods.length, eligible: decadePeriods.length >= MIN_CONSECUTIVE_PERIODS, reason: decadePeriods.length >= MIN_CONSECUTIVE_PERIODS ? null : "tooFewDecades", missingReleaseDateCount: allRated.length - dates.length, periods: decadePeriods },
      { id: "format", requiredCount: 2, eligibleCount: typesWithFiveOrMore.size, eligible: typesWithFiveOrMore.size >= 2, reason: typesWithFiveOrMore.size >= 2 ? null : "tooFewFormats", missingReleaseDateCount: 0, periods: [] },
    ],
  };
}

function snapshot(entry: Entry, mediaTypes: readonly MediaType[]): RecapEntrySnapshot {
  const mediaType = entry.mediaTypeId
    ? mediaTypes.find((type) => type.id === entry.mediaTypeId && type.archivedAt === null)
    : undefined;
  return {
    id: entry.id,
    title: entry.title,
    shortLabel: entry.shortLabel,
    mediaTypeId: entry.mediaTypeId,
    mediaTypeName: mediaType?.name ?? null,
    iconKey: mediaType?.iconKey ?? null,
    year: entry.releaseDate?.year ?? null,
    coverAssetId: entry.coverAssetId,
    remoteCover: entry.remoteCover ?? null,
  };
}

function normalizeRemoteCoverReference(value: unknown): RemoteCoverReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cover = value as Record<string, unknown>;
  if (typeof cover.provider !== "string" || typeof cover.url !== "string") return null;
  const hostByProvider: Record<string, string[]> = {
    tmdb: ["image.tmdb.org"],
    openlibrary: ["covers.openlibrary.org"],
    googlebooks: ["books.google.com", "books.googleusercontent.com"],
    igdb: ["images.igdb.com"],
    steam: ["shared.akamai.steamstatic.com", "cdn.akamai.steamstatic.com"],
  };
  try {
    const url = new URL(cover.url);
    if (url.protocol !== "https:" || !hostByProvider[cover.provider]?.includes(url.hostname) || url.username || url.password || url.port || cover.url.length > 4096) return null;
    const sourceUrl = typeof cover.sourceUrl === "string" && cover.sourceUrl.length <= 2048 ? cover.sourceUrl : null;
    const attribution = typeof cover.attribution === "string" && cover.attribution.length <= 1000 ? cover.attribution : null;
    return { provider: cover.provider, url: url.toString(), sourceUrl, attribution };
  } catch {
    return null;
  }
}

function createSlot(
  templateId: RecapTemplateId,
  index: number,
  page: number,
  row: { entry: Entry; rank: number } | null,
  mediaTypes: readonly MediaType[],
  label: string | null = null,
  predicate: RecapSlotPredicate = { kind: "any" },
  rank: number | null = row?.rank ?? null,
  populationCount?: number,
): RecapSlot {
  return {
    id: `${templateId}-${page}-${index}`,
    page,
    entry: row ? snapshot(row.entry, mediaTypes) : null,
    rank,
    label,
    ...(populationCount !== undefined ? { populationCount } : {}),
    predicate,
    titleOverride: null,
  };
}

function topByPredicate(
  rated: Array<{ entry: Entry; rank: number }>,
  predicate: (entry: Entry) => boolean,
) {
  return rated.find(({ entry }) => predicate(entry)) ?? null;
}

function getTemplateRows(
  templateId: RecapTemplateId,
  rated: Array<{ entry: Entry; rank: number }>,
  mediaTypes: readonly MediaType[],
  allRated: readonly Entry[],
  orientation: RecapOrientation,
): RecapSlot[] {
  if (templateId === "topTen") {
    return rated.slice(0, 10).map((row, index) => createSlot(templateId, index, 0, row, mediaTypes, null, { kind: "any" }, index + 1));
  }
  if (templateId === "challengers") {
    return rated.slice(0, 5).map((row, index) => createSlot(templateId, index, 0, row, mediaTypes, null, { kind: "any" }, index + 1));
  }
  if (templateId === "grid3x3") {
    return rated.slice(0, 9).map((row, index) => createSlot(templateId, index, 0, row, mediaTypes, null, { kind: "any" }, index + 1));
  }
  if (templateId === "releaseYear") {
    return selectedPeriodWindow(allRated, rated, 1, orientation).map((period, index) => {
      const year = period.value;
      const row = topByPredicate(rated, (entry) => entry.releaseDate?.year === year);
      return createSlot(templateId, index, 0, row, mediaTypes, period.label, { kind: "year", value: year }, null, period.count);
    });
  }
  if (templateId === "decade") {
    return selectedPeriodWindow(allRated, rated, 10, orientation).map((period, index) => {
      const decade = period.value;
      const row = topByPredicate(rated, (entry) => entry.releaseDate !== null && decadeOf(entry.releaseDate.year) === decade);
      return createSlot(templateId, index, 0, row, mediaTypes, period.label, { kind: "decade", value: decade }, null, period.count);
    });
  }

  const activeTypes = mediaTypes
    .filter((type) => type.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  allRated.forEach((entry) => {
    if (entry.mediaTypeId) counts.set(entry.mediaTypeId, (counts.get(entry.mediaTypeId) ?? 0) + 1);
  });
  return activeTypes
    .filter((type) => (counts.get(type.id) ?? 0) >= 5 && rated.some(({ entry }) => entry.mediaTypeId === type.id))
    .map((type, index) => {
      const row = topByPredicate(rated, (entry) => entry.mediaTypeId === type.id);
      return createSlot(templateId, index, Math.floor(index / 6), row, mediaTypes, recapMediaTypeLabel(type), { kind: "format", value: type.id }, null);
    });
}

export function createRecapComposition(
  templateId: RecapTemplateId,
  entries: readonly Entry[],
  tiers: readonly RecapRankedTier[],
  mediaTypes: readonly MediaType[],
  filter: RecapFilter = DEFAULT_FILTER,
  options: CreateRecapOptions = {},
): RecapComposition {
  const rated = getCanonicalRecapEntries(entries, tiers, mediaTypes, filter);
  const allRated = getRatedRecapEntries(entries, filter);
  const now = options.now ?? new Date().toISOString();
  const orientation = templateId === "grid3x3" ? "portrait" : options.orientation ?? getDefaultRecapOrientation(templateId);
  return {
    version: 1,
    id: options.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `recap-${now}`),
    templateId,
    libraryRevision: options.revision ?? 0,
    sourceFingerprint: getRecapSourceFingerprint(entries, tiers, mediaTypes, filter),
    filter: copyRecapFilter(filter),
    style: options.style ?? options.defaultStyle ?? "dark",
    mode: options.mode ?? "cover",
    orientation,
    showTitles: options.showTitles ?? false,
    showMediaTypes: options.showMediaTypes ?? true,
    watermark: options.watermark ?? true,
    heading: options.heading ?? "",
    caption: options.caption ?? "",
    rankingLabel: "canonical",
    slots: assignCompositionPages(
      templateId,
      orientation,
      getTemplateRows(templateId, rated, mediaTypes, allRated, orientation),
    ),
    createdAt: now,
    updatedAt: now,
  };
}

function reindexComposition(composition: RecapComposition): RecapComposition {
  let nextRank = 1;
  const slots = composition.slots.map((slot) => {
    if (slot.rank === null) return slot;
    return { ...slot, rank: nextRank++ };
  });
  return { ...composition, slots, rankingLabel: "mySelection", updatedAt: new Date().toISOString() };
}

export function swapRecapSlots(
  composition: RecapComposition,
  firstSlotId: string,
  secondSlotId: string,
): RecapComposition {
  if (firstSlotId === secondSlotId) return composition;
  const firstIndex = composition.slots.findIndex((slot) => slot.id === firstSlotId);
  const secondIndex = composition.slots.findIndex((slot) => slot.id === secondSlotId);
  if (firstIndex < 0 || secondIndex < 0) return composition;
  const first = composition.slots[firstIndex];
  const second = composition.slots[secondIndex];
  if (first.page !== second.page || !samePredicate(first.predicate, second.predicate)) return composition;
  const slots = [...composition.slots];
  slots[firstIndex] = { ...first, entry: second.entry, titleOverride: second.titleOverride };
  slots[secondIndex] = { ...second, entry: first.entry, titleOverride: first.titleOverride };
  return reindexComposition({ ...composition, slots });
}

export function removeRecapSlotEntry(
  composition: RecapComposition,
  slotId: string,
): RecapComposition {
  const slots = composition.slots.map((slot) =>
    slot.id === slotId ? { ...slot, entry: null, titleOverride: null } : slot,
  );
  return slots.every((slot, index) => slot === composition.slots[index])
    ? composition
    : { ...composition, slots, updatedAt: new Date().toISOString() };
}

export function replaceRecapSlotEntry(
  composition: RecapComposition,
  slotId: string,
  entry: RecapEntrySnapshot,
): RecapComposition {
  const target = composition.slots.find((slot) => slot.id === slotId);
  if (!target || !matchesPredicate(target.predicate, entry)) return composition;
  if (composition.slots.some((slot) => slot.id !== slotId && slot.entry?.id === entry.id)) return composition;
  const slots = composition.slots.map((slot) =>
    slot.id === slotId ? { ...slot, entry, titleOverride: null } : slot,
  );
  return slots.every((slot, index) => slot === composition.slots[index])
    ? composition
    : { ...composition, slots, rankingLabel: "mySelection", updatedAt: new Date().toISOString() };
}

function samePredicate(a: RecapSlotPredicate, b: RecapSlotPredicate): boolean {
  return a.kind === b.kind && (a.kind === "any" || ("value" in a && "value" in b && a.value === b.value));
}

function matchesPredicate(predicate: RecapSlotPredicate, entry: RecapEntrySnapshot): boolean {
  if (predicate.kind === "any") return true;
  if (predicate.kind === "format") return entry.mediaTypeId === predicate.value;
  if (entry.year === null) return false;
  if (predicate.kind === "year") return entry.year === predicate.value;
  return decadeOf(entry.year) === predicate.value;
}

export function getRecapReplacementCandidates(
  composition: RecapComposition,
  slotId: string,
  entries: readonly Entry[],
  tiers: readonly RecapRankedTier[],
  mediaTypes: readonly MediaType[],
): RecapEntrySnapshot[] {
  const slot = composition.slots.find((candidate) => candidate.id === slotId);
  if (!slot) return [];
  const assigned = new Set(composition.slots.flatMap((item) => item.entry ? [item.entry.id] : []));
  const canonical = getCanonicalRecapEntries(entries, tiers, mediaTypes, composition.filter);
  const canonicalIds = new Set(canonical.map(({ entry }) => entry.id));
  const unplaced = getRatedRecapEntries(entries, composition.filter).filter((entry) => !canonicalIds.has(entry.id));
  const ordered = [...canonical.map(({ entry }) => entry), ...unplaced];
  return ordered
    .filter((entry) => {
      if (assigned.has(entry.id)) return false;
      if (slot.predicate.kind === "year") return entry.releaseDate?.year === slot.predicate.value;
      if (slot.predicate.kind === "decade") return entry.releaseDate !== null && decadeOf(entry.releaseDate.year) === slot.predicate.value;
      if (slot.predicate.kind === "format") return entry.mediaTypeId === slot.predicate.value;
      return true;
    })
    .map((entry) => snapshot(entry, mediaTypes));
}

export function updateRecapComposition(
  composition: RecapComposition,
  patch: Partial<Pick<RecapComposition, "style" | "mode" | "orientation" | "showTitles" | "showMediaTypes" | "watermark" | "heading" | "caption">>,
): RecapComposition {
  const next = { ...composition, ...patch, updatedAt: new Date().toISOString() };
  if (patch.orientation && (next.templateId === "releaseYear" || next.templateId === "decade")) {
    next.orientationChosen = true;
  }
  if (next.templateId === "grid3x3") next.orientation = "portrait";
  else if (next.templateId === "selection" || !recapSupportsOrientation(next.templateId)) next.orientation = composition.orientation;
  if (patch.orientation && next.templateId !== "selection" && recapSupportsOrientation(next.templateId)) {
    if (next.templateId === "releaseYear") next.slots = normalizeStoredPeriodSlots(next.slots, 1, undefined, next.filter, next.orientation);
    if (next.templateId === "decade") next.slots = normalizeStoredPeriodSlots(next.slots, 10, undefined, next.filter, next.orientation);
    next.slots = assignCompositionPages(next.templateId, next.orientation, next.slots);
  }
  return next;
}
