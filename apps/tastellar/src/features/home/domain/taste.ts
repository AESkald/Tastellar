/** Pure Home taste chart derivation. Inputs are expected to contain only active
 * criterion values; retained scores for inactive criteria must be filtered by
 * the caller at the data boundary. */

export interface TasteEntryEvidence {
  id: string;
  overallRating: number | null;
  /** Criterion ID to active 1–10 score. Missing values are excluded. */
  criterionScores: Readonly<Record<string, number | undefined>>;
}

export interface TasteAxis {
  criterionId: string;
  label: string;
  value: number | null;
  sampleCount: number;
  eligible: boolean;
}

export interface TasteRadarResult {
  explicit: {
    mode: "empty" | "bars" | "radar";
    axes: TasteAxis[];
    /** All explicitly selected values, suitable for an accessible table. */
    allAxes: TasteAxis[];
  };
  derived: {
    mode: "empty" | "bars" | "radar";
    axes: TasteAxis[];
    /** Selected criteria with at least one observed favorite score. */
    allAxes: TasteAxis[];
    qualifyingAxisCount: number;
  };
}

export interface DeriveTasteRadarArgs {
  entries: readonly TasteEntryEvidence[];
  criterionLabels: Readonly<Record<string, string>>;
  /** Absence means unselected; explicit zero is not a supported score. */
  tasteInputs: Readonly<Record<string, number>>;
  /** Optional visible axis selection. Values remain available in allAxes. */
  selectedCriterionIds?: readonly string[];
}

const MAX_VISIBLE_AXES = 8;
const MIN_RADAR_AXES = 3;

function labelFor(
  id: string,
  labels: Readonly<Record<string, string>>,
): string {
  return labels[id] ?? id;
}

function visibleAxes<T extends TasteAxis>(
  axes: readonly T[],
  selectedIds?: readonly string[],
): T[] {
  if (selectedIds) {
    const byId = new Map(axes.map((axis) => [axis.criterionId, axis]));
    return selectedIds
      .flatMap((id) => {
        const axis = byId.get(id);
        return axis ? [axis] : [];
      })
      .slice(0, MAX_VISIBLE_AXES);
  }
  return [...axes]
    .sort((a, b) =>
      a.criterionId < b.criterionId
        ? -1
        : a.criterionId > b.criterionId
          ? 1
          : 0,
    )
    .slice(0, MAX_VISIBLE_AXES);
}

/**
 * Derive explicit importance and observed favorite-quality views separately.
 * Favorite scores use (overall rating - 7) as their weight and include only
 * active criterion values on experienced entries rated 8–10.
 */
export function deriveTasteRadar(args: DeriveTasteRadarArgs): TasteRadarResult {
  const { entries, criterionLabels, tasteInputs, selectedCriterionIds } = args;

  const allExplicitAxes = Object.entries(tasteInputs)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([, value]) => Number.isInteger(value) && value >= 1 && value <= 10)
    .map(([criterionId, value]) => ({
      criterionId,
      label: labelFor(criterionId, criterionLabels),
      value,
      sampleCount: 0,
      eligible: true,
    }));
  const explicitVisible = visibleAxes(allExplicitAxes, selectedCriterionIds);
  const chosenCount = explicitVisible.length;

  const accumulators = new Map<
    string,
    { weightedTotal: number; totalWeight: number; count: number }
  >();
  for (const entry of entries) {
    if (
      entry.overallRating === null ||
      entry.overallRating < 8 ||
      entry.overallRating > 10
    )
      continue;
    const weight = entry.overallRating - 7;
    for (const [criterionId, score] of Object.entries(entry.criterionScores)) {
      if (
        score === undefined ||
        !Number.isInteger(score) ||
        score < 1 ||
        score > 10
      )
        continue;
      const current = accumulators.get(criterionId) ?? {
        weightedTotal: 0,
        totalWeight: 0,
        count: 0,
      };
      current.weightedTotal += weight * score;
      current.totalWeight += weight;
      current.count += 1;
      accumulators.set(criterionId, current);
    }
  }

  const allDerivedAxes = Object.keys(criterionLabels)
    .sort()
    .map((criterionId) => {
      const acc = accumulators.get(criterionId);
      const sampleCount = acc?.count ?? 0;
      return {
        criterionId,
        label: labelFor(criterionId, criterionLabels),
        value:
          acc && acc.totalWeight > 0
            ? acc.weightedTotal / acc.totalWeight
            : null,
        sampleCount,
        eligible: sampleCount > 0,
      };
    })
    .filter((axis) => axis.sampleCount > 0);
  // Favorites axes are opt-in through the user's chart selection. Do not
  // silently populate the chart with every criterion that happens to have data.
  const derivedVisible = visibleAxes(
    allDerivedAxes.filter((axis) => axis.eligible),
    selectedCriterionIds ?? [],
  );
  const qualifyingAxisCount = derivedVisible.length;

  return {
    explicit: {
      mode:
        chosenCount === 0
          ? "empty"
          : chosenCount < MIN_RADAR_AXES
            ? "bars"
            : "radar",
      axes: explicitVisible,
      allAxes: allExplicitAxes,
    },
    derived: {
      mode:
        derivedVisible.length === 0
          ? "empty"
          : derivedVisible.length < MIN_RADAR_AXES
            ? "bars"
            : "radar",
      axes: derivedVisible,
      allAxes: derivedVisible,
      qualifyingAxisCount,
    },
  };
}
