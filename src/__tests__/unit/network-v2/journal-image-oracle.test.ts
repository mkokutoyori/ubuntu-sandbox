/*
 * Probe - JournalImage, the byte-level writer of the systemd journal file format (journal-file.c of systemd 255, COMPACT and KEYED-HASH).  Five scenarios were
 * recorded from the installed systemd-journald (scripts/oracle/record_journal_files.py: plain, many fields, the first sealed file, the sealed file created from a
 * template after a rotation, the sealed file archived by that rotation; a zstd-compressed sixth is kept for the verifier, since libzstd's frames are not ours): the entries it wrote are read back out of the file and replayed through
 * the writer with the same file id, seqnum id, machine id, hash table size and allocation, and the result must equal the recorded file byte for byte (headers,
 * hash tables, every data, field, entry and entry-array object, the chains between them, the counters and the chain depths).
 * Measured with the tracked sources stashed (git stash push -- src/network): the sealed, sealed-rotated and sealed-first cases fall (the tag writer, the closing tag and the
 * template identity are tracked changes); basic and variety pass either way (STRUCTURAL: the writer is an untracked-new module that stays in place).
 */
import { describe, expect, it } from 'vitest';
import { HEADER, HEADER_SIZE } from '@/network/devices/linux/journal/format/JournalLayout';
import { fileBytes, recordedScenarios, replayScenario } from './_helpers/journalFixture';

const NAMES = Object.entries(HEADER).sort((left, right) => left[1] - right[1]);

function fieldAt(offset: number): string {
  if (offset >= HEADER_SIZE) return `object area @${offset}`;
  const field = [...NAMES].reverse().find(([, start]) => start <= offset);
  return field === undefined ? `header @${offset}` : `${field[0]}+${offset - field[1]}`;
}

describe('JournalImage against systemd-journald', () => {
  for (const scenario of recordedScenarios().filter((candidate) => candidate.name !== 'zstd')) {
    it(`writes the ${scenario.name} journal byte for byte`, () => {
      const real = fileBytes(scenario);
      const mine = replayScenario(scenario, real).snapshot();
      expect(mine.length).toBe(real.length);
      const different: string[] = [];
      for (let index = 0; index < real.length && different.length < 8; index++) if (mine[index] !== real[index]) different.push(`${index} ${fieldAt(index)} ${mine[index]} != ${real[index]}`);
      expect(different).toEqual([]);
    });
  }
});
