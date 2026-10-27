import type { Errno } from '@/network/core/Errno';
import { parseVerificationKey } from '../seal/SealingKeyFile';
import { formatTimespan } from '../../systemd/SystemdTime';
import { errnoText } from '@/network/core/Errno';
import { openJournal } from './JournalView';
import { verifyJournal } from './JournalVerifier';

export type VerifyOutcome =
  | { readonly kind: 'open-failed'; readonly errno: Errno }
  | { readonly kind: 'invalid-key' }
  | { readonly kind: 'fail'; readonly errno: Errno; readonly lines: readonly string[]; readonly corruption: { readonly offset: number; readonly size: number } | null }
  | { readonly kind: 'pass'; readonly sealed: boolean; readonly lines: readonly string[]; readonly first: number; readonly validated: number; readonly last: number };

export function verifyJournalBytes(bytes: Uint8Array, keyText: string | null, format: (usec: number) => string): VerifyOutcome {
  const opened = openJournal(bytes);
  if (!opened.ok) return { kind: 'open-failed', errno: opened.errno };
  const key = keyText === null ? null : parseVerificationKey(keyText);
  if (keyText !== null && key === null) return { kind: 'invalid-key' };
  const result = verifyJournal(opened.journal, key, format);
  if (!result.ok) {
    return {
      kind: 'fail', errno: result.errno, lines: result.log,
      corruption: result.corruptionOffset === null ? null : { offset: result.corruptionOffset, size: result.size },
    };
  }
  return { kind: 'pass', sealed: opened.journal.sealed, lines: result.log, first: Number(result.first), validated: Number(result.validated), last: Number(result.last) };
}

export interface VerifyFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface VerifyReport {
  readonly notices: readonly string[];
  readonly fatal: string | null;
  readonly status: number;
}

export function renderVerification(files: readonly VerifyFile[], keyText: string | null, quiet: boolean, explicit: boolean, format: (usec: number) => string): VerifyReport {
  const notices: string[] = [];
  let status = 0;
  for (const { path, bytes } of files) {
    const opened = openJournal(bytes);
    if (opened.ok && keyText === null && opened.journal.sealed) {
      notices.push(`Journal file ${path} has sealing enabled but verification key has not been passed using --verify-key=.`);
    }
    const outcome = verifyJournalBytes(bytes, keyText, format);
    if (outcome.kind === 'open-failed') {
      if (explicit) return { notices, fatal: `Failed to open files: ${errnoText(outcome.errno)}`, status: 1 };
      continue;
    }
    if (outcome.kind === 'invalid-key') return { notices, fatal: 'Failed to parse seed.', status: 1 };
    notices.push(...outcome.lines);
    if (outcome.kind === 'fail') {
      if (outcome.corruption !== null) {
        notices.push(`File corruption detected at ${path}:${outcome.corruption.offset} (of ${outcome.corruption.size} bytes, ${Math.floor(100 * outcome.corruption.offset / outcome.corruption.size)}%).`);
      }
      notices.push(`FAIL: ${path} (${errnoText(outcome.errno)})`);
      status = 1;
      continue;
    }
    if (!quiet) notices.push(`PASS: ${path}`);
    if (quiet || keyText === null || !outcome.sealed) continue;
    if (outcome.validated > 0) {
      notices.push(`=> Validated from ${format(outcome.first)} to ${format(outcome.validated)}, final ${formatTimespan(outcome.last > outcome.validated ? outcome.last - outcome.validated : 0, 0)} entries not sealed.`);
    } else if (outcome.last > 0) notices.push(`=> No sealing yet, ${formatTimespan(outcome.last - outcome.first, 0)} of entries not sealed.`);
    else notices.push('=> No sealing yet, no entries in file.');
  }
  return { notices, fatal: null, status };
}
