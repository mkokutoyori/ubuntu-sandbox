/*
 * Probe - the byte-level verifier of journal files (journal-verify.c of systemd 255) against the real `journalctl --file=PATH --verify`.
 * scripts/oracle/record_journal_files.py wrote real journal files with the installed systemd-journald (plain, many-field, zstd-compressed, sealed first
 * file, sealed file created from a template after a rotation); scripts/oracle/record_journal_verify.py damaged each of them thousands of ways (every byte of the
 * header, every field of a sample of objects of every type, hash table items, entry flags, a seeded scatter, truncations, extensions, zeroed ranges) and kept the
 * exit status, stdout and stderr of the real tool for each, with the verification key for the sealed files.  Each damaged file is verified here with
 * renderVerification and the lines, the corruption offset and the percentage must be the ones the binary printed.
 * Measured with the tracked sources stashed (git stash push -- src/network): the 5 file cases fall (renderVerification is wired through the tracked tool and Errno table); the
 * witness case passes either way (it only reads the corpus).
 * One case in five of the scatter, zeroed ranges and table items, and one in three of the per-field damage of data, field, entry, entry array and tag objects, is replayed
 * here (the full corpus of 13 000 runs about ten minutes and agrees on every one: scratch sweep recorded in the commit message); every other class is replayed whole.
 * The corpus is nothing but verdicts; its witnesses are the untouched files (status 0 with PASS lines, and the sealed
 * file created from a template, whose tags the binary accepts), proving the lab itself sound.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { formatTimestamp, systemdClock } from '@/network/devices/linux/systemd/SystemdTime';
import { renderVerification } from '@/network/devices/linux/journal/format/JournalVerifyRun';
import { fileBytes, recordedScenarios } from './_helpers/journalFixture';

interface Case {
  readonly base: string;
  readonly label: string;
  readonly edits: readonly (readonly [number, string])[];
  readonly cut: number | null;
  readonly extend: string;
  readonly key: string;
  readonly keyText: string | null;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const corpus = JSON.parse(gunzipSync(readFileSync(new URL('../../support/oracle/journal/systemd-journal-verify.json.gz', import.meta.url))).toString('utf8')) as { path: string; cases: Case[] };
const scenarios = new Map(recordedScenarios().map((scenario) => [scenario.name, scenario]));
const bases = new Map([...scenarios].map(([name, scenario]) => {
  const bytes = new Uint8Array(scenario.allocated);
  bytes.set(fileBytes(scenario));
  return [name, bytes] as const;
}));

function damaged(testCase: Case): Uint8Array {
  const base = bases.get(testCase.base) as Uint8Array;
  const copy = new Uint8Array(base);
  for (const [offset, hex] of testCase.edits) copy.set(Buffer.from(hex, 'hex'), offset);
  const kept = testCase.cut === null ? copy : copy.subarray(0, testCase.cut);
  const extension = Buffer.from(testCase.extend, 'hex');
  if (extension.length === 0) return kept;
  const out = new Uint8Array(kept.length + extension.length);
  out.set(kept);
  out.set(extension, kept.length);
  return out;
}

const clock = systemdClock('UTC');
const STRIDES: readonly (readonly [RegExp, number])[] = [[/^(scatter|zero|table)/, 5], [/^object\d+@\d+\.(header|field|payload)/, 3]];

function replayed(base: string): Case[] {
  const counters = new Map<RegExp, number>();
  return corpus.cases.filter((candidate) => {
    if (candidate.base !== base) return false;
    const rule = STRIDES.find(([pattern]) => pattern.test(candidate.label));
    if (rule === undefined) return true;
    const seen = counters.get(rule[0]) ?? 0;
    counters.set(rule[0], seen + 1);
    return seen % rule[1] === 0;
  });
}

const timestamp = (usec: number): string => formatTimestamp(usec, 'pretty', clock) ?? '(null)';

describe('journal verification against journalctl --verify', () => {
  it('replays a corpus with witnesses on every side', () => {
    expect(corpus.cases.length).toBeGreaterThan(10000);
    expect(corpus.cases.filter((testCase) => testCase.status === 0).length).toBeGreaterThan(2000);
    expect(corpus.cases.filter((testCase) => testCase.status === 1).length).toBeGreaterThan(8000);
    expect(corpus.cases.filter((testCase) => testCase.label === 'untouched' && testCase.status === 0).map((testCase) => testCase.base).sort()).toEqual(['basic', 'sealed-rotated', 'variety', 'zstd']);
  });

  for (const base of ['basic', 'variety', 'zstd', 'sealed', 'sealed-rotated']) {
    it(`reports what journalctl reports for every damage of the ${base} file`, () => {
      const disagreements: string[] = [];
      for (const testCase of replayed(base)) {
        const bytes = damaged(testCase);
        const report = renderVerification([{ path: corpus.path, bytes }], testCase.keyText, false, true, timestamp);
        const stderr = (report.fatal !== null ? [...report.notices, report.fatal] : report.notices).map((line) => `${line}\n`).join('').split(corpus.path).join('{path}');
        if (report.status !== testCase.status || stderr !== testCase.stderr) {
          disagreements.push(`${testCase.label} [${testCase.key}]\n   got ${JSON.stringify([report.status, stderr])}\n  want ${JSON.stringify([testCase.status, testCase.stderr])}`);
        }
      }
      expect(disagreements.slice(0, 12)).toEqual([]);
      expect(replayed(base).length).toBeGreaterThan(900);
    }, 300_000);
  }
});
