import { invoke, isTauri } from "@tauri-apps/api/core";
import { commitPreviewRevision, currentPreviewRevision } from "./previewRevision";
import { loadLibrary, saveEntry } from "./libraryBridge";
import type { Entry, EntryDraft, LibraryState } from "./libraryTypes";
import type {
  DuelAnswer,
  DuelIntent,
  DuelPrompt,
  DuelSession,
  BinaryPlacementNextStep,
  BinaryPlacementResult,
  RankingPosition,
  RankingState,
  RankingTierState,
} from "./rankingTypes";
import { t } from "../ui/i18n";

const native = isTauri();
const PREVIEW_RANKING_KEY = "tastellar.preview.ranking.v1";
const placements = new Map<string, { score: number; placed: boolean }>();
const tierOrders = new Map<number, { placed: string[]; unplaced: string[] }>();
const sequences = new Map<number, number>();
type PreviewBoundary = { score: number; firstId: string; secondId: string; preferredId: string };
const previewBoundaries = new Map<string, PreviewBoundary>();
let previewInitialized = false;
type PreviewSession = DuelSession & {
  filterMediaTypeIds: string[];
  intent: DuelIntent;
  candidateEntryIds: string[] | null;
  eligibleUnplacedEntryIds: string[] | null;
  snapshot: string[];
  low: number;
  high: number;
  seedPivotId: string | null;
  skippedSeedPairs: string[][];
  prompt: DuelPrompt | null;
};
type PreviewJudgment = {
  id: string;
  sessionId: string;
  answer: DuelAnswer;
  before: PreviewSession;
  placements?: Array<[string, { score: number; placed: boolean }]>
  tierOrders?: Array<[number, { placed: string[]; unplaced: string[] }]>
  sequences?: Array<[number, number]>
  boundaries?: PreviewBoundary[]
  recentNormalPairs?: Array<[number, string[]]>;
  skippedSeedPairsByScore?: Array<[number, string[][]]>;
};
type PreviewMove = {
  entry: Entry;
  placements: Array<[string, { score: number; placed: boolean }]>
  tierOrders: Array<[number, { placed: string[]; unplaced: string[] }]>
  sequences: Array<[number, number]>
  boundaries: PreviewBoundary[]
};
let previewSession: PreviewSession | null = null;
const previewJudgments: PreviewJudgment[] = [];
const previewRecentNormalPairs = new Map<number, string[]>();
const previewSkippedSeedPairs = new Map<number, string[][]>();
let latestPreviewMove: PreviewMove | null = null;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundaryKey(score:number,first:string,second:string){
  const [a,b]=first<second?[first,second]:[second,first];
  return `${score}\u0000${a}\u0000${b}`;
}

function persistPreviewRanking() {
  if (native) return;
  try {
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(PREVIEW_RANKING_KEY, JSON.stringify({
        placements: [...placements.entries()],
        tierOrders: [...tierOrders.entries()],
        sequences: [...sequences.entries()],
        boundaries: [...previewBoundaries.values()],
        recentNormalPairs: [...previewRecentNormalPairs.entries()],
        skippedSeedPairsByScore: [...previewSkippedSeedPairs.entries()],
        initialized: previewInitialized,
        session: previewSession,
        judgments: previewJudgments,
        latestMove: latestPreviewMove,
      }));
  } catch {
    // Keep the in-memory preview usable when session storage is unavailable.
  }
}

function restorePreviewRanking() {
  if (native) return;
  try {
    const stored = typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(PREVIEW_RANKING_KEY);
    if (!stored) return;
    const value = JSON.parse(stored) as {
      placements?: Array<[string, { score: number; placed: boolean }]>
      tierOrders?: Array<[number, { placed: string[]; unplaced: string[] }]>
      sequences?: Array<[number, number]>
      boundaries?: PreviewBoundary[]
      recentNormalPairs?: Array<[number, string[]]>
      skippedSeedPairsByScore?: Array<[number, string[][]]>
      initialized?: boolean
      session?: PreviewSession | null
      judgments?: PreviewJudgment[]
      latestJudgment?: PreviewJudgment | null
      latestMove?: PreviewMove | null
    };
    for (const [id, placement] of value.placements ?? [])
      if (typeof id === "string" && Number.isInteger(placement?.score) && typeof placement.placed === "boolean") placements.set(id, placement);
    for (const [score, order] of value.tierOrders ?? [])
      if (Number.isInteger(score) && score >= 1 && score <= 10 && Array.isArray(order?.placed) && Array.isArray(order?.unplaced)) tierOrders.set(score, order);
    for (const [score, sequence] of value.sequences ?? [])
      if (Number.isInteger(score) && score >= 1 && score <= 10 && Number.isInteger(sequence)) sequences.set(score, sequence);
    previewBoundaries.clear();
    for (const boundary of value.boundaries ?? [])
      if (boundary && Number.isInteger(boundary.score) && typeof boundary.firstId === "string" && typeof boundary.secondId === "string" && typeof boundary.preferredId === "string")
        previewBoundaries.set(boundaryKey(boundary.score,boundary.firstId,boundary.secondId),boundary);
    for (const [score, pair] of value.recentNormalPairs ?? [])
      if (Number.isInteger(score) && Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === "string")) previewRecentNormalPairs.set(score, [...pair]);
    for (const [score, pairs] of value.skippedSeedPairsByScore ?? [])
      if (Number.isInteger(score) && Array.isArray(pairs)) previewSkippedSeedPairs.set(score, pairs.filter((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === "string")).map((pair) => [...pair]));
    previewInitialized = value.initialized === true;
    previewSession = value.session ?? null;
    if (previewSession) {
      previewSession.seedPivotId ??= null;
      previewSession.skippedSeedPairs ??= [];
      previewSession.intent ??= "auto";
      previewSession.candidateEntryIds ??= null;
      previewSession.eligibleUnplacedEntryIds ??= null;
    }
    previewJudgments.splice(0, previewJudgments.length, ...(value.judgments ?? (value.latestJudgment ? [value.latestJudgment] : [])));
    latestPreviewMove = value.latestMove ?? null;
    if (latestPreviewMove) latestPreviewMove.boundaries ??= [];
  } catch {
    placements.clear();
    tierOrders.clear();
    sequences.clear();
    previewBoundaries.clear();
    previewRecentNormalPairs.clear();
    previewSkippedSeedPairs.clear();
    previewInitialized = false;
    previewSession = null;
    previewJudgments.length = 0;
    latestPreviewMove = null;
  }
}

restorePreviewRanking();

function orderFor(library: LibraryState, score: number) {
  const order = tierOrders.get(score) ?? { placed: [], unplaced: [] };
  const candidates = library.entries
    .filter((entry) => entry.disposition === "experienced" && entry.overallRating === score)
    .map((entry) => entry.id);
  for (const id of candidates) {
    if (!placements.has(id)) {
      placements.set(id, { score, placed: !previewInitialized });
      (previewInitialized ? order.unplaced : order.placed).push(id);
    } else if (placements.get(id)?.score !== score) {
      const previous = placements.get(id)!;
      const previousOrder = tierOrders.get(previous.score);
      if (previousOrder) {
        previousOrder.placed = previousOrder.placed.filter((item) => item !== id);
        previousOrder.unplaced = previousOrder.unplaced.filter((item) => item !== id);
      }
      placements.set(id, { score, placed: false });
      order.unplaced.push(id);
      sequences.set(score, (sequences.get(score) ?? 0) + 1);
    }
  }
  order.placed = order.placed.filter((id) => candidates.includes(id) && placements.get(id)?.placed);
  order.unplaced = order.unplaced.filter((id) => candidates.includes(id) && !placements.get(id)?.placed);
  tierOrders.set(score, order);
  return order;
}

function buildState(library: LibraryState): RankingState {
  const tiers: RankingTierState[] = [];
  for (let score = 10; score >= 1; score -= 1) {
    const order = orderFor(library, score);
    tiers.push({
      score,
      placedIds: [...order.placed],
      unplacedIds: [...order.unplaced],
      inputSequence: sequences.get(score) ?? 0,
      fittedSequence: sequences.get(score) ?? 0,
      pendingReconcile: false,
    });
  }
  previewInitialized = true;
  persistPreviewRanking();
  return {
    revision: library.revision,
    library,
    unscoredIds: library.entries
      .filter((entry) => entry.disposition === "experienced" && entry.overallRating == null)
      .map((entry) => entry.id),
    tiers,
    activeSession: previewSession,
  };
}

export async function loadRanking(): Promise<RankingState> {
  if (native) return invoke<RankingState>("load_ranking");
  return buildState(await loadLibrary());
}

function stateWith(library: LibraryState): RankingState {
  return buildState(library);
}

function positionIndex(ids: string[], position: RankingPosition) {
  if (position.kind === "start") return 0;
  if (position.kind === "end") return ids.length;
  const anchor = ids.indexOf(position.anchorId);
  if (anchor < 0) throw new Error(t("error.concurrentEdit"));
  return anchor + (position.kind === "after" ? 1 : 0);
}

export async function moveRankingEntry(
  expectedRevision: number,
  entryId: string,
  score: number,
  ranked: boolean,
  position: RankingPosition,
): Promise<RankingState> {
  if (native)
    return invoke<RankingState>("move_ranking_entry", {
      expectedRevision,
      entryId,
      score,
      ranked,
      position,
    });
  if (expectedRevision !== currentPreviewRevision())
    throw new Error(t("error.concurrentEdit"));
  const library = await loadLibrary();
  const entry = library.entries.find((item) => item.id === entryId);
  if (!entry) throw new Error(t("error.concurrentEdit"));
  latestPreviewMove = {
    entry: clone(entry),
    placements: [...placements.entries()].map(([id, value]) => [id, { ...value }]),
    tierOrders: [...tierOrders.entries()].map(([tierScore, order]) => [tierScore, { placed: [...order.placed], unplaced: [...order.unplaced] }]),
    sequences: [...sequences.entries()],
    boundaries: [...previewBoundaries.values()].map((boundary) => ({ ...boundary })),
  };
  const nextLibrary = await saveEntry(expectedRevision, toDraft(entry, score));
  for (const [tierScore, tier] of tierOrders) {
    tier.placed = tier.placed.filter((id) => id !== entryId);
    tier.unplaced = tier.unplaced.filter((id) => id !== entryId);
    tierOrders.set(tierScore, tier);
  }
  for (const [key,boundary] of previewBoundaries) if (boundary.firstId===entryId||boundary.secondId===entryId) previewBoundaries.delete(key);
  placements.set(entryId, { score, placed: ranked });
  const target = orderFor(nextLibrary, score);
  const list = ranked ? target.placed : target.unplaced;
  const insertAt=positionIndex(list, position);
  list.splice(insertAt, 0, entryId);
  if(ranked){
    const before=list[insertAt-1];const after=list[insertAt+1];
    for(const [preferredId,otherId] of [[before,entryId],[entryId,after]] as Array<[string|undefined,string|undefined]>){
      if(!preferredId||!otherId)continue;
      const [firstId,secondId]=preferredId<otherId?[preferredId,otherId]:[otherId,preferredId];
      previewBoundaries.set(boundaryKey(score,firstId,secondId),{score,firstId,secondId,preferredId});
    }
  }
  sequences.set(score, (sequences.get(score) ?? 0) + 1);
  persistPreviewRanking();
  return stateWith(nextLibrary);
}

export async function undoLastRankingMove(expectedRevision: number): Promise<RankingState> {
  if (native) return invoke<RankingState>("undo_last_ranking_move", { expectedRevision });
  if (expectedRevision !== currentPreviewRevision()) throw new Error(t("error.concurrentEdit"));
  const move = latestPreviewMove;
  if (!move) throw new Error(t("error.concurrentEdit"));
  let library = await loadLibrary();
  const current = library.entries.find((entry) => entry.id === move.entry.id);
  if (!current) throw new Error(t("error.concurrentEdit"));
  library = await saveEntry(expectedRevision, toDraft(current, move.entry.overallRating));
  placements.clear();
  for (const [id, value] of move.placements) placements.set(id, { ...value });
  tierOrders.clear();
  for (const [score, order] of move.tierOrders) tierOrders.set(score, { placed: [...order.placed], unplaced: [...order.unplaced] });
  sequences.clear();
  for (const [score, sequence] of move.sequences) sequences.set(score, sequence);
  previewBoundaries.clear();
  for (const boundary of move.boundaries) previewBoundaries.set(boundaryKey(boundary.score,boundary.firstId,boundary.secondId),{...boundary});
  latestPreviewMove = null;
  persistPreviewRanking();
  return stateWith(library);
}

export async function startDuelSession(
  expectedRevision: number,
  score: number,
  filterMediaTypeIds: string[] = [],
  candidateEntryId: string | null = null,
  intent: DuelIntent = "auto",
  candidateEntryIds?: string[],
  eligibleUnplacedEntryIds?: string[],
): Promise<DuelSession> {
  if (native)
    return invoke<DuelSession>("start_duel_session", {
      expectedRevision,
      score,
      filterMediaTypeIds,
      candidateEntryId,
      intent,
      candidateEntryIds: candidateEntryIds ?? null,
      eligibleUnplacedEntryIds: eligibleUnplacedEntryIds ?? null,
    });
  if (expectedRevision !== currentPreviewRevision())
    throw new Error(t("error.concurrentEdit"));
  const library = await loadLibrary();
  const state = buildState(library);
  const tier = state.tiers.find((item) => item.score === score)!;
  if (candidateEntryIds && (intent === "binary" || candidateEntryId != null))
    throw new Error(t("ranking.subsetBinaryConflict"));
  const mediaEligibleUnplaced = tier.unplacedIds.filter((id) => {
    const entry = library.entries.find((item) => item.id === id);
    return !filterMediaTypeIds.length || (entry?.mediaTypeId != null && filterMediaTypeIds.includes(entry.mediaTypeId));
  });
  if (eligibleUnplacedEntryIds && new Set(eligibleUnplacedEntryIds).size !== eligibleUnplacedEntryIds.length)
    throw new Error(t("ranking.invalidSubset"));
  if (eligibleUnplacedEntryIds && eligibleUnplacedEntryIds.some((id) => !mediaEligibleUnplaced.includes(id)))
    throw new Error(t("ranking.invalidSubset"));
  const eligibleUnplaced = eligibleUnplacedEntryIds
    ? mediaEligibleUnplaced.filter((id) => eligibleUnplacedEntryIds.includes(id))
    : mediaEligibleUnplaced;
  const candidate = candidateEntryId ?? eligibleUnplaced[0] ?? null;
  if (tier.unplacedIds.length && eligibleUnplaced.length === 0)
    throw new Error(t("ranking.invalidSubset"));
  if (candidate && !eligibleUnplaced.includes(candidate))
    throw new Error(t("ranking.invalidSubset"));
  const skippedSeedPairs = previewSkippedSeedPairs.get(score) ?? [];
  const seedPivotId = tier.placedIds.length === 0 && candidate != null
    ? eligibleUnplaced.find((id) => id !== candidate && !skippedSeedPairs.some((pair) => pair[0] === [candidate, id].sort()[0] && pair[1] === [candidate, id].sort()[1])) ?? null
    : null;
  const seed = seedPivotId != null;
  const binary = seed || tier.unplacedIds.length > 0 || (tier.placedIds.length === 0 && candidate != null) || (tier.placedIds.length === 1 && candidate != null) || (intent === "binary"
    ? candidate != null
    : intent === "normal"
      ? false
      : candidate != null && tier.placedIds.length / Math.max(1, tier.placedIds.length + tier.unplacedIds.length) >= 0.9);
  if (candidateEntryIds && binary)
    throw new Error(t("ranking.subsetBinaryConflict"));
  const mediaTypeFilter = new Set(filterMediaTypeIds);
  const eligibleIds = tier.placedIds.filter((id) => {
    const entry = library.entries.find((item) => item.id === id);
    return (!mediaTypeFilter.size || (entry?.mediaTypeId != null && mediaTypeFilter.has(entry.mediaTypeId))) &&
      (!candidateEntryIds || candidateEntryIds.includes(id));
  });
  if (candidateEntryIds && new Set(candidateEntryIds).size !== candidateEntryIds.length)
    throw new Error(t("ranking.invalidSubset"));
  if (candidateEntryIds && eligibleIds.length !== candidateEntryIds.length)
    throw new Error(t("ranking.invalidSubset"));
  if (candidateEntryIds && tier.unplacedIds.length > 0)
    throw new Error(t("ranking.subsetBinaryConflict"));
  if (!binary && eligibleIds.length > 200)
    throw new Error(t("ranking.subsetNeeded"));
  if (!binary && eligibleIds.length < 2)
    throw new Error(t("ranking.subsetTooSmall"));
  const session: DuelSession = {
    id: `preview-${Date.now()}`,
    score,
    status: "active",
    mode: seed ? "seed" : binary ? (tier.placedIds.length ? "binary" : "confirm") : "normal",
    answeredCount: 0,
    candidateEntryId: binary ? candidate : null,
  };
  previewSession = {
    ...session,
    filterMediaTypeIds: [...filterMediaTypeIds],
    intent,
    candidateEntryIds: candidateEntryIds ? [...candidateEntryIds] : null,
    eligibleUnplacedEntryIds: eligibleUnplacedEntryIds ? [...eligibleUnplacedEntryIds] : null,
    snapshot: binary ? [...tier.placedIds] : [...eligibleIds],
    low: 0,
    high: tier.placedIds.length,
    seedPivotId,
    skippedSeedPairs: skippedSeedPairs.map((pair) => [...pair]),
    prompt: null,
  };
  previewJudgments.length = 0;
  persistPreviewRanking();
  return clone(session);
}

export async function nextDuel(sessionId: string, revisit = false): Promise<DuelPrompt | null> {
  if (native) return invoke<DuelPrompt | null>("next_duel", { sessionId, revisit });
  const session = previewSession;
  if (!session || session.id !== sessionId || session.status !== "active") return null;
  const state = await loadRanking();
  const tier = state.tiers.find((item) => item.score === session.score)!;
  const stale = session.mode === "seed"
    ? tier.placedIds.length > 0 || !session.candidateEntryId || !tier.unplacedIds.includes(session.candidateEntryId) || !session.seedPivotId || !tier.unplacedIds.includes(session.seedPivotId)
    : session.mode === "binary" || session.mode === "confirm"
      ? tier.placedIds.join("\u0000") !== session.snapshot.join("\u0000")
      : (() => {
        if (tier.unplacedIds.length > 0) return true;
        const mediaFilter = new Set(session.filterMediaTypeIds);
        const currentIds = tier.placedIds.filter((id) => {
          if (!mediaFilter.size) return true;
          const entry = state.library.entries.find((item) => item.id === id);
          return entry?.mediaTypeId != null && mediaFilter.has(entry.mediaTypeId);
        });
        return session.candidateEntryIds
          ? session.snapshot.some((id) => !currentIds.includes(id))
          : currentIds.slice().sort().join("\u0000") !== session.snapshot.slice().sort().join("\u0000");
      })();
  if (stale) return restartPreviewSession(session);
  if (session.prompt) return clone(session.prompt);
  if (session.mode === "seed") {
    session.prompt = {
      sessionId,
      duelId: `preview-seed-${Date.now()}`,
      kind: "seed",
      leftEntryId: session.candidateEntryId!,
      rightEntryId: session.seedPivotId!,
      candidateEntryId: session.candidateEntryId,
      step: null,
      totalSteps: null,
      proposedPosition: null,
      tierLength: null,
      previousEntryId: null,
      nextEntryId: null,
    };
    persistPreviewRanking();
    return clone(session.prompt);
  }
  if (session.mode === "confirm") {
    const index = session.low;
    session.prompt = {
      sessionId,
      duelId: `confirm-${session.id}`,
      kind: "confirm",
      leftEntryId: session.candidateEntryId ?? "",
      rightEntryId: session.candidateEntryId ?? "",
      candidateEntryId: session.candidateEntryId,
      step: null,
      totalSteps: null,
      proposedPosition: index,
      tierLength: session.snapshot.length,
      previousEntryId: session.snapshot[index - 1] ?? null,
      nextEntryId: session.snapshot[index] ?? null,
    };
    persistPreviewRanking();
    return clone(session.prompt);
  }
  if (session.mode === "binary") {
    if (session.low >= session.high) {
      session.mode = "confirm";
      return nextDuel(sessionId, revisit);
    }
    const midpoint = Math.floor((session.low + session.high) / 2);
    const candidate = session.candidateEntryId!;
    const skipped = previewSkippedSeedPairs.get(session.score) ?? [];
    const pivot = Array.from({ length: session.high - session.low }, (_, offset) => session.low + offset)
      .filter((index) => {
        const pair = [candidate, session.snapshot[index]].sort();
        return !skipped.some((item) => item[0] === pair[0] && item[1] === pair[1]);
      })
      .sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
    if (pivot == null) {
      session.status = "ended";
      previewSession = null;
      persistPreviewRanking();
      return null;
    }
    session.prompt = {
      sessionId,
      duelId: `preview-duel-${Date.now()}`,
      kind: "binary",
      leftEntryId: session.candidateEntryId!,
      rightEntryId: session.snapshot[pivot],
      candidateEntryId: session.candidateEntryId,
      step: session.answeredCount + 1,
      totalSteps: Math.ceil(Math.log2(session.snapshot.length + 1)),
      proposedPosition: null,
      tierLength: null,
      previousEntryId: null,
      nextEntryId: null,
    };
    persistPreviewRanking();
    return clone(session.prompt);
  }
  const library = await loadLibrary();
  const ids = session.snapshot.filter((id) => {
    if (!session.filterMediaTypeIds.length) return true;
    const entry = library.entries.find((item) => item.id === id);
    return entry?.mediaTypeId != null && session.filterMediaTypeIds.includes(entry.mediaTypeId);
  });
  if (ids.length < 2) return null;
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i += 1)
    for (let j = i + 1; j < ids.length; j += 1) {
      const pair = [ids[i], ids[j]].sort();
      const recent = previewRecentNormalPairs.get(session.score);
      if (!session.skippedSeedPairs.some((item) => item[0] === pair[0] && item[1] === pair[1]) &&
        !(recent && recent[0] === pair[0] && recent[1] === pair[1])) pairs.push([ids[i], ids[j]]);
    }
  if (!pairs.length) {
    session.status = "ended";
    previewSession = null;
    persistPreviewRanking();
    return null;
  }
  const [left, right] = pairs[session.answeredCount % pairs.length];
  session.prompt = {
    sessionId,
    duelId: `preview-duel-${Date.now()}`,
    kind: "normal",
    leftEntryId: left,
    rightEntryId: right,
    candidateEntryId: null,
    step: null,
    totalSteps: null,
    proposedPosition: null,
    tierLength: null,
    previousEntryId: null,
    nextEntryId: null,
  };
  persistPreviewRanking();
  return clone(session.prompt);
}

async function restartPreviewSession(session: PreviewSession): Promise<DuelPrompt | null> {
  const revision = currentPreviewRevision();
  const candidate = session.candidateEntryId;
  const intent: DuelIntent = session.mode === "binary" || session.mode === "seed" || session.mode === "confirm" ? "binary" : session.intent;
  const replacement = await startDuelSession(revision, session.score, session.filterMediaTypeIds, candidate, intent, session.candidateEntryIds ?? undefined, session.eligibleUnplacedEntryIds ?? undefined);
  return nextDuel(replacement.id, false);
}

export async function answerDuel(
  expectedRevision: number,
  sessionId: string,
  duelId: string,
  answer: DuelAnswer,
): Promise<RankingState> {
  if (native)
    return invoke<RankingState>("answer_duel", { expectedRevision, sessionId, duelId, answer });
  const session = previewSession;
  const library = await loadLibrary();
  if (expectedRevision !== currentPreviewRevision()) {
    if (session?.id === sessionId && session.status === "active") await restartPreviewSession(session);
    return stateWith(library);
  }
  if (!session || session.id !== sessionId || session.prompt?.duelId !== duelId) {
    if (session?.status === "active") await restartPreviewSession(session);
    return stateWith(library);
  }
  if (answer !== "skip")
    previewJudgments.push({
      id: `preview-judgment-${Date.now()}-${previewJudgments.length}`,
      sessionId,
      answer,
      before: clone(session),
      placements: [...placements.entries()].map(([id, value]) => [id, { ...value }]),
      tierOrders: [...tierOrders.entries()].map(([score, order]) => [score, { placed: [...order.placed], unplaced: [...order.unplaced] }]),
      sequences: [...sequences.entries()],
      boundaries: [...previewBoundaries.values()].map((boundary) => ({...boundary})),
      recentNormalPairs: [...previewRecentNormalPairs.entries()].map(([score, pair]) => [score, [...pair]]),
      skippedSeedPairsByScore: [...previewSkippedSeedPairs.entries()].map(([score, pairs]) => [score, pairs.map((pair) => [...pair])]),
    });
  if (session.mode === "seed") {
    if (answer === "skip") {
      const skipped = [session.prompt.leftEntryId, session.prompt.rightEntryId].sort();
      session.skippedSeedPairs.push(skipped);
      const skippedForScore = previewSkippedSeedPairs.get(session.score) ?? [];
      skippedForScore.push([...skipped]);
      previewSkippedSeedPairs.set(session.score, skippedForScore);
      const tier = (await loadRanking()).tiers.find((item) => item.score === session.score)!;
      const eligible = (session.eligibleUnplacedEntryIds ?? tier.unplacedIds)
        .filter((id) => tier.unplacedIds.includes(id));
      let next: [string, string] | null = null;
      for (let i = 0; i < eligible.length && !next; i += 1)
        for (let j = i + 1; j < eligible.length && !next; j += 1) {
          const pair = [eligible[i], eligible[j]].sort();
          if (!session.skippedSeedPairs.some((item) => item[0] === pair[0] && item[1] === pair[1]))
            next = [eligible[i], eligible[j]];
        }
      if (next) {
        session.candidateEntryId = next[0];
        session.seedPivotId = next[1];
      } else {
        session.status = "ended";
        previewSession = null;
      }
    } else {
      const tier = (await loadRanking()).tiers.find((item) => item.score === session.score)!;
      const left = session.prompt.leftEntryId;
      const right = session.prompt.rightEntryId;
      let chosen: string[];
      if (answer === "leftWin") chosen = [left, right];
      else if (answer === "rightWin") chosen = [right, left];
      else chosen = tier.unplacedIds.indexOf(left) < tier.unplacedIds.indexOf(right) ? [left, right] : [right, left];
      const target = tierOrders.get(session.score)!;
      target.unplaced = target.unplaced.filter((id) => id !== left && id !== right);
      target.placed.push(...chosen);
      for (const id of chosen) placements.set(id, { score: session.score, placed: true });
      sequences.set(session.score, (sequences.get(session.score) ?? 0) + 1);
      session.mode = "normal";
      session.candidateEntryId = null;
      session.seedPivotId = null;
      session.snapshot = [...target.placed];
      session.low = 0;
      session.high = 0;
      if (target.unplaced.length > 0) {
        session.status = "ended";
        previewSession = null;
      }
    }
  } else if (session.mode === "binary") {
    if (answer === "skip") {
      const skipped = [session.prompt.leftEntryId, session.prompt.rightEntryId].sort();
      const skippedForScore = previewSkippedSeedPairs.get(session.score) ?? [];
      skippedForScore.push([...skipped]);
      previewSkippedSeedPairs.set(session.score, skippedForScore);
      session.skippedSeedPairs.push([...skipped]);
      session.status = "ended";
      previewSession = null;
    } else {
      const pivot = session.snapshot.indexOf(session.prompt.rightEntryId);
      if (answer === "tie") {
        session.low = pivot + 1;
        session.high = pivot + 1;
        session.mode = "confirm";
      } else if (answer === "leftWin") session.high = pivot;
      else session.low = pivot + 1;
    }
  } else if (session.mode === "normal" && answer !== "skip") {
    const tier = tierOrders.get(session.score)!;
    if (answer !== "tie") {
      const winner = answer === "leftWin" ? session.prompt.leftEntryId : session.prompt.rightEntryId;
      const loser = answer === "leftWin" ? session.prompt.rightEntryId : session.prompt.leftEntryId;
      const winnerIndex = tier.placed.indexOf(winner);
      const loserIndex = tier.placed.indexOf(loser);
      if (winnerIndex > loserIndex && winnerIndex >= 0 && loserIndex >= 0) {
        const directKey=boundaryKey(session.score,winner,loser);
        const direct=previewBoundaries.get(directKey);
        if(direct&&direct.preferredId!==winner)previewBoundaries.delete(directKey);
        let protectedPath=false;
        for(let index=loserIndex;index<winnerIndex;index+=1){
          const a=tier.placed[index];const b=tier.placed[index+1];
          const boundary=previewBoundaries.get(boundaryKey(session.score,a,b));
          if(boundary&&boundary.preferredId!==winner){protectedPath=true;break;}
        }
        if(!protectedPath){
          tier.placed.splice(winnerIndex, 1);
          tier.placed.splice(loserIndex, 0, winner);
        }
      }
    }
    previewRecentNormalPairs.set(session.score, [session.prompt.leftEntryId, session.prompt.rightEntryId].sort());
    sequences.set(session.score, (sequences.get(session.score) ?? 0) + 1);
  } else if (session.mode === "normal" && answer === "skip") {
    const skipped = [session.prompt.leftEntryId, session.prompt.rightEntryId].sort();
    session.skippedSeedPairs.push(skipped);
    previewRecentNormalPairs.set(session.score, [...skipped]);
  }
  session.answeredCount += 1;
  session.prompt = null;
  const committedRevision = commitPreviewRevision(expectedRevision);
  library.revision = committedRevision;
  persistPreviewRanking();
  return stateWith(library);
}

export async function latestRetractableJudgmentId(sessionId: string): Promise<string | null> {
  if (native) return invoke<string | null>("latest_retractable_judgment_id", { sessionId });
  return [...previewJudgments].reverse().find((judgment) => judgment.sessionId === sessionId && judgment.answer !== "skip")?.id ?? null;
}

export async function retractDuelJudgment(expectedRevision: number, judgmentId: string): Promise<RankingState> {
  if (native)
    return invoke<RankingState>("retract_duel_judgment", { expectedRevision, judgmentId });
  const judgmentIndex = previewJudgments.findIndex((judgment) => judgment.id === judgmentId);
  if (expectedRevision !== currentPreviewRevision() || judgmentIndex < 0)
    throw new Error(t("error.concurrentEdit"));
  const judgment = previewJudgments[judgmentIndex];
  previewSession = clone(judgment.before);
  if (judgment.placements) {
    placements.clear();
    for (const [id, value] of judgment.placements) placements.set(id, { ...value });
  }
  if (judgment.tierOrders) {
    tierOrders.clear();
    for (const [score, order] of judgment.tierOrders) tierOrders.set(score, { placed: [...order.placed], unplaced: [...order.unplaced] });
  }
  if (judgment.sequences) {
    sequences.clear();
    for (const [score, sequence] of judgment.sequences) sequences.set(score, sequence);
  }
  if (judgment.boundaries) {
    previewBoundaries.clear();
    for (const boundary of judgment.boundaries) previewBoundaries.set(boundaryKey(boundary.score,boundary.firstId,boundary.secondId),{...boundary});
  }
  if (judgment.recentNormalPairs) {
    previewRecentNormalPairs.clear();
    for (const [score, pair] of judgment.recentNormalPairs) previewRecentNormalPairs.set(score, [...pair]);
  }
  if (judgment.skippedSeedPairsByScore) {
    previewSkippedSeedPairs.clear();
    for (const [score, pairs] of judgment.skippedSeedPairsByScore) previewSkippedSeedPairs.set(score, pairs.map((pair) => [...pair]));
  }
  previewJudgments.splice(judgmentIndex, 1);
  const library = await loadLibrary();
  library.revision = commitPreviewRevision(expectedRevision);
  persistPreviewRanking();
  return stateWith(library);
}

export async function confirmBinaryPlacement(
  expectedRevision: number,
  sessionId: string,
  accepted: boolean,
): Promise<BinaryPlacementResult> {
  if (native)
    return invoke<BinaryPlacementResult>("confirm_binary_placement", { expectedRevision, sessionId, accepted });
  const session = previewSession;
  let state = await loadRanking();
  const currentTier=state.tiers.find((item)=>item.score===session?.score);
  const stale=expectedRevision!==currentPreviewRevision()||!session||session.id!==sessionId||session.mode!=="confirm"||!currentTier||currentTier.placedIds.join("\u0000")!==session.snapshot.join("\u0000");
  if(stale){
    if(session?.status==="active")await restartPreviewSession(session);
    state=await loadRanking();
    const active=state.activeSession;
    const staleTier = state.tiers.find((item) => item.score === session?.score);
    const nextStep:BinaryPlacementNextStep=active?.mode==="binary"||active?.mode==="seed"||active?.mode==="confirm"?"binary":active?.mode==="normal"?"normal":(staleTier?.unplacedIds.length??0)>0?"offerBinary":(staleTier?.placedIds.length??0)>200?"requiresSubset":"done";
    return {state,nextStep};
  }
  if(!session||!currentTier)return {state,nextStep:"done"};
  if (accepted && session.candidateEntryId) {
    const target = state.tiers.find((item) => item.score === session.score)!;
    const index = session.low;
    const position: RankingPosition = target.placedIds[index]
      ? { kind: "before", anchorId: target.placedIds[index] }
      : { kind: "end" };
    state = await moveRankingEntry(expectedRevision, session.candidateEntryId, session.score, true, position);
    session.snapshot = [...state.tiers.find((item) => item.score === session.score)!.placedIds];
  } else {
    const revision = commitPreviewRevision(expectedRevision);
    state = { ...state, revision, library: { ...state.library, revision } };
  }
  const unplacedCount = state.tiers.find((item) => item.score === session.score)!.unplacedIds.length;
  if (unplacedCount > 0) {
    session.status = "ended";
    session.candidateEntryId = null;
    session.prompt = null;
    previewSession = null;
    persistPreviewRanking();
    return { state: stateWith(state.library), nextStep: "offerBinary" };
  }
  session.mode = "normal";
  session.candidateEntryId = null;
  session.low = 0;
  session.high = 0;
  session.prompt = null;
  const placedCount = state.tiers.find((item) => item.score === session.score)!.placedIds.length;
  const nextStep = placedCount > 200
    ? "requiresSubset"
    : placedCount >= 2
      ? "normal"
      : "done";
  if (nextStep === "requiresSubset" || nextStep === "done") previewSession = null;
  persistPreviewRanking();
  const nextState = stateWith(state.library);
  return { state: nextState, nextStep };
}

export async function pauseDuelSession(sessionId: string): Promise<DuelSession> {
  if (native) return invoke<DuelSession>("pause_duel_session", { sessionId });
  if (!previewSession || previewSession.id !== sessionId) throw new Error(t("error.concurrentEdit"));
  previewSession.status = "paused";
  return clone(previewSession);
}
export async function endDuelSession(sessionId: string): Promise<DuelSession> {
  if (native) return invoke<DuelSession>("end_duel_session", { sessionId });
  if (!previewSession || previewSession.id !== sessionId) throw new Error(t("error.concurrentEdit"));
  previewSession.status = "ended";
  return clone(previewSession);
}

export async function resetMediaRanking(expectedRevision: number): Promise<LibraryState> {
  if (native) return invoke<LibraryState>("reset_media_ranking", { expectedRevision });
  if (expectedRevision !== currentPreviewRevision()) throw new Error(t("error.concurrentEdit"));
  const library = await loadLibrary();
  placements.clear();
  tierOrders.clear();
  sequences.clear();
  previewBoundaries.clear();
  previewRecentNormalPairs.clear();
  previewSkippedSeedPairs.clear();
  for (let score = 1; score <= 10; score += 1) tierOrders.set(score, { placed: [], unplaced: [] });
  for (const entry of library.entries) {
    if (entry.disposition === "experienced" && entry.overallRating != null) {
      placements.set(entry.id, { score: entry.overallRating, placed: false });
      tierOrders.get(entry.overallRating)?.unplaced.push(entry.id);
      sequences.set(entry.overallRating, (sequences.get(entry.overallRating) ?? 0) + 1);
    }
  }
  previewSession = null;
  previewJudgments.length = 0;
  latestPreviewMove = null;
  const revision = commitPreviewRevision(expectedRevision);
  persistPreviewRanking();
  return { ...library, revision };
}

function toDraft(entry: Entry, score: number | null): EntryDraft {
  return {
    id: entry.id,
    title: entry.title,
    disposition: "experienced",
    mediaTypeId: entry.mediaTypeId,
    overallRating: score,
    coverAssetId: entry.coverAssetId,
    releaseDate: entry.releaseDate,
    reviewText: entry.reviewText,
    shortLabel: entry.shortLabel,
    criterionRatings: { ...entry.criterionRatings },
    tagIds: [...entry.tagIds],
  };
}
