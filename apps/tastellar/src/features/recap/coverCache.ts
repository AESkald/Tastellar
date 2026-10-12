/** Coalesce in-flight reads; successful source bytes live in the shared bridge cache. */
const MAX_RECAP_COVER_REQUESTS = 128;

export function loadRecapCoverWithCache(
  cache: Map<string, Promise<string | null>>,
  key: string,
  load: () => Promise<string | null>,
): Promise<string | null> {
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }

  let pending: Promise<string | null>;
  pending = Promise.resolve()
    .then(load)
    .catch(() => null)
    .finally(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
  cache.set(key, pending);
  while (cache.size > MAX_RECAP_COVER_REQUESTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pending;
}
