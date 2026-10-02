import { describe, expect, it } from "vitest";
import { createScaleTransition, sampleScaleTransition } from "./scaleTransition";

describe("universe scale transitions", () => {
  it("travels far beyond the solar fit before handing off to a close constellation view", () => {
    const transition = createScaleTransition("10", "7", 12, 36, 15)!;
    const start = sampleScaleTransition(transition, 0);
    const outgoing = sampleScaleTransition(transition, transition.duration * 0.479);
    const incoming = sampleScaleTransition(transition, transition.duration * 0.48);
    const complete = sampleScaleTransition(transition, transition.duration);

    expect(start).toMatchObject({ phase: "outgoing", distance: 15, labelsOpacity: 0 });
    expect(outgoing.phase).toBe("outgoing");
    expect(outgoing.distance).toBeGreaterThan(transition.sourceFit * 400);
    expect(outgoing.labelsOpacity).toBeLessThan(0.001);
    expect(incoming.phase).toBe("incoming");
    expect(incoming.distance).toBeCloseTo(transition.targetFit * 0.018, 8);
    expect(incoming.labelsOpacity).toBe(0);
    expect(complete).toMatchObject({
      phase: "complete",
      distance: transition.targetFit,
      labelsOpacity: 1,
      environmentMix: 1,
    });
    for (const elapsed of [0, 120, 360, 455, 456, 700, 949])
      expect(sampleScaleTransition(transition, elapsed).labelsOpacity).toBe(0);
  });

  it("reverses the zoom for a return journey and restores the destination fit", () => {
    const transition = createScaleTransition("7", "10", 36, 12, 54)!;
    const outgoing = sampleScaleTransition(transition, transition.duration * 0.479);
    const incoming = sampleScaleTransition(transition, transition.duration * 0.48);
    const complete = sampleScaleTransition(transition, transition.duration);

    expect(transition.outward).toBe(false);
    expect(outgoing.distance).toBeLessThan(transition.sourceFit * 0.02);
    expect(incoming.distance).toBeGreaterThan(transition.targetFit * 400);
    expect(complete.distance).toBe(transition.targetFit);
  });

  it("supports direct jumps across the high rating scales and rejects same or non-scale targets", () => {
    expect(createScaleTransition("10", "7", 12, 36)).not.toBeNull();
    expect(createScaleTransition("7", "10", 36, 12)).not.toBeNull();
    expect(createScaleTransition("9", "9", 12, 12)).toBeNull();
    expect(createScaleTransition("8", "dropped", 12, 12)).toBeNull();
  });
});
