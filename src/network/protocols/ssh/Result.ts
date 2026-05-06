/**
 * Result<T, E> — discriminated union for fallible operations.
 *
 * Replaces exceptions in the SSH/SFTP layer. Callers must inspect `ok`
 * to access either `value` (T) or `error` (E).
 *
 * Reference: DESIGN-SSH-SFTP.md section 2.
 */

export interface ResultOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ResultErr<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = SshError> = ResultOk<T> | ResultErr<E>;

export const ok = <T>(value: T): ResultOk<T> => ({ ok: true, value });

export const err = <E>(error: E): ResultErr<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is ResultOk<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is ResultErr<E> => !r.ok;

/**
 * Re-emit an err Result with a different success type.
 * Useful when propagating errors between functions whose value types differ.
 */
export const propagateErr = <U, E>(source: Result<unknown, E>): Result<U, E> =>
  isErr(source)
    ? { ok: false, error: source.error }
    : { ok: false, error: undefined as unknown as E };

export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  if (isOk(result)) return ok(fn(result.value));
  return { ok: false, error: result.error };
}

export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  if (isOk(result)) return fn(result.value);
  return { ok: false, error: result.error };
}

export function mapError<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  if (isErr(result)) return err(fn(result.error));
  return result;
}

export function getOrElse<T, E>(result: Result<T, E>, fallback: T): T {
  return isOk(result) ? result.value : fallback;
}

export function match<T, E, U>(
  result: Result<T, E>,
  onOk: (value: T) => U,
  onErr: (error: E) => U,
): U {
  return isOk(result) ? onOk(result.value) : onErr(result.error);
}

export type SshError =
  | { kind: 'HOST_KEY_CHANGED'; host: string; expected: string; got: string }
  | { kind: 'HOST_KEY_REJECTED'; host: string; fingerprint: string }
  | { kind: 'AUTH_FAILED'; user: string; attemptsLeft: number }
  | { kind: 'CONNECTION_REFUSED'; host: string; port: number }
  | { kind: 'PERMISSION_DENIED'; path: string; operation: string }
  | { kind: 'NOT_AUTHENTICATED' }
  | { kind: 'CHANNEL_ERROR'; channelId: number; message: string }
  | { kind: 'UNKNOWN_OP'; op: string }
  | { kind: 'IO_ERROR'; message: string }
  | { kind: 'INVALID_ARGUMENT'; message: string };
