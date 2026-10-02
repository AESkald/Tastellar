import { describe, expect, it } from "vitest";
import { extractCoverPalette, paletteFromSeed } from "./palette";

describe("universe palettes", () => {
  it("creates repeatable fallbacks from stable work IDs", () => {
    const first = paletteFromSeed("work-a");

    expect(paletteFromSeed("work-a")).toEqual(first);
    expect(paletteFromSeed("work-b")).not.toEqual(first);
    expect(first).toMatchObject({ extractionVersion: 1 });
    for (const value of [
      first.dominant,
      first.vibrant,
      first.darkVibrant,
      first.lightVibrant,
      first.accent,
    ]) {
      expect(value).toMatch(/^hsl\(\d+  ?\d+% \d+%\)$/);
    }
  });

  it("uses the entry seed when cover decoding is unavailable", async () => {
    const fallback = await extractCoverPalette("no-browser-image", "work-a");

    expect(fallback).toEqual(paletteFromSeed("work-a"));
  });
});
