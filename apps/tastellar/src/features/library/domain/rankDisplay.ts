export interface RankedTierOrder {
  score: number;
  placedIds: readonly string[];
}

export interface LibraryRankIndex {
  withinScore: Map<string, number>;
  overall: Map<string, number>;
  totalPlaced: number;
}

/** Build rank positions only from explicit placed IDs supplied by Ranking. */
export function buildLibraryRankIndex(
  entries: readonly {
    id: string;
    disposition: string;
    overallRating: number | null;
  }[],
  tiers: readonly RankedTierOrder[] | null,
): LibraryRankIndex {
  const withinScore = new Map<string, number>();
  const overall = new Map<string, number>();
  if (!tiers) {
    return {
      withinScore,
      overall,
      totalPlaced: 0,
    };
  }

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const seenPlaced = new Set<string>();
  let overallPosition = 0;
  for (const tier of [...tiers].sort((a, b) => b.score - a.score)) {
    const placedIds: string[] = [];
    for (const id of tier.placedIds) {
      const entry = entriesById.get(id);
      if (
        !entry ||
        entry.disposition !== "experienced" ||
        entry.overallRating !== tier.score ||
        seenPlaced.has(id)
      )
        continue;
      seenPlaced.add(id);
      placedIds.push(id);
      withinScore.set(id, placedIds.length);
      overall.set(id, ++overallPosition);
    }
  }

  return {
    withinScore,
    overall,
    totalPlaced: overallPosition,
  };
}

/** Sort by actual placement, then immutable import order for unplaced works. */
export function sortEntriesByRank<T extends { id: string }>(
  entries: readonly T[],
  sourceEntries: readonly { id: string; importOrder?: number | null }[],
  overallRanks: ReadonlyMap<string, number>,
): T[] {
  const sourceOrder = new Map(
    sourceEntries.map((entry, index) => [
      entry.id,
      { index, importOrder: entry.importOrder },
    ]),
  );
  return [...entries].sort((a, b) => {
    const rankA = overallRanks.get(a.id);
    const rankB = overallRanks.get(b.id);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    const sourceA = sourceOrder.get(a.id);
    const sourceB = sourceOrder.get(b.id);
    const orderA = sourceA?.importOrder ?? sourceA?.index ?? Number.MAX_SAFE_INTEGER;
    const orderB = sourceB?.importOrder ?? sourceB?.index ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });
}
