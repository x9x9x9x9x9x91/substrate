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

/** Adoption that cannot regress to an older write's result.

    The queue above keeps the WRITES in issue order, but the optimistic state
    each gesture sets is not in the queue at all: gesture A sets its value and
    queues its write, gesture B sets its value while A is still in flight, and
    then A's response lands and adopts A's — older — value over B's. The state
    is briefly two gestures behind, and an undo recorded in that window
    captures A as its `before`, so undoing a third gesture jumps back past B.

    So only the NEWEST write issued against a given adopter is allowed to
    adopt: an older response still resolves its own promise (callers read the
    stored truth off it for their guards) but no longer writes to state. The
    newest write's response always lands, so state still converges on what the
    engine normalized rather than on what the UI asked for.

    Keyed on the adopter's identity, which means a stable callback — the state
    setters — gets the guarantee, and a one-off inline adopter is simply always
    the newest of its own kind, exactly as it was before. */
export function createAdoptionGate(): <T>(adopt: (value: T) => void) => (value: T) => void {
  const issued = new WeakMap<object, number>();
  return <T,>(adopt: (value: T) => void) => {
    const mine = (issued.get(adopt) ?? 0) + 1;
    issued.set(adopt, mine);
    return (value: T) => {
      if (issued.get(adopt) !== mine) return;
      adopt(value);
    };
  };
}
