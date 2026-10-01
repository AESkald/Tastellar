import { describe, expect, it } from "vitest";
import {
  resolveRankingDropPosition,
  shouldSuggestBinaryPlacement,
} from "./ranking";

describe("ranking placement helpers", () => {
  it("suggests binary placement at 90% placed when there is an unplaced work", () => {
    expect(shouldSuggestBinaryPlacement({ placed: 9, unplaced: 1 })).toBe(true);
    expect(shouldSuggestBinaryPlacement({ placed: 8, unplaced: 1 })).toBe(false);
  });

  it("does not suggest placement when the tier has no unplaced work", () => {
    expect(shouldSuggestBinaryPlacement({ placed: 12, unplaced: 0 })).toBe(
      false,
    );
    expect(shouldSuggestBinaryPlacement({ placed: 0, unplaced: 0 })).toBe(
      false,
    );
  });

  it("represents exact anchored drops and appends when the target is empty", () => {
    expect(resolveRankingDropPosition("b", "after")).toEqual({
      kind: "after",
      anchorId: "b",
    });
    expect(resolveRankingDropPosition(null)).toEqual({ kind: "end" });
  });
});
