/** Local, deterministic builder for a reusable external recommendation prompt. */

export interface RecommendationProfile {
  nickname: string;
  statedTastes: string;
}

export type RecommendationDisposition =
  "known" | "planned" | "dropped" | "experienced";

export interface RecommendationEntryEvidence {
  id: string;
  title: string;
  disposition?: RecommendationDisposition;
  mediaType?: string | null;
  releaseYear?: number | null;
  overallRating?: number | null;
  withinScoreRank?: number | null;
  /** Only currently active criterion scores should be passed. */
  criterionScores?: Readonly<Record<string, number | undefined>>;
  reviewText?: string;
}

export interface RecommendationPromptOptions {
  includeProfile?: boolean;
  includeReviews?: boolean;
  includeMediaType?: boolean;
  exploreOtherMedia?: boolean;
  recommendationCount?: number;
  characterBudget?: number;
}

export interface PromptCategoryCounts {
  entries: number;
  reviews: number;
  exclusions: number;
}

export interface RecommendationPromptResult {
  text: string;
  characterCount: number;
  characterBudget: number;
  included: PromptCategoryCounts;
  omitted: PromptCategoryCounts;
}

export interface BuildRecommendationPromptArgs {
  profile: RecommendationProfile;
  guidelines: Readonly<Record<string, string>>;
  tasteInputs: Readonly<Record<string, number>>;
  criterionLabels: Readonly<Record<string, string>>;
  entries?: readonly RecommendationEntryEvidence[];
  /** False while the app has not successfully loaded the current library. */
  libraryLoaded?: boolean;
  options?: RecommendationPromptOptions;
  message: (key: string, values?: Record<string, string | number>) => string;
}

export class MandatoryPromptExceedsBudgetError extends Error {
  readonly requiredCharacters: number;
  readonly characterBudget: number;

  constructor(
    requiredCharacters: number,
    characterBudget: number,
    message: string,
  ) {
    super(message);
    this.name = "MandatoryPromptExceedsBudgetError";
    this.requiredCharacters = requiredCharacters;
    this.characterBudget = characterBudget;
  }
}

const DEFAULT_BUDGET = 40_000;
const MAX_BUDGET = 120_000;
const MAX_REVIEW_CHARACTERS = 1_000;
const DEFAULT_RECOMMENDATION_COUNT = 10;

function charCount(value: string): number {
  return Array.from(value).length;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

/** Truncate by Unicode code point, never splitting a surrogate pair. */
function excerpt(
  value: string,
  limit: number,
  marker: string,
): { text: string; truncated: boolean } {
  const normalized = normalizeText(value);
  const chars = Array.from(normalized);
  if (chars.length <= limit) return { text: normalized, truncated: false };
  const keep = Math.max(0, limit - charCount(marker));
  return { text: `${chars.slice(0, keep).join("")}${marker}`, truncated: true };
}

function validScore(value: number | null | undefined): value is number {
  return (
    value !== null &&
    value !== undefined &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
  );
}

function safeLabel(
  id: string,
  labels: Readonly<Record<string, string>>,
): string | undefined {
  return labels[id];
}

function lineForEntry(
  entry: RecommendationEntryEvidence,
  args: BuildRecommendationPromptArgs,
  options: Required<RecommendationPromptOptions>,
): {
  primaryWithType: string;
  primaryWithoutType: string;
  metadataText: string;
  reviewText: string;
  hasReview: boolean;
} {
  const title = entry.title.trim() || args.message("home.promptUntitled");
  const rating = validScore(entry.overallRating)
    ? entry.overallRating
    : null;
  const type = options.includeMediaType ? entry.mediaType?.trim() : "";
  const primaryWithoutType = rating === null
    ? args.message("home.promptEntryTitle", { title })
    : args.message("home.promptEntryRated", { title, rating });
  const primaryWithType = type
    ? rating === null
      ? args.message("home.promptEntryTitleWithType", { title, type })
      : args.message("home.promptEntryRatedWithType", { title, rating, type })
    : primaryWithoutType;
  const details: string[] = [];
  if (Number.isInteger(entry.releaseYear))
    details.push(args.message("home.promptEntryYear", { year: entry.releaseYear! }));
  const criteria = Object.entries(entry.criterionScores ?? {})
    .filter(
      ([id, score]) =>
        Boolean(safeLabel(id, args.criterionLabels)) && validScore(score),
    )
    .sort(([a], [b]) =>
      compareText(
        safeLabel(a, args.criterionLabels)!,
        safeLabel(b, args.criterionLabels)!,
      ),
    )
    .map(([id, score]) =>
      args.message("home.promptCriterionScore", {
        quality: safeLabel(id, args.criterionLabels)!,
        score: score!,
      }),
    );
  if (criteria.length)
    details.push(
      args.message("home.promptCriterionScores", {
        scores: criteria.join(", "),
      }),
    );

  let reviewText = "";
  const hasReview = Boolean(options.includeReviews && entry.reviewText?.trim());
  if (options.includeReviews && entry.reviewText?.trim()) {
    const review = excerpt(
      entry.reviewText,
      MAX_REVIEW_CHARACTERS,
      args.message("home.promptExcerptMarker"),
    );
    reviewText = args.message("home.promptPersonalReview", { review: review.text });
  }
  return {
    primaryWithType,
    primaryWithoutType,
    metadataText: details.length
      ? args.message("home.promptEntryMetadata", { details: details.join(" · ") })
      : "",
    reviewText,
    hasReview,
  };
}

function roundRobinRatedEntries(
  entries: readonly RecommendationEntryEvidence[],
): RecommendationEntryEvidence[] {
  const groups = new Map<number, RecommendationEntryEvidence[]>();
  for (const entry of entries) {
    if (
      !validScore(entry.overallRating) ||
      entry.disposition === "planned" ||
      entry.disposition === "dropped"
    )
      continue;
    const group = groups.get(entry.overallRating) ?? [];
    group.push(entry);
    groups.set(entry.overallRating, group);
  }
  const orderedGroups = [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, group]) =>
      group.sort((a, b) => {
        const aRank =
          Number.isInteger(a.withinScoreRank) && (a.withinScoreRank ?? 0) > 0
            ? a.withinScoreRank!
            : Number.MAX_SAFE_INTEGER;
        const bRank =
          Number.isInteger(b.withinScoreRank) && (b.withinScoreRank ?? 0) > 0
            ? b.withinScoreRank!
            : Number.MAX_SAFE_INTEGER;
        return (
          aRank - bRank ||
          compareText(a.title, b.title) ||
          compareText(a.id, b.id)
        );
      }),
    );
  const result: RecommendationEntryEvidence[] = [];
  for (
    let index = 0;
    orderedGroups.some((group) => index < group.length);
    index += 1
  ) {
    for (const group of orderedGroups)
      if (index < group.length) result.push(group[index]);
  }
  return result;
}

const EMPTY_COUNTS = (): PromptCategoryCounts => ({
  entries: 0,
  reviews: 0,
  exclusions: 0,
});

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Build the preview text without network or persistence side effects. */
export function buildRecommendationPrompt(
  args: BuildRecommendationPromptArgs,
): RecommendationPromptResult {
  const options: Required<RecommendationPromptOptions> = {
    includeProfile: args.options?.includeProfile ?? true,
    includeReviews: args.options?.includeReviews ?? true,
    includeMediaType: args.options?.includeMediaType ?? false,
    exploreOtherMedia: args.options?.exploreOtherMedia ?? false,
    recommendationCount:
      args.options?.recommendationCount ?? DEFAULT_RECOMMENDATION_COUNT,
    characterBudget: args.options?.characterBudget ?? DEFAULT_BUDGET,
  };
  if (
    !Number.isInteger(options.recommendationCount) ||
    options.recommendationCount < 1
  ) {
    throw new RangeError(args.message("home.promptRecommendationCountError"));
  }
  if (
    !Number.isInteger(options.characterBudget) ||
    options.characterBudget < 1 ||
    options.characterBudget > MAX_BUDGET
  ) {
    throw new RangeError(
      args.message("home.promptBudgetRangeError", { maximum: MAX_BUDGET }),
    );
  }

  const entries = args.entries ?? [];
  const libraryLoaded = args.libraryLoaded ?? true;
  const tastes = options.includeProfile
    ? normalizeText(args.profile.statedTastes)
    : "";
  const importance = options.includeProfile
    ? Object.entries(args.tasteInputs)
        .filter(
          ([id, value]) =>
            Boolean(safeLabel(id, args.criterionLabels)) &&
            Number.isInteger(value) &&
            value >= 1 &&
            value <= 10,
        )
        .sort(([a], [b]) =>
          compareText(
            safeLabel(a, args.criterionLabels)!,
            safeLabel(b, args.criterionLabels)!,
          ),
        )
        .map(([id, value]) =>
          args.message("home.promptImportanceLine", {
            criterion: safeLabel(id, args.criterionLabels)!,
            value,
          }),
        )
    : [];
  const guidelineLines = Object.entries(args.guidelines)
    .filter(([, text]) => normalizeText(text).length > 0)
    .sort(([a], [b]) => Number(b) - Number(a) || compareText(a, b))
    .map(([score, text]) =>
      args.message("home.promptGuidelineLine", {
        score: Number(score),
        text: normalizeText(text),
      }),
    );

  const rated = roundRobinRatedEntries(entries);
  const known = entries.filter(
    (e) =>
      e.disposition === "known" ||
      e.disposition === "experienced" ||
      (e.disposition === undefined && validScore(e.overallRating)),
  );
  const planned = entries.filter((e) => e.disposition === "planned");
  const dropped = entries.filter((e) => e.disposition === "dropped");
  const exclusionGroups = [
    { title: args.message("home.promptAlreadyKnown"), values: known },
    { title: args.message("home.promptPlanned"), values: planned },
    { title: args.message("home.promptDropped"), values: dropped },
  ];
  const exclusionItems = exclusionGroups.flatMap((group) =>
    group.values.map((entry) => ({
      category: group.title,
      id: entry.id,
      title: entry.title.trim() || args.message("home.promptUntitled"),
      mediaType: entry.mediaType?.trim() || "",
    })),
  );

  const mandatoryPrefix = [
    args.message("home.promptRecommendationTask", {
      count: options.recommendationCount,
    }),
    options.includeProfile
      ? `${args.message("home.promptTastesHeading")}\n${tastes || args.message("home.promptNoTasteDescription")}\n\n${args.message("home.promptImportanceHeading")}\n${importance.length ? importance.join("\n") : args.message("home.promptNoImportance")}`
      : args.message("home.promptProfileExcluded"),
    `${args.message("home.promptGuidelinesHeading")}\n${guidelineLines.length ? guidelineLines.join("\n") : args.message("home.promptNoGuidelines")}`,
  ];
  const mandatorySuffix = [
    ...(options.exploreOtherMedia
      ? [args.message("home.promptExploreOtherMedia")]
      : []),
    args.message("home.promptOutputInstruction"),
  ];
  const mandatoryMiddle = !libraryLoaded
    ? [args.message("home.promptLibraryUnavailable")]
    : entries.length === 0
      ? [args.message("home.promptNoLibraryEntries")]
      : rated.length === 0
        ? [args.message("home.promptNoRatedWorks")]
        : [];
  const mandatory = [
    ...mandatoryPrefix,
    ...mandatoryMiddle,
    ...mandatorySuffix,
  ].join("\n\n");
  const mandatoryCount = charCount(mandatory);
  if (mandatoryCount > options.characterBudget) {
    throw new MandatoryPromptExceedsBudgetError(
      mandatoryCount,
      options.characterBudget,
      args.message("home.promptBudgetExceeded", {
        required: mandatoryCount,
        budget: options.characterBudget,
      }),
    );
  }

  const included = EMPTY_COUNTS();
  const omitted = EMPTY_COUNTS();
  const chunks: string[] = [...mandatoryPrefix, ...mandatoryMiddle];
  const currentCount = () => charCount(chunks.join("\n\n"));
  const addIfFits = (
    chunk: string,
    maxCount = options.characterBudget,
  ): boolean => {
    const candidate = `${chunks.join("\n\n")}\n\n${chunk}`;
    if (charCount(candidate) > maxCount) return false;
    chunks.push(chunk);
    return true;
  };

  // Hold up to one fifth of the budget for exclusions, after the ranked
  // evidence section so the prompt follows the documented fixed section order.
  const suffixReserve =
    charCount(mandatorySuffix.join("\n\n")) + (chunks.length ? 2 : 0);
  const workingCap = options.characterBudget - suffixReserve;
  const exclusionReserve =
    exclusionItems.length > 0
      ? Math.min(
          Math.floor(options.characterBudget * 0.2),
          workingCap - currentCount(),
        )
      : 0;
  const evidenceCap = workingCap - exclusionReserve;
  if (rated.length) {
    const heading = args.message("home.promptRankedEvidenceHeading");
    if (addIfFits(heading, evidenceCap)) {
      for (const entry of rated) {
        const rendered = lineForEntry(entry, args, options);
        const full = [
          rendered.primaryWithType,
          rendered.metadataText,
          rendered.reviewText,
        ].filter(Boolean).join("\n");
        if (addIfFits(full, evidenceCap)) {
          included.entries += 1;
          if (rendered.hasReview) included.reviews += 1;
        } else {
          // Entry titles and ratings are the core library evidence. Optional
          // type, year, criterion scores, and reviews must never crowd them out.
          const primary = addIfFits(rendered.primaryWithType, evidenceCap)
            ? rendered.primaryWithType
            : options.includeMediaType && entry.mediaType?.trim() &&
                addIfFits(rendered.primaryWithoutType, evidenceCap)
              ? rendered.primaryWithoutType
              : "";
          if (!primary) {
            omitted.entries += 1;
            if (rendered.hasReview) omitted.reviews += 1;
            continue;
          }
          included.entries += 1;
          if (rendered.metadataText) addIfFits(rendered.metadataText, evidenceCap);
          if (rendered.reviewText && addIfFits(rendered.reviewText, evidenceCap))
            included.reviews += 1;
          else if (rendered.hasReview) omitted.reviews += 1;
        }
      }
    } else {
      omitted.entries = rated.length;
      omitted.reviews = options.includeReviews
        ? rated.filter((e) => e.reviewText?.trim()).length
        : 0;
    }
  }

  let exclusionStarted = false;
  const includedExclusionIds = new Set<string>();
  const exclusionCap = workingCap;
  for (const group of exclusionGroups) {
    const eligible = group.values;
    if (!eligible.length) continue;
    if (!exclusionStarted) {
      const heading = args.message("home.promptExclusionsHeading");
      if (!addIfFits(heading, exclusionCap)) break;
      exclusionStarted = true;
    }
    for (const entry of eligible) {
      const line = options.includeMediaType && entry.mediaType?.trim()
        ? args.message("home.promptExclusionLineWithType", {
            category: group.title,
            title: entry.title.trim() || args.message("home.promptUntitled"),
            type: entry.mediaType.trim(),
          })
        : args.message("home.promptExclusionLine", {
            category: group.title,
            title: entry.title.trim() || args.message("home.promptUntitled"),
          });
      if (
        addIfFits(line, exclusionCap)
      ) {
        included.exclusions += 1;
        includedExclusionIds.add(entry.id);
      }
    }
  }
  omitted.exclusions = exclusionItems.filter(
    (item) => !includedExclusionIds.has(item.id),
  ).length;
  if (exclusionStarted) {
    const note = args.message("home.promptDroppedNotice");
    addIfFits(note, workingCap);
  }

  chunks.push(...mandatorySuffix);
  const text = chunks.join("\n\n");
  // The omission notice is useful to a reader and itself stays within the cap.
  const summaryText = args.message("home.promptCoverageSummary", {
    includedEntries: included.entries,
    totalEntries: rated.length,
    omittedEntries: omitted.entries,
    includedExclusions: included.exclusions,
    totalExclusions: exclusionItems.length,
    omittedExclusions: omitted.exclusions,
  });
  let finalText = text;
  if (addableWithinBudget(finalText, summaryText, options.characterBudget))
    finalText += `\n\n${summaryText}`;

  return {
    text: finalText,
    characterCount: charCount(finalText),
    characterBudget: options.characterBudget,
    included,
    omitted,
  };
}

function addableWithinBudget(
  existing: string,
  next: string,
  budget: number,
): boolean {
  return charCount(`${existing}\n\n${next}`) <= budget;
}
