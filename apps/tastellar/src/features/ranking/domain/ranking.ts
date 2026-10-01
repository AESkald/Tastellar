export interface RankingCounts {
  placed: number;
  unplaced: number;
}

/** Suggest binary placement when most works in a tier already have an order. */
export function shouldSuggestBinaryPlacement({
  placed,
  unplaced,
}: RankingCounts): boolean {
  const total = placed + unplaced;
  return unplaced > 0 && total > 0 && placed / total >= 0.9;
}

export type RankingDropPosition =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "before" | "after"; anchorId: string };

/** Resolve a card/drop-zone target without relying on display rank numbers. */
export function resolveRankingDropPosition(
  targetId: string | null,
  side: "before" | "after" = "before",
): RankingDropPosition {
  if (!targetId) return { kind: "end" };
  return { kind: side, anchorId: targetId };
}
