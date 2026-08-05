/** Serializes async writes to one store (e.g. `.vault/views.json`, whose
    setters each read-modify-write the whole file): two of them in flight at
    once can interleave on disk and silently drop a key, and their responses
    can land out of order so the older one clobbers newer state. Queued
    writes start only after the previous one settled, so disk and the
    adopted responses move in issue order. A rejected write rejects its own
    returned promise but never the queue — the next write still runs. */
export function createWriteQueue() {
  // invariant: tail never rejects, so the next write always runs
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(write: () => Promise<T>): Promise<T> => {
    const result = tail.then(write);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}
