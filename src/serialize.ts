const tails = new Map<string, Promise<void>>();

/** Run async work for the same key one at a time. Single-process, matching the one-replica deploy. */
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, settled);
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  return run;
}
