import { describe, expect, it } from "vitest";
import {
  buildRecommendationPrompt,
  MandatoryPromptExceedsBudgetError,
  type RecommendationEntryEvidence,
} from "./prompt";
import { t } from "../../../shared/ui/i18n";

const base = {
  profile: { nickname: "Mira", statedTastes: "I enjoy thoughtful mysteries." },
  guidelines: {
    "10": "A lasting favorite",
    "8": "Very good",
    "7": "Solid",
    "6": "  ",
  },
  tasteInputs: { story: 9 },
  criterionLabels: { story: "Story" },
  message: t,
};

function entry(
  id: string,
  overallRating: number,
  withinScoreRank: number,
  extra: Partial<RecommendationEntryEvidence> = {},
): RecommendationEntryEvidence {
  return {
    id,
    title: id,
    disposition: "experienced",
    overallRating,
    withinScoreRank,
    ...extra,
  };
}

describe("buildRecommendationPrompt", () => {
  it("builds an honest empty-library prompt and omits blank guidelines", () => {
    const result = buildRecommendationPrompt({ ...base, entries: [] });
    expect(result.text).toContain("Recommend 10 unfamiliar works");
    expect(result.text).toContain("I enjoy thoughtful mysteries.");
    expect(result.text).toContain("No library entries yet.");
    expect(result.text).toContain("- 10/10: A lasting favorite");
    expect(result.text).not.toContain("6/10:");
    expect(result.text).not.toContain("Untitled");
  });

  it("orders every rated work by descending score and persisted tier order across media types", () => {
    const entries = [
      entry("meters", 7, 1, { title: "100 Meters", mediaType: "Film" }),
      entry("aot", 10, 1, { title: "Attack on Titan", mediaType: "Anime" }),
      entry("players", 8, 1, { title: "1000 Players", mediaType: "Game" }),
      entry("arcane", 9, 1, { title: "Arcane", mediaType: "Series" }),
      entry("book", 10, 4, { title: "The Left Hand of Darkness", mediaType: "Literature" }),
      entry("manga", 10, 2, { title: "Witch Hat Atelier", mediaType: "Manga" }),
      entry("game", 10, 3, { title: "Outer Wilds", mediaType: "Game" }),
    ];
    const result = buildRecommendationPrompt({
      ...base,
      entries,
      rankingTiers: [
        { score: 10, placedIds: ["game", "manga", "aot"], unplacedIds: ["book"] },
        { score: 9, placedIds: ["arcane"], unplacedIds: [] },
        { score: 8, placedIds: ["players"], unplacedIds: [] },
        { score: 7, placedIds: ["meters"], unplacedIds: [] },
      ],
      options: { includeMediaType: true },
    });
    const evidence = result.text
      .split(t("home.promptRankedEvidenceHeading"))[1]
      .split(t("home.promptExclusionsHeading"))[0];
    const evidenceLines = evidence
      .split("\n")
      .filter((line) => line.startsWith("- "));

    expect(evidenceLines).toEqual([
      t("home.promptEntryRatedWithType", { title: "Outer Wilds", rating: 10, type: "Game" }),
      t("home.promptEntryRatedWithType", { title: "Witch Hat Atelier", rating: 10, type: "Manga" }),
      t("home.promptEntryRatedWithType", { title: "Attack on Titan", rating: 10, type: "Anime" }),
      t("home.promptEntryRatedWithType", { title: "The Left Hand of Darkness", rating: 10, type: "Literature" }),
      t("home.promptEntryRatedWithType", { title: "Arcane", rating: 9, type: "Series" }),
      t("home.promptEntryRatedWithType", { title: "1000 Players", rating: 8, type: "Game" }),
      t("home.promptEntryRatedWithType", { title: "100 Meters", rating: 7, type: "Film" }),
    ]);
    expect(result.included).toMatchObject({ entries: 7, reviews: 0 });
    expect(result.omitted.entries).toBe(0);
  });

  it("includes each eligible entry title and rating and adds its type only when requested", () => {
    const entries = [
      entry("Mother of Learning", 10, 1, { mediaType: "Literature" }),
    ];
    const withoutType = buildRecommendationPrompt({ ...base, entries });
    expect(withoutType.text).toContain("- Mother of Learning – 10");
    expect(withoutType.text).not.toContain("(Literature)");

    const withType = buildRecommendationPrompt({
      ...base,
      entries,
      options: { includeMediaType: true },
    });
    expect(withType.text).toContain("- Mother of Learning – 10 (Literature)");
  });

  it("does not claim the library is empty when it only contains unrated or planned works", () => {
    const result = buildRecommendationPrompt({
      ...base,
      entries: [
        { id: "plan", title: "Planned work", disposition: "planned" },
      ],
    });
    expect(result.text).not.toContain("No library entries yet.");
    expect(result.text).toContain("Planned: Planned work");
    expect(result.text).toContain("No rated entries are available");
  });

  it("does not claim the library is empty before library data has loaded", () => {
    const result = buildRecommendationPrompt({
      ...base,
      entries: [],
      libraryLoaded: false,
    });
    expect(result.text).toContain("Library data is unavailable.");
    expect(result.text).not.toContain("No library entries yet.");
  });

  it("includes unscored exclusions in distinct categories", () => {
    const result = buildRecommendationPrompt({
      ...base,
      entries: [
        { id: "plan", title: "Planned work", disposition: "planned" },
        { id: "drop", title: "Dropped work", disposition: "dropped" },
        entry("rated", 9, 1),
      ],
      options: { includeReviews: false },
    });

    expect(result.text).toContain("Planned: Planned work");
    expect(result.text).toContain(
      "Dropped (not necessarily disliked): Dropped work",
    );
    expect(result.included).toMatchObject({
      exclusions: 3,
      reviews: 0,
    });
  });

  it("stays within a Unicode character budget and reports evidence omitted to fit", () => {
    const emojiReview = "🙂".repeat(1_500);
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry(`Work ${index}`, 10 - (index % 3), index + 1, {
        title: `Work ${index} ${"🙂".repeat(80)}`,
        reviewText: emojiReview,
      }),
    );
    const result = buildRecommendationPrompt({
      ...base,
      entries,
      options: { characterBudget: 2_500 },
    });

    expect(result.characterCount).toBe(Array.from(result.text).length);
    expect(result.characterCount).toBeLessThanOrEqual(2_500);
    expect(result.included.entries).toBeGreaterThan(0);
    expect(result.omitted.entries).toBeGreaterThan(0);
    // A final title/rating line can fit after its review is dropped, so review
    // omissions may exceed omitted entries by one (or more as budgets vary).
    expect(result.omitted.reviews).toBeGreaterThanOrEqual(result.omitted.entries);
    expect(result.omitted.entries).toBe(
      entries.length - result.included.entries,
    );
  });

  it("caps review excerpts and rejects a budget that cannot hold mandatory free text", () => {
    const excerpted = buildRecommendationPrompt({
      ...base,
      entries: [entry("Long review", 9, 1, { reviewText: "x".repeat(1_200) })],
    });
    expect(excerpted.text).toContain("… [excerpt]");

    expect(() =>
      buildRecommendationPrompt({
        ...base,
        profile: { nickname: "Mira", statedTastes: "x".repeat(400) },
        options: { characterBudget: 100 },
      }),
    ).toThrow(MandatoryPromptExceedsBudgetError);
  });
});
