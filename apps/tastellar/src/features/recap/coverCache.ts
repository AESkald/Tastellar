/** Coalesce cover reads and keep successful sources available for draft edits. */
export function loadRecapCoverWithCache(
  cache: Map<string, Promise<string | null>>,
  key: string,
  load: () => Promise<string | null>,
): Promise<string | null> {
  const existing = cache.get(key);
  if (existing) return existing;

  let pending: Promise<string | null>;
  pending = Promise.resolve()
    .then(load)
    .catch(() => null)
    .then((source) => {
      if (cache.get(key) === pending && !source) cache.delete(key);
      return source;
    });
  cache.set(key, pending);
  return pending;
}
