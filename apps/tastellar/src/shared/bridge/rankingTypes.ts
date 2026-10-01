import type { LibraryState } from "./libraryTypes";

export interface RankingTierState {
  score: number;
  placedIds: string[];
  unplacedIds: string[];
  inputSequence: number;
  fittedSequence: number;
  pendingReconcile: boolean;
}

export interface RankingState {
  revision: number;
  library: LibraryState;
  unscoredIds: string[];
  tiers: RankingTierState[];
  activeSession: DuelSession | null;
}

export type DuelSessionMode = "binary" | "normal" | "seed" | "confirm";
export interface DuelSession {
  id: string;
  score: number;
  status: "active" | "paused" | "ended";
  mode: DuelSessionMode;
  answeredCount: number;
  candidateEntryId: string | null;
}

export type BinaryPlacementNextStep = "binary" | "offerBinary" | "normal" | "requiresSubset" | "done";
export interface BinaryPlacementResult {
  state: RankingState;
  nextStep: BinaryPlacementNextStep;
}

export interface DuelPrompt {
  sessionId: string;
  duelId: string;
  kind: "binary" | "normal" | "seed" | "confirm";
  leftEntryId: string;
  rightEntryId: string;
  candidateEntryId: string | null;
  step: number | null;
  totalSteps: number | null;
  proposedPosition: number | null;
  tierLength: number | null;
  previousEntryId: string | null;
  nextEntryId: string | null;
}

export type DuelAnswer = "leftWin" | "rightWin" | "tie" | "skip";
export type DuelIntent = "auto" | "binary" | "normal";
export type RankingPosition =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "before" | "after"; anchorId: string };
