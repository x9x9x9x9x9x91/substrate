/** Guards async fan-out where only the newest request's result may apply:
    `issue()` stamps each request with a monotonically increasing id and
    `isLatest(id)` stays true only until a newer request is issued — a slow
    older response is dropped instead of clobbering newer state. Issuing an
    extra id also cancels everything in flight (e.g. when the query clears). */
export function createLatestGuard() {
  let latest = 0;
  return {
    issue(): number {
      return ++latest;
    },
    isLatest(id: number): boolean {
      return id === latest;
    },
  };
}
