import { describe, expect, it } from "vitest";
import { deriveTasteRadar, type TasteEntryEvidence } from "./taste";

const labels = {
  story: "Story",
  acting: "Acting",
  visuals: "Visuals",
  sound: "Sound",
};

function evidence(
  rating: number | null,
  criterionScores: TasteEntryEvidence["criterionScores"],
  id = "e",
): TasteEntryEvidence {
  return { id, overallRating: rating, criterionScores };
}

describe("deriveTasteRadar", () => {
  it("weights favorite criterion scores by overall rating minus seven and excludes missing scores", () => {
    const entries = [
      evidence(8, { story: 2 }, "a"),
      evidence(10, { story: 8 }, "b"),
      evidence(7, { story: 10 }, "c"),
      evidence(null, { story: 10 }, "d"),
      evidence(9, { acting: 6 }, "e"),
    ];
    const result = deriveTasteRadar({
      entries,
      criterionLabels: labels,
      tasteInputs: {},
      selectedCriterionIds: ["story", "acting"],
    });

    // (1 × 2 + 3 × 8) / (1 + 3) = 6.5; the 7-rated and unrated items do not contribute.
    expect(
      result.derived.allAxes.find((axis) => axis.criterionId === "story"),
    ).toMatchObject({
      value: 6.5,
      sampleCount: 2,
      eligible: true,
    });
    expect(
      result.derived.allAxes.find((axis) => axis.criterionId === "acting"),
    ).toMatchObject({ sampleCount: 1, value: 6 });
  });

  it("shows 1–2 selected favorite qualities as bars and three or more as a radar", () => {
    const entries: TasteEntryEvidence[] = Array.from(
      { length: 5 },
      (_, index) => ({
        id: String(index),
        overallRating: 8,
        criterionScores: {
          story: 7,
          acting: 8,
          visuals: 9,
          ...(index < 4 ? { sound: 5 } : {}),
        },
      }),
    );
    const result = deriveTasteRadar({
      entries,
      criterionLabels: labels,
      tasteInputs: {},
      selectedCriterionIds: ["story", "acting", "visuals", "sound"],
    });

    expect(result.derived.qualifyingAxisCount).toBe(4);
    expect(result.derived.mode).toBe("radar");
    expect(
      result.derived.allAxes.find((axis) => axis.criterionId === "sound"),
    ).toMatchObject({ sampleCount: 4, eligible: true });
    const one = deriveTasteRadar({
      entries: [entries[0]],
      criterionLabels: labels,
      tasteInputs: {},
      selectedCriterionIds: ["story"],
    });
    expect(one.derived.mode).toBe("bars");
    expect(one.derived.axes.map((axis) => axis.criterionId)).toEqual([
      "story",
    ]);
  });

  it("shows one or two explicit inputs as bars, three as a radar, and caps visible axes at eight", () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `c${index}`,
        `Criterion ${index}`,
      ]),
    );
    const two = deriveTasteRadar({
      entries: [],
      criterionLabels: criteria,
      tasteInputs: { c0: 7, c1: 4 },
    });
    const three = deriveTasteRadar({
      entries: [],
      criterionLabels: criteria,
      tasteInputs: { c0: 7, c1: 4, c2: 8, c3: 3 },
    });

    expect(two.explicit.mode).toBe("bars");
    expect(three.explicit.mode).toBe("radar");
    expect(three.explicit.axes).toHaveLength(4);
    expect(three.explicit.allAxes).toHaveLength(4);

    const capped = deriveTasteRadar({
      entries: [],
      criterionLabels: criteria,
      tasteInputs: Object.fromEntries(
        Object.keys(criteria).map((key) => [key, 5]),
      ),
    });
    expect(capped.explicit.axes).toHaveLength(8);
    expect(capped.explicit.allAxes).toHaveLength(10);
    expect(
      deriveTasteRadar({
        entries: [],
        criterionLabels: criteria,
        tasteInputs: { c0: 7.5 },
      }).explicit.allAxes,
    ).toEqual([]);
  });

  it("shows only selected derived axes and omits qualities with no favorite scores", () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      overallRating: 9,
      criterionScores: {
        story: 7,
        acting: 8,
        visuals: 9,
        sound: index < 4 ? 6 : undefined,
      },
    }));
    const result = deriveTasteRadar({
      entries,
      criterionLabels: labels,
      tasteInputs: {},
      selectedCriterionIds: ["story", "acting"],
    });

    expect(result.derived.axes.map((axis) => axis.criterionId)).toEqual(["story", "acting"]);
    expect(
      result.derived.allAxes.find((axis) => axis.criterionId === "sound"),
    ).toBeUndefined();
    expect(result.derived.mode).toBe("bars");
  });

  it("keeps absent importance inputs absent and does not invent derived values", () => {
    const result = deriveTasteRadar({
      entries: [],
      criterionLabels: labels,
      tasteInputs: {},
    });
    expect(result.explicit).toMatchObject({
      mode: "empty",
      axes: [],
      allAxes: [],
    });
    expect(result.derived).toMatchObject({
      mode: "empty",
      axes: [],
      allAxes: [],
      qualifyingAxisCount: 0,
    });
  });
});
