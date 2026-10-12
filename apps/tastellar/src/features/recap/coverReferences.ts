import type { Entry } from "../../shared/bridge/libraryTypes";
import type { RecapComposition } from "./domain/recap";

function sameRemoteCover(left: Entry["remoteCover"], right: Entry["remoteCover"]): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left.provider === right.provider &&
    left.url === right.url &&
    left.sourceUrl === right.sourceUrl &&
    left.attribution === right.attribution;
}

/** Refresh only media source references in a saved composition snapshot. */
export function refreshRecapCoverReferences(
  composition: RecapComposition,
  entries: readonly Entry[],
): RecapComposition {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  let changed = false;
  const slots = composition.slots.map((slot) => {
    if (!slot.entry) return slot;
    const current = entriesById.get(slot.entry.id);
    // Keep the portable snapshot when its library entry has been deleted.
    if (!current) return slot;
    const remoteCover = current.remoteCover ?? null;
    if (
      slot.entry.coverAssetId === current.coverAssetId &&
      sameRemoteCover(slot.entry.remoteCover, remoteCover)
    ) {
      return slot;
    }
    changed = true;
    return {
      ...slot,
      entry: {
        ...slot.entry,
        coverAssetId: current.coverAssetId,
        remoteCover,
      },
    };
  });
  return changed ? { ...composition, slots } : composition;
}
