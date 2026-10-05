import { useEffect, useMemo, useState, useId, type CSSProperties, type KeyboardEvent } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Compass,
  MoveHorizontal,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { Entry } from "../../shared/bridge/libraryTypes";
import type { RankingStateView } from "../ranking/Ranking";
import type { RankingDropPosition } from "../ranking/domain/ranking";
import { t } from "../../shared/ui/i18n";
import { Modal } from "../../shared/ui/Modal";
import { mediaTypeName } from "../library/MediaTypeIcon";
import {
  buildTopListCandidates,
  deriveMediaDistributions,
  deriveNextBoundaryReview,
  deriveRankedTierMediaDistribution,
  deriveRatingDistribution,
  selectTopLists,
} from "./domain/analytics";
import type { RankedTierMediaDistributionTier } from "./domain/analytics";
import "./analytics.css";

type TopSelection = { seed: number; candidateId: string | null };
const selectionsByView = new Map<string, TopSelection>();
const recentTopSets: string[][] = [];

function randomSeed() {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0];
  }
  return Math.floor(Math.random() * 2 ** 32);
}

function rememberTopSet(ids: string[]) {
  if (!ids.length) return;
  for (let i = recentTopSets.length - 1; i >= 0; i -= 1) {
    if (recentTopSets[i].join("\u0000") === ids.join("\u0000"))
      recentTopSets.splice(i, 1);
  }
  recentTopSets.unshift(ids);
  recentTopSets.splice(1);
}

function focusKey(event: KeyboardEvent<SVGElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function formatNumber(value: number, maximumFractionDigits = 1) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(
    value,
  );
}

function formatCoverage(coverage: number) {
  if (coverage >= 1) return formatNumber(100, 0);
  const percentage = Math.max(0, Math.min(99.9, Math.floor(coverage * 1000) / 10));
  return formatNumber(percentage, 1);
}

function observationText(
  observation: { key: string; values: Record<string, string | number> },
  modes: number[],
) {
  const leaf = observation.key.split(".").at(-1) ?? "mixed";
  const key = `analytics.observation.${leaf}`;
  if (leaf === "ratingBand") {
    const band = String(observation.values.band ?? "middle");
    const bandScores = band === "strict" ? [1, 2, 3, 4]
      : band === "middle" ? [5, 6]
        : band === "appealing" ? [7, 8] : [9, 10];
    const peaks = modes.filter((score) => bandScores.includes(score)).join(" · ");
    return t(key, {
      ...observation.values,
      percentage: formatNumber(Number(observation.values.percentage ?? 0), 0),
      peak: peaks,
    });
  }
  return t(key, observation.values);
}

function niceAxis(maxValue: number) {
  const targetTop = Math.max(1, maxValue * 1.12);
  const roughStep = targetTop / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = Math.max(1, (normalized <= 1.5 ? 1 : normalized <= 3 ? 2 : normalized <= 7 ? 5 : 10) * magnitude);
  const top = Math.max(step, Math.ceil(targetTop / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return { top: Math.max(top, 1), ticks };
}

export interface AnalyticsProps {
  state: RankingStateView | null;
  viewKey: string;
  onMoveEntry: (
    entryId: string,
    score: number,
    ranked: boolean,
    position: RankingDropPosition,
  ) => Promise<RankingStateView>;
  onEditEntry: (entryId: string) => void;
  onOpenLibrary: () => void;
  onOpenRanking: () => void;
  confirmations: string[];
  onConfirmReview: (fingerprint: string) => Promise<void>;
  onResetReviews: () => Promise<void>;
  error?: string;
  onRetry?: () => void | Promise<unknown>;
}

export function Analytics({
  state,
  viewKey,
  onMoveEntry,
  onEditEntry,
  onOpenLibrary,
  onOpenRanking,
  confirmations,
  onConfirmReview,
  onResetReviews,
  error = "",
  onRetry,
}: AnalyticsProps) {
  const [selection, setSelection] = useState<TopSelection>(() => {
    const saved = selectionsByView.get(viewKey);
    if (saved) return saved;
    const initial = { seed: randomSeed(), candidateId: null };
    selectionsByView.set(viewKey, initial);
    return initial;
  });
  const [inspection, setInspection] = useState<
    | { kind: "rating"; score: number }
    | { kind: "media"; typeId: string | null; score: number }
    | null
  >(null);
  const [rankedInspection, setRankedInspection] = useState<number | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    const saved = selectionsByView.get(viewKey);
    if (saved) setSelection(saved);
    else {
      const initial = { seed: randomSeed(), candidateId: null };
      selectionsByView.set(viewKey, initial);
      setSelection(initial);
    }
    setInspection(null);
    setRankedInspection(null);
    setHiddenTypes(new Set());
    setActionError("");
  }, [viewKey]);

  const entries = state?.library.entries ?? [];
  const displayMediaTypes = useMemo(
    () => (state?.library.mediaTypes ?? []).map((type) => ({
      ...type,
      name: mediaTypeName(type.id, type.name),
    })),
    [state?.library.mediaTypes],
  );
  const experiencedRated = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.disposition === "experienced" &&
          typeof entry.overallRating === "number",
      ),
    [entries],
  );
  const distribution = useMemo(
    () => deriveRatingDistribution(entries),
    [entries],
  );
  const media = useMemo(
    () => deriveMediaDistributions(entries, displayMediaTypes),
    [entries, displayMediaTypes],
  );
  const rankedMedia = useMemo(
    () => deriveRankedTierMediaDistribution(entries, displayMediaTypes, state?.tiers ?? []),
    [entries, displayMediaTypes, state?.tiers],
  );
  const mediaColorById = useMemo(() => {
    const observed = new Set(rankedMedia.tiers.flatMap((tier) => tier.series.map((item) => item.typeId)));
    const mediaChartIds = media.series.map((item) => item.typeId ?? "__no-type__");
    const orderedIds = [
      ...mediaChartIds,
      ...[...observed]
        .map((typeId) => typeId ?? "__no-type__")
        .filter((typeId) => !mediaChartIds.includes(typeId))
        .sort((a, b) => a === "__no-type__" ? 1 : b === "__no-type__" ? -1 : a.localeCompare(b)),
    ];
    const colors = new Map<string, string>();
    orderedIds.forEach((id, index) => colors.set(id, seriesColors[index % seriesColors.length]));
    return colors;
  }, [media.series, rankedMedia]);
  const candidates = useMemo(
    () =>
      state
        ? buildTopListCandidates(
            entries,
            displayMediaTypes.filter((type) => !type.archivedAt),
            state.library.tags,
            state.tiers,
          )
        : [],
    [entries, displayMediaTypes, state?.library.tags, state?.tiers],
  );
  const topSelections = useMemo(
    () => selectTopLists(candidates, selection.seed, recentTopSets, 1, selection.candidateId ? [selection.candidateId] : []),
    [candidates, selection.seed, selection.candidateId],
  );
  const selectedTop = candidates.find((candidate) => candidate.id === selection.candidateId) ?? null;
  const entriesById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const nextBoundary = useMemo(
    () =>
      state
        ? deriveNextBoundaryReview(
            entries,
            state.tiers,
            confirmations,
          )
        : null,
    [entries, state?.tiers, confirmations],
  );
  const firstBoundary = useMemo(
    () =>
      state
        ? deriveNextBoundaryReview(entries, state.tiers, [])
        : null,
    [entries, state?.tiers],
  );

  useEffect(() => {
    if (!state || !topSelections.length) return;
    if (
      selection.candidateId &&
      candidates.some((candidate) => candidate.id === selection.candidateId)
    )
      return;
    const selected = topSelections[0];
    const next = { ...selection, candidateId: selected.id };
    selectionsByView.set(viewKey, next);
    rememberTopSet(selected.entryIds);
    setSelection(next);
  }, [state, topSelections, candidates, selection, viewKey]);

  if (!state) {
    return (
      <div className="analytics-page page-enter" aria-labelledby="analytics-title">
        <header className="analytics-heading">
          <span className="eyebrow">{t("analytics.eyebrow")}</span>
          <h1 id="analytics-title">{t("analytics.title")}</h1>
        </header>
        {error ? (
          <div className="analytics-state analytics-error" role="alert">
            <CircleHelp size={23} strokeWidth={1.4} />
            <h2>{t("analytics.errorTitle")}</h2>
            <p>{t("analytics.errorBody")}</p>
            {onRetry && (
              <button className="button secondary" onClick={() => void onRetry()}>
                <RefreshCw size={14} /> {t("analytics.retry")}
              </button>
            )}
          </div>
        ) : (
          <div className="analytics-loading" role="status">
            <span className="analytics-loading-star" aria-hidden="true">✦</span>
            {t("analytics.loading")}
          </div>
        )}
      </div>
    );
  }

  if (distribution.total < 20) {
    return (
      <div className="analytics-page page-enter" aria-labelledby="analytics-title">
        <header className="analytics-heading">
          <span className="eyebrow">{t("analytics.eyebrow")}</span>
          <h1 id="analytics-title">{t("analytics.title")}</h1>
        </header>
        <section className="analytics-empty" aria-labelledby="analytics-empty-title">
          <div className="analytics-empty-orbit" aria-hidden="true">
            <span className="analytics-empty-star">✦</span>
            <i /><i /><i />
          </div>
          <h2 id="analytics-empty-title">{t("analytics.emptyTitle")}</h2>
          <p>{t("analytics.emptyBody")}</p>
          <button className="button secondary" onClick={onOpenLibrary}>
            <Compass size={15} /> {t("analytics.openLibrary")}
          </button>
        </section>
      </div>
    );
  }

  const ratingCounts = Array.from({ length: 10 }, (_, index) =>
    distribution.counts[index + 1],
  );
  const modeScores = [...distribution.modes].sort((a, b) => b - a);
  const hasRankedMedia = rankedMedia.tiers.some((tier) => tier.available);
  const topSectionIndex = hasRankedMedia ? "04" : "03";
  const boundarySectionIndex = hasRankedMedia ? "05" : "04";
  const bestTop = selectedTop;
  const boundaryHigh = nextBoundary
    ? entriesById.get(nextBoundary.highEntryId)
    : undefined;
  const boundaryLow = nextBoundary
    ? entriesById.get(nextBoundary.lowEntryId)
    : undefined;
  const hasUnplacedBoundary = state.tiers.some((upperTier) => {
    if (upperTier.score <= 1) return false;
    const lowerTier = state.tiers.find((tier) => tier.score === upperTier.score - 1);
    if (!lowerTier) return false;
    const upperUnplaced = upperTier.unplacedIds.some((id) => {
      const entry = entriesById.get(id);
      return entry?.disposition === "experienced" && entry.overallRating === upperTier.score;
    });
    const lowerUnplaced = lowerTier.unplacedIds.some((id) => {
      const entry = entriesById.get(id);
      return entry?.disposition === "experienced" && entry.overallRating === lowerTier.score;
    });
    return (
      upperTier.placedIds.length + upperTier.unplacedIds.length > 0 &&
      lowerTier.placedIds.length + lowerTier.unplacedIds.length > 0 &&
      ((upperTier.placedIds.length === 0 && upperUnplaced) ||
        (lowerTier.placedIds.length === 0 && lowerUnplaced))
    );
  });
  const ratingsForInspection = inspection?.kind === "rating"
    ? experiencedRated.filter((entry) => entry.overallRating === inspection.score)
    : inspection?.kind === "media"
      ? experiencedRated.filter(
          (entry) =>
            entry.overallRating === inspection.score &&
            (entry.mediaTypeId ?? null) === inspection.typeId,
        )
      : [];
  const refreshTopSelection = () => {
    if (!candidates.length) return;
    const prior = bestTop?.entryIds;
    if (prior) rememberTopSet(prior);
    const seed = randomSeed();
    const shuffled = selectTopLists(candidates, seed, recentTopSets, 1, bestTop ? [bestTop.id] : []);
    const nextCandidate = shuffled[0] ?? null;
    const next: TopSelection = {
      seed,
      candidateId: nextCandidate?.id ?? null,
    };
    selectionsByView.set(viewKey, next);
    if (nextCandidate) rememberTopSet(nextCandidate.entryIds);
    setSelection(next);
  };

  const runBoundaryAction = async (action: () => Promise<unknown>) => {
    setActionError("");
    setBusy(true);
    try {
      await action();
    } catch {
      setActionError(t("analytics.boundary.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="analytics-page page-enter" aria-labelledby="analytics-title">
      <header className="analytics-heading analytics-heading-ready">
        <div>
          <span className="eyebrow">{t("analytics.eyebrow")}</span>
          <h1 id="analytics-title">{t("analytics.title")}</h1>
          <p>{t("analytics.population", { count: distribution.total })}</p>
        </div>
        <div className="analytics-summary" aria-label={t("analytics.section.ratings")}>
          <div><span>{t("analytics.metric.mean")}</span><strong>{formatNumber(distribution.mean ?? 0)}</strong></div>
          <div><span>{t("analytics.metric.median")}</span><strong>{formatNumber(distribution.median ?? 0)}</strong></div>
          <div><span>{t("analytics.metric.mode")}</span><strong>{modeScores.join(" · ")}</strong></div>
        </div>
      </header>

      <section className="analytics-section" data-section="ratings" aria-labelledby="analytics-ratings-title">
        <div className="analytics-section-heading">
          <div><span className="analytics-section-index">01</span><div><h2 id="analytics-ratings-title">{t("analytics.section.ratings")}</h2><p>{t("analytics.section.ratingsIntro")}</p></div></div>
        </div>
        <Histogram counts={ratingCounts} percentages={Array.from({ length: 10 }, (_, index) => distribution.percentages[index + 1])} total={distribution.total} selected={inspection?.kind === "rating" ? inspection.score : null} onSelect={(score) => setInspection({ kind: "rating", score })} />
        <div className="analytics-chart-footnote">
          <span>{t("analytics.stats.spread", { value: formatNumber(distribution.populationStandardDeviation ?? 0) })}</span>
        </div>
        <div className="analytics-observations" aria-live="polite">
          {distribution.observations.slice(0, 2).map((observation, index) => (
            <p key={`${observation.key}-${index}`}>{observationText(observation, distribution.modes)}</p>
          ))}
        </div>
      </section>

      <section className="analytics-section" data-section="media" aria-labelledby="analytics-media-title">
        <div className="analytics-section-heading">
          <div><span className="analytics-section-index">02</span><div><h2 id="analytics-media-title">{t("analytics.section.media")}</h2><p>{t("analytics.section.mediaIntro")}</p></div></div>
        </div>
        <MediaChart
          series={media.series}
          colorByType={mediaColorById}
          hiddenTypes={hiddenTypes}
          onToggleType={(typeId) => setHiddenTypes((current) => {
            const next = new Set(current);
            next.has(typeId) ? next.delete(typeId) : next.add(typeId);
            return next;
          })}
          selected={inspection?.kind === "media" ? inspection : null}
          onSelect={(typeId, score) => setInspection({ kind: "media", typeId, score })}
        />
        <div className="analytics-media-summaries">
          {media.series.filter((series) => series.count >= 5).map((series) => (
            <p key={series.typeId ?? "no-type"}>
              <strong>{series.name ?? t("analytics.entry.unknownType")}</strong>
              <span>{t("analytics.media.typeDistribution", {
                type: series.name ?? t("analytics.entry.unknownType"),
                mean: formatNumber(series.mean),
                median: formatNumber(series.median),
                highShare: Math.round(series.highShare * 100),
                count: series.count,
              })}</span>
            </p>
          ))}
        </div>
        {media.highShareLeaders.length > 0 && (
          <p className="analytics-high-share">{t("analytics.media.highestHighShare", {
            types: new Intl.ListFormat(undefined, { style: "long", type: "conjunction" }).format(media.highShareLeaders.map((series) => series.name)),
            percentage: formatNumber(media.highShareLeaders[0].highShare * 100, 0),
          })}</p>
        )}
        <div className="analytics-media-comparisons" aria-live="polite">
          {media.comparisons.slice(0, 3).map((comparison) => {
            const a = media.series.find((series) => series.typeId === comparison.typeAId);
            const b = media.series.find((series) => series.typeId === comparison.typeBId);
            if (!a || !b) return null;
            const left = a.name ?? t("analytics.entry.unknownType");
            const right = b.name ?? t("analytics.entry.unknownType");
            const meanDifference = Math.abs(a.mean - b.mean);
            const comparisonValues = {
              left,
              right,
              leftMean: formatNumber(a.mean),
              rightMean: formatNumber(b.mean),
              leftMedian: formatNumber(a.median),
              rightMedian: formatNumber(b.median),
            };
            let mainText: string;
            if (comparison.kind === "imbalanced") {
              mainText = t("analytics.media.imbalance", { left, right, leftCount: comparison.nA, rightCount: comparison.nB });
            } else if (comparison.kind === "similar") {
              mainText = t("analytics.media.similar", { left, right, leftCount: comparison.nA, rightCount: comparison.nB });
            } else if (comparison.kind === "higherAverage") {
              const higher = comparison.higherTypeId === a.typeId ? a : b;
              const lower = higher === a ? b : a;
              mainText = t("analytics.media.higherAverage", {
                left: higher.name ?? t("analytics.entry.unknownType"),
                right: lower.name ?? t("analytics.entry.unknownType"),
                leftMean: formatNumber(higher.mean), rightMean: formatNumber(lower.mean),
                leftMedian: formatNumber(higher.median), rightMedian: formatNumber(lower.median),
              });
            } else if (comparison.kind === "mixed") {
              mainText = t("analytics.media.mixedDifference", comparisonValues);
            } else if (meanDifference < 0.6) {
              mainText = t("analytics.media.closeAverages", {
                ...comparisonValues,
                leftHighShare: formatNumber(a.highShare * 100, 0),
                rightHighShare: formatNumber(b.highShare * 100, 0),
              });
            } else {
              mainText = t("analytics.media.modestDifference", comparisonValues);
            }
            const values = {
              left,
              right,
              scores: comparison.modesA.join(" · "),
              leftModes: comparison.modesA.join(" · "),
              rightModes: comparison.modesB.join(" · "),
            };
            return <article className="analytics-media-comparison" key={`${comparison.typeAId}-${comparison.typeBId}`}>
              <h3 className="analytics-comparison-title">{t("analytics.media.pairTitle", { left, right })}</h3>
              <p className="analytics-comparison-main">{mainText}</p>
              <p className="analytics-comparison-peak">{t(comparison.peakRelation === "same" ? "analytics.media.samePeaks" : "analytics.media.differentPeaks", values)}</p>
            </article>;
          })}
          {media.comparisons.some((comparison) => comparison.kind !== "imbalanced") && (
            <p className="analytics-possibility">{t("analytics.media.couldReflect")}</p>
          )}
        </div>
      </section>

      {hasRankedMedia && <section className="analytics-section" data-section="ranked-media" aria-labelledby="analytics-ranked-media-title">
        <div className="analytics-section-heading">
          <div><span className="analytics-section-index">03</span><div><h2 id="analytics-ranked-media-title">{t("analytics.section.rankedMedia")}</h2><p>{t("analytics.section.rankedMediaIntro")}</p></div></div>
        </div>
        <RankedMediaChart
          tiers={rankedMedia.tiers}
          colorByType={mediaColorById}
          selected={rankedInspection}
          onSelect={setRankedInspection}
        />
      </section>}

      <section className="analytics-section" data-section="top" aria-labelledby="analytics-top-title">
        <div className="analytics-section-heading analytics-section-heading-actions">
          <div><span className="analytics-section-index">{topSectionIndex}</span><div><h2 id="analytics-top-title">{t("analytics.section.top")}</h2><p>{t("analytics.section.topIntro")}</p></div></div>
          {candidates.length > 1 && (
            <button className="analytics-refresh" onClick={refreshTopSelection} aria-label={t("analytics.top.refresh")}>
              <RefreshCw size={14} /><span>{t("analytics.top.refresh")}</span>
            </button>
          )}
        </div>
        {bestTop ? (
          <article className="analytics-top-selection">
            <header>
              <div><span className="analytics-top-kicker"><Sparkles size={13} />{t("analytics.top.count", { count: bestTop.entryIds.length })}</span>
                <h3>{t(bestTop.titleKey, { name: bestTop.values.name })}</h3>
              </div>
            </header>
            <ol>
              {bestTop.entryIds.slice(0, 5).map((id, index) => {
                const entry = entriesById.get(id);
                if (!entry) return null;
                return <li key={id}><span className="analytics-top-rank">{String(index + 1).padStart(2, "0")}</span><span className="analytics-top-title" title={entry.title}>{entry.title}</span><span className="analytics-top-score">{entry.overallRating}<small>/10</small></span></li>;
              })}
            </ol>
          </article>
        ) : (
          <div className="analytics-top-empty"><p>{t("analytics.top.noSelection")}</p><span>{t("analytics.top.noSelectionHint")}</span></div>
        )}
      </section>

      <section className="analytics-section analytics-boundary-section" data-section="boundary" aria-labelledby="analytics-boundary-title">
        <div className="analytics-section-heading">
          <div><span className="analytics-section-index">{boundarySectionIndex}</span><div><h2 id="analytics-boundary-title">{t("analytics.section.boundary")}</h2><p>{t("analytics.section.boundaryIntro")}</p></div></div>
        </div>
        {nextBoundary && boundaryHigh && boundaryLow ? (
          <>
            <p className="analytics-boundary-prompt">{t("analytics.boundary.pair", { upperScore: nextBoundary.highScore, lowerScore: nextBoundary.lowScore })}</p>
            <p className="analytics-boundary-position">{t("analytics.boundary.pairPosition", { upperScore: nextBoundary.highScore, lowerScore: nextBoundary.lowScore })}</p>
            <div className="analytics-boundary-pair">
              <BoundaryWork entry={boundaryHigh} rank="high" onEdit={onEditEntry} />
              <span className="analytics-boundary-split" aria-hidden="true">↔</span>
              <BoundaryWork entry={boundaryLow} rank="low" onEdit={onEditEntry} />
            </div>
            <div className="analytics-boundary-preview">
              <h3><ChevronDown size={14} />{t("analytics.boundary.previewTitle")}</h3>
              <p><ArrowDownRight size={14} />{t("analytics.boundary.previewUpperDown", { title: boundaryHigh.title, lowerScore: nextBoundary.lowScore })}</p>
              <p><ArrowUpRight size={14} />{t("analytics.boundary.previewLowerUp", { title: boundaryLow.title, upperScore: nextBoundary.highScore })}</p>
            </div>
            {actionError && <p className="analytics-action-error" role="alert">{actionError}</p>}
            <div className="analytics-boundary-actions">
              <button className="button secondary" disabled={busy} onClick={() => void runBoundaryAction(() => onConfirmReview(nextBoundary.fingerprint))}><Check size={14} />{t("analytics.boundary.keepBoth")}</button>
              <button className="button secondary" aria-label={t("analytics.boundary.moveDownLabel", { title: boundaryHigh.title, lowerScore: nextBoundary.lowScore })} disabled={busy} onClick={() => void runBoundaryAction(() => onMoveEntry(boundaryHigh.id, nextBoundary.lowScore, true, { kind: "start" }))}>{t("analytics.boundary.moveDownShort", { upperScore: nextBoundary.highScore, lowerScore: nextBoundary.lowScore })}</button>
              <button className="button secondary" aria-label={t("analytics.boundary.moveUpLabel", { title: boundaryLow.title, upperScore: nextBoundary.highScore })} disabled={busy} onClick={() => void runBoundaryAction(() => onMoveEntry(boundaryLow.id, nextBoundary.highScore, true, { kind: "end" }))}>{t("analytics.boundary.moveUpShort", { lowerScore: nextBoundary.lowScore, upperScore: nextBoundary.highScore })}</button>
            </div>
            {busy && <p className="analytics-boundary-busy" role="status">{t("analytics.boundary.saving")}</p>}
          </>
        ) : firstBoundary ? (
          <div className="analytics-boundary-empty">
            <p>{t("analytics.boundary.empty")}</p>
            <span>{t("analytics.boundary.emptyHint")}</span>
            {hasUnplacedBoundary && <><p className="analytics-boundary-place-hint">{t("analytics.boundary.placedFirst")}</p><button className="analytics-text-action" onClick={onOpenRanking}>{t("analytics.boundary.openRanking")}</button></>}
            <button className="analytics-text-action" onClick={() => void runBoundaryAction(onResetReviews)} disabled={busy}>{t("analytics.boundary.resetReviews")}</button>
          </div>
        ) : hasUnplacedBoundary ? (
          <div className="analytics-boundary-empty"><p>{t("analytics.boundary.placedFirst")}</p><button className="analytics-text-action" onClick={onOpenRanking}>{t("analytics.boundary.openRanking")}</button></div>
        ) : (
          <div className="analytics-boundary-empty"><p>{t("analytics.boundary.noPair")}</p></div>
        )}
      </section>

      {inspection && (
        <Modal title={inspection.kind === "rating"
          ? t("analytics.chart.ratingContributors", { score: inspection.score })
          : t("analytics.chart.mediaContributors", {
              type: media.series.find((series) => series.typeId === inspection.typeId)?.name ?? t("analytics.entry.unknownType"),
              score: inspection.score,
            })} onClose={() => setInspection(null)}>
          <div className="analytics-inspection-body">{ratingsForInspection.length ? (
            <ul className="analytics-inspection-list">{ratingsForInspection.map((entry) => <li key={entry.id}><span>{entry.title}</span><span>{entry.overallRating}<small>/10</small></span></li>)}</ul>
          ) : <p className="analytics-inspection-empty">{t("analytics.chart.noContributors")}</p>}</div>
        </Modal>
      )}
      {rankedInspection !== null && (
        <RankedMediaInspection
          tier={rankedMedia.tiers.find((tier) => tier.score === rankedInspection)}
          onClose={() => setRankedInspection(null)}
        />
      )}
    </div>
  );
}

function Histogram({
  counts,
  percentages,
  total,
  selected,
  onSelect,
}: {
  counts: number[];
  percentages: number[];
  total: number;
  selected: number | null;
  onSelect: (score: number) => void;
}) {
  const gradientId = `analytics-rating-gradient-${useId().replaceAll(":", "")}`;
  const width = 820;
  const height = 284;
  const left = 45;
  const right = 16;
  const top = 14;
  const bottom = 56;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const axis = niceAxis(Math.max(...counts));
  const occupiedScores = counts.flatMap((count, index) => count > 0 ? [index] : []);
  const step = plotWidth / occupiedScores.length;
  const barWidth = Math.min(47, step * 0.64);
  return (
    <>
    <div className="analytics-chart-wrap">
      <svg className="analytics-chart analytics-histogram" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("analytics.chart.ratingDistribution", { count: total })}>
        <defs><linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stopColor="var(--analytics-violet)" stopOpacity=".48" /><stop offset="100%" stopColor="var(--analytics-cyan)" stopOpacity=".94" /></linearGradient></defs>
        {axis.ticks.map((tick) => {
          const y = top + plotHeight - (tick / axis.top) * plotHeight;
          return <g key={tick}><line x1={left} x2={width - right} y1={y} y2={y} className="analytics-chart-grid" /><text x={left - 10} y={y + 4} textAnchor="end" className="analytics-axis-text analytics-y-tick">{tick}</text></g>;
        })}
        {occupiedScores.map((index, position) => {
          const count = counts[index];
          const score = index + 1;
          const barHeight = (count / axis.top) * plotHeight;
          const x = left + position * step + (step - barWidth) / 2;
          const y = top + plotHeight - barHeight;
          const percentage = percentages[index] ?? 0;
          const label = t("analytics.chart.countShareAtScore", { score, count, percentage: formatNumber(percentage, 1) });
          return <g key={score} data-score={score} data-count={count} className={`analytics-histogram-bin${selected === score ? " selected" : ""}`} role="button" tabIndex={0} aria-label={label} aria-pressed={selected === score} onClick={() => onSelect(score)} onKeyDown={(event) => focusKey(event, () => onSelect(score))}>
            <rect className="analytics-bin-hit" x={left + position * step + 1} y={top} width={step - 2} height={plotHeight + 49} rx="5" />
            <rect className="analytics-bin-bar" x={x} y={y} width={barWidth} height={Math.max(3, barHeight)} rx="7" style={{ fill: `url(#${gradientId})` }}><title>{label}</title></rect>
            <text x={x + barWidth / 2} y={y - 7} className="analytics-bin-count" textAnchor="middle">{count}</text>
            <text x={left + position * step + step / 2} y={top + plotHeight + 21} className="analytics-axis-text" textAnchor="middle">{score}</text>
            <text x={left + position * step + step / 2} y={top + plotHeight + 36} className="analytics-bin-share" textAnchor="middle">{formatNumber(percentage, 1)}%</text>
          </g>;
        })}
        <text x={left + plotWidth / 2} y={height - 3} className="analytics-axis-title" textAnchor="middle">{t("analytics.chart.ratingAxis")}</text>
        <text x="11" y={top + plotHeight / 2} className="analytics-axis-title" textAnchor="middle" transform={`rotate(-90 11 ${top + plotHeight / 2})`}>{t("analytics.chart.countAxis")}</text>
      </svg>
    </div>
    <p className="analytics-chart-swipe-hint"><MoveHorizontal size={14} aria-hidden="true" />{t("analytics.chart.mobileScrollHint")}</p>
    </>
  );
}

const seriesColors = Array.from({ length: 10 }, (_, index) => `var(--analytics-series-${index + 1})`);

function RankedMediaChart({
  tiers,
  colorByType,
  selected,
  onSelect,
}: {
  tiers: RankedTierMediaDistributionTier[];
  colorByType: Map<string, string>;
  selected: number | null;
  onSelect: (score: number) => void;
}) {
  const width = 820;
  const height = 302;
  const left = 48;
  const right = 16;
  const top = 14;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const occupiedTiers = tiers.filter((tier) => tier.totalRated > 0);
  const step = plotWidth / occupiedTiers.length;
  const xAt = (index: number) => left + step * (index + 0.5);
  const byType = new Map<string, { typeId: string | null; name: string | null }>();
  for (const tier of occupiedTiers) {
    if (!tier.available) continue;
    for (const item of tier.series) {
      if (item.count > 0 && item.score !== null) {
        byType.set(item.typeId ?? "__no-type__", { typeId: item.typeId, name: item.name });
      }
    }
  }
  const types = [...byType.entries()];
  const formatWeight = (weight: number) => formatNumber(weight, 2);
  const typeName = (item: { typeId: string | null; name: string | null }) =>
    item.name ?? (item.typeId ? mediaTypeName(item.typeId, item.typeId) : t("analytics.entry.unknownType"));
  const yAt = (weight: number) => top + plotHeight * (1 - weight);

  const plottedTypes = types.map(([id, type]) => {
    const points = occupiedTiers.map((tier, index) => {
      const item = tier.series.find((entry) => (entry.typeId ?? "__no-type__") === id);
      return {
        tier,
        item,
        x: xAt(index),
        y: item && tier.available && item.count > 0 && item.score !== null ? yAt(item.score) : null,
      };
    });
    const runs: typeof points[] = [];
    let current: typeof points = [];
    for (const point of points) {
      if (point.y === null) {
        if (current.length > 1) runs.push(current);
        current = [];
      } else {
        current.push(point);
      }
    }
    if (current.length > 1) runs.push(current);
    return { id, type, points, runs };
  });

  return <>
    <div className="analytics-chart-wrap">
      <svg className="analytics-chart analytics-ranked-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("analytics.ranked.chartLabel")}>
        {[0, .25, .5, .75, 1].map((tick) => {
          const y = top + plotHeight * (1 - tick);
          return <g key={tick}><line x1={left} x2={width - right} y1={y} y2={y} className="analytics-ranked-grid" /><text x={left - 9} y={y + 4} className="analytics-axis-text analytics-y-tick" textAnchor="end">{formatWeight(tick)}</text></g>;
        })}
        {occupiedTiers.map((tier, index) => {
          const x = xAt(index);
          return <g key={tier.score} data-score={tier.score} data-available={tier.available} data-coverage={tier.coverage} data-total-rated={tier.totalRated} data-ranked-count={tier.rankedCount} className="analytics-ranked-position">
            {!tier.available && <>
              <line x1={x} x2={x} y1={top + 8} y2={top + plotHeight - 7} className="analytics-ranked-unavailable-guide" />
              <line x1={x - 4} x2={x + 4} y1={top + plotHeight / 2} y2={top + plotHeight / 2} className="analytics-ranked-gap-mark" />
            </>}
            <text x={x} y={top + plotHeight + 19} className="analytics-axis-text analytics-ranked-score" textAnchor="middle">{tier.score}</text>
            <text x={x} y={top + plotHeight + 36} className="analytics-bin-share analytics-ranked-coverage" textAnchor="middle">{formatCoverage(tier.coverage)}%</text>
          </g>;
        })}
        {plottedTypes.map(({ id, type, points, runs }) => {
          const color = colorByType.get(id) ?? seriesColors[0];
          return <g key={id} data-type-id={type.typeId ?? "__no-type__"} style={{ "--analytics-series-color": color } as CSSProperties}>
            {runs.map((run, runIndex) => <polyline key={runIndex} data-type-id={type.typeId ?? "__no-type__"} className="analytics-ranked-line" points={run.map((point) => `${point.x},${point.y}`).join(" ")} />)}
            {points.flatMap(({ tier, item, x, y }) => {
              if (!item || y === null || item.score === null) return [];
              const ariaLabel = t("analytics.ranked.seriesAria", {
                type: typeName(type),
                score: tier.score,
                meanRank: item.meanRank === null ? t("analytics.ranked.noMeanRank") : formatNumber(item.meanRank),
                count: item.count,
                ratedCount: item.ratedCount,
                weight: formatWeight(item.score),
                excludedCount: item.excludedPlacedCount,
              });
              return [<g key={tier.score} data-score={tier.score} data-type-id={type.typeId ?? "__no-type__"} data-mean-rank={item.meanRank ?? ""} data-weight={item.score} data-ranked-count={item.count} data-rated-count={item.ratedCount} data-excluded-count={item.excludedPlacedCount} className={`analytics-ranked-point${selected === tier.score ? " selected" : ""}`} role="button" tabIndex={0} aria-label={ariaLabel} aria-pressed={selected === tier.score} onClick={() => onSelect(tier.score)} onKeyDown={(event) => focusKey(event, () => onSelect(tier.score))}>
                <circle cx={x} cy={y} r="10" className="analytics-point-hit" />
                <circle cx={x} cy={y} r="3.4" className="analytics-point-visible"><title>{ariaLabel}</title></circle>
              </g>];
            })}
          </g>;
        })}
        <text x={left + plotWidth / 2} y={height - 2} className="analytics-axis-title" textAnchor="middle">{t("analytics.chart.ratingAxis")}</text>
        <text x="11" y={top + plotHeight / 2} className="analytics-axis-title" textAnchor="middle" transform={`rotate(-90 11 ${top + plotHeight / 2})`}>{t("analytics.ranked.weightAxis")}</text>
      </svg>
    </div>
    <p className="analytics-chart-swipe-hint"><MoveHorizontal size={14} aria-hidden="true" />{t("analytics.chart.mobileScrollHint")}</p>
    {types.length > 0 && <div className="analytics-ranked-legend" role="list" aria-label={t("analytics.chart.mediaDistribution")}>
      {types.map(([id, item]) => {
        return <span role="listitem" key={id} style={{ "--analytics-series-color": colorByType.get(id) ?? seriesColors[0] } as CSSProperties}><i aria-hidden="true" />{typeName(item)}</span>;
      })}
    </div>}
    <p className="analytics-ranked-note">{t("analytics.ranked.method")}</p>
    <p className="analytics-ranked-note">{t("analytics.ranked.coverageLegend")}</p>
    <p className="analytics-ranked-note">{t("analytics.ranked.gapNote")}</p>
  </>;
}

function RankedMediaInspection({
  tier,
  onClose,
}: {
  tier: RankedTierMediaDistributionTier | undefined;
  onClose: () => void;
}) {
  if (!tier) return null;
  const formatWeight = (weight: number) => formatNumber(weight, 2);
  const title = t("analytics.ranked.inspectTier", { score: tier.score });
  const typeName = (item: { typeId: string | null; name: string | null }) =>
    item.name ?? (item.typeId ? mediaTypeName(item.typeId, item.typeId) : t("analytics.entry.unknownType"));
  return <Modal title={title} onClose={onClose}>
    <div className="analytics-inspection-body analytics-ranked-detail">
      <p>{t("analytics.ranked.coverageSummary", {
        rankedCount: tier.rankedCount,
        totalRated: tier.totalRated,
        percentage: formatCoverage(tier.coverage),
      })}</p>
      {!tier.available && <p>{t("analytics.ranked.unavailableTier")}</p>}
      {tier.totalRated > tier.rankedCount && <p>{t("analytics.ranked.unplacedNote", { count: tier.totalRated - tier.rankedCount })}</p>}
      {tier.series.length > 0 ? <table>
        <thead><tr><th>{t("analytics.ranked.columnType")}</th><th>{t("analytics.ranked.columnMeanRank")}</th><th>{t("analytics.ranked.columnCount")}</th><th>{t("analytics.ranked.columnWeight")}</th></tr></thead>
        <tbody>{tier.series.map((item) => {
          const excluded = item.score === 0 || item.score === null;
          const reasonKey = item.excludedReason === "unplaced" ? "analytics.ranked.excludedUnplaced" : item.excludedReason === "sparseRelative" ? "analytics.ranked.excludedSparse" : null;
          return <tr key={item.typeId ?? "__no-type__"} data-excluded={excluded}>
            <td>{typeName(item)}{reasonKey && <small className="analytics-ranked-exclusion">{t(reasonKey, { count: item.excludedPlacedCount || item.unplacedCount })}</small>}</td>
            <td>{item.meanRank === null ? "–" : formatNumber(item.meanRank)}</td>
            <td>{t("analytics.ranked.rankedVsRated", { ranked: item.count, rated: item.ratedCount })}</td>
            <td>{item.score === null ? "–" : formatWeight(item.score)}</td>
          </tr>;
        })}</tbody>
      </table> : <p>{t("analytics.ranked.noWorksAtTier")}</p>}
    </div>
  </Modal>;
}

function MediaChart({
  series,
  colorByType,
  hiddenTypes,
  onToggleType,
  selected,
  onSelect,
}: {
  series: Array<{ typeId: string | null; name: string | null; count: number; counts: number[] }>;
  colorByType: Map<string, string>;
  hiddenTypes: Set<string>;
  onToggleType: (typeId: string) => void;
  selected: { typeId: string | null; score: number } | null;
  onSelect: (typeId: string | null, score: number) => void;
}) {
  const visible = series.filter((item) => item.count >= 5);
  if (!visible.length) return <p className="analytics-chart-empty">{t("analytics.chart.noEligibleTypes")}</p>;
  const width = 820;
  const height = 284;
  const left = 45;
  const right = 16;
  const top = 14;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const scoreIndices = Array.from({ length: 10 }, (_, index) => index).filter((index) =>
    visible.some((item) => item.counts[index] > 0),
  );
  const step = plotWidth / scoreIndices.length;
  const positionByIndex = new Map(scoreIndices.map((index, position) => [index, position]));
  const maxCount = Math.max(...visible.flatMap((item) => item.counts));
  const axis = niceAxis(maxCount);
  const x = (index: number) => left + ((positionByIndex.get(index) ?? 0) + 0.5) * step;
  const y = (count: number) => top + plotHeight - (count / axis.top) * plotHeight;
  return (
    <>
      <div className="analytics-chart-wrap">
        <svg className="analytics-chart analytics-media-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("analytics.chart.mediaDistribution")}>
          {axis.ticks.map((tick) => <g key={tick}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="analytics-chart-grid" /><text x={left - 10} y={y(tick) + 4} className="analytics-axis-text analytics-y-tick" textAnchor="end">{tick}</text></g>)}
          {scoreIndices.map((index) => <text key={index + 1} data-score={index + 1} x={x(index)} y={top + plotHeight + 21} className="analytics-axis-text analytics-media-score" textAnchor="middle">{index + 1}</text>)}
          {visible.map((item) => {
            const id = item.typeId ?? "__no-type__";
            if (hiddenTypes.has(id)) return null;
            const label = item.name ?? t("analytics.entry.unknownType");
            const color = colorByType.get(id) ?? seriesColors[0];
            const points = scoreIndices.map((index) => `${x(index)},${y(item.counts[index])}`).join(" ");
            return <g key={id} style={{ "--analytics-series-color": color } as CSSProperties}>
              <polyline points={points} className="analytics-series-line" />
              {scoreIndices.map((index) => {
                const count = item.counts[index];
                const score = index + 1;
                const ariaLabel = t("analytics.chart.seriesAtScore", { type: label, score, count });
                return <g key={score} data-score={score} data-type-id={item.typeId ?? "__no-type__"} data-count={count} className={`analytics-series-point${selected?.typeId === item.typeId && selected.score === score ? " selected" : ""}`} role="button" tabIndex={0} aria-label={ariaLabel} aria-pressed={selected?.typeId === item.typeId && selected.score === score} onClick={() => onSelect(item.typeId, score)} onKeyDown={(event) => focusKey(event, () => onSelect(item.typeId, score))}>
                  <circle cx={x(index)} cy={y(count)} r="10" className="analytics-point-hit" />
                  <circle cx={x(index)} cy={y(count)} r="3.4" className="analytics-point-visible"><title>{ariaLabel}</title></circle>
                </g>;
              })}
            </g>;
          })}
          <text x={left + plotWidth / 2} y={height - 3} className="analytics-axis-title" textAnchor="middle">{t("analytics.chart.ratingAxis")}</text>
          <text x="11" y={top + plotHeight / 2} className="analytics-axis-title" textAnchor="middle" transform={`rotate(-90 11 ${top + plotHeight / 2})`}>{t("analytics.chart.countAxis")}</text>
        </svg>
      </div>
      <p className="analytics-chart-swipe-hint"><MoveHorizontal size={14} aria-hidden="true" />{t("analytics.chart.mobileScrollHint")}</p>
      <div className="analytics-media-legend" role="group" aria-label={t("analytics.chart.mediaDistribution")}>
        {visible.map((item) => {
          const id = item.typeId ?? "__no-type__";
          const hidden = hiddenTypes.has(id);
          return <button key={id} aria-pressed={!hidden} onClick={() => onToggleType(id)} style={{ "--analytics-series-color": colorByType.get(id) ?? seriesColors[0] } as CSSProperties}>
            <i aria-hidden="true" />{item.name ?? t("analytics.entry.unknownType")}<small>{t(item.count < 20 ? "analytics.chart.typeSample" : "analytics.chart.sampleCount", { count: item.count })}</small>
          </button>;
        })}
      </div>
      {series.some((item) => item.count < 5) && <p className="analytics-small-type-note">{t("analytics.chart.hiddenSmallTypes")}</p>}
    </>
  );
}

function BoundaryWork({ entry, rank, onEdit }: { entry: Entry; rank: "high" | "low"; onEdit: (entryId: string) => void }) {
  return <article className="analytics-boundary-work">
    <span className="analytics-boundary-tier">{entry.overallRating}<small>/10</small></span>
    <div><span>{rank === "high" ? t("analytics.boundary.lowestInTier") : t("analytics.boundary.highestInTier")}</span><strong title={entry.title}>{entry.title}</strong></div>
    <button className="analytics-edit-work" aria-label={t(rank === "high" ? "analytics.boundary.editUpper" : "analytics.boundary.editLower", { title: entry.title })} onClick={() => onEdit(entry.id)}>{t("analytics.boundary.editShort")}</button>
  </article>;
}
