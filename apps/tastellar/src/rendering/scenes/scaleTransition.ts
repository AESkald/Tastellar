import type { UniverseGroup } from "./sceneLayout";

const SCALES: readonly UniverseGroup[] = ["10", "9", "8", "7"];
const HANDOFF = 0.48;

export interface ScaleTransition {
  from: UniverseGroup;
  to: UniverseGroup;
  outward: boolean;
  duration: number;
  sourceFit: number;
  targetFit: number;
  sourceDistance: number;
}

export interface ScaleTransitionFrame {
  phase: "outgoing" | "incoming" | "complete";
  distance: number;
  /** Interpolate the camera target from the universe center to an empty region. */
  focusMix: number;
  labelsOpacity: number;
  /** Blend environments independently of the foreground scene handoff. */
  environmentMix: number;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => value * value * (3 - 2 * value);
const logarithmicZoom = (from: number, to: number, progress: number) =>
  Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * ease(clamp(progress)));

/** Artistic scale travel deliberately exceeds the ordinary camera's zoom limits. */
export function createScaleTransition(
  from: UniverseGroup,
  to: UniverseGroup,
  sourceFit: number,
  targetFit: number,
  sourceDistance = sourceFit,
): ScaleTransition | null {
  const fromIndex = SCALES.indexOf(from);
  const toIndex = SCALES.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
  if (![sourceFit, targetFit, sourceDistance].every((value) => Number.isFinite(value) && value > 0)) return null;
  return { from, to, outward: toIndex > fromIndex, duration: 950, sourceFit, targetFit, sourceDistance };
}

export function sampleScaleTransition(plan: ScaleTransition, elapsed: number): ScaleTransitionFrame {
  const progress = clamp(elapsed / plan.duration);
  const environmentMix = ease(clamp((progress - 0.34) / 0.32));
  if (progress >= 1) {
    return { phase: "complete", distance: plan.targetFit, focusMix: 0, labelsOpacity: 1, environmentMix: 1 };
  }
  if (progress < HANDOFF) {
    const travel = progress / HANDOFF;
    const destination = plan.sourceFit * (plan.outward ? 420 : 0.018);
    return {
      phase: "outgoing",
      distance: logarithmicZoom(plan.sourceDistance, destination, travel),
      focusMix: plan.outward ? 0 : ease(travel),
      labelsOpacity: 0,
      environmentMix,
    };
  }
  const travel = (progress - HANDOFF) / (1 - HANDOFF);
  const origin = plan.targetFit * (plan.outward ? 0.018 : 420);
  return {
    phase: "incoming",
    distance: logarithmicZoom(origin, plan.targetFit, travel),
    focusMix: plan.outward ? 1 - ease(travel) : 0,
    labelsOpacity: 0,
    environmentMix,
  };
}
