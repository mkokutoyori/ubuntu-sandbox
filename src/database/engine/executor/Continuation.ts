export interface Continuable<R> {
  continuation?: () => R;
}

export function through<R extends Continuable<R>>(
  scope: (run: () => R) => R,
  run: () => R,
  after: (settled: R) => R,
): R {
  const result = scope(run);
  const next = result.continuation;
  if (next === undefined) return after(result);
  return { ...result, continuation: () => through(scope, next, after) };
}

export function settle<R extends Continuable<R>>(result: R): R {
  let current = result;
  while (current.continuation !== undefined) current = current.continuation();
  return current;
}

export function andThen<R extends Continuable<R>>(result: R, after: (settled: R) => R): R {
  return through<R>((run) => run(), () => result, after);
}
