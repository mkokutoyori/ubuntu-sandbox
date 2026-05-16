/**
 * Result<T, E> — discriminated monad used everywhere in the RMAN module.
 *
 * No exceptions: errors flow as typed values that callers must inspect.
 * Modelled after Rust's Result and the FP-TS Either, with a flat record
 * shape that keeps narrowing trivial in TypeScript.
 */

export interface Ok<T>  { readonly ok: true;  readonly value: T }
export interface Err<E> { readonly ok: false; readonly error: E }

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T):  Ok<T>  { return { ok: true,  value }; }
export function err<E>(error: E): Err<E> { return { ok: false, error }; }
