import type { JournalFile } from '../JournalFileSet';
import { epochOf, evolve, generateMasterKey, seek, type MasterKey } from './Fsprg';
import { tagKey, tagValue } from './SealChain';
import type { VerificationKey } from './SealingKeyFile';

export type SealVerification =
  | { readonly ok: true; readonly validatedUsec: number }
  | { readonly ok: false; readonly offset: number; readonly message: string };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function verifySeal(file: JournalFile, key: VerificationKey, format: (usec: number) => string): SealVerification {
  const chain = file.seal;
  if (chain === null) return { ok: true, validatedUsec: 0 };
  let master: MasterKey | null = null;
  let state: Uint8Array | null = null;
  let lastEpoch = 0;
  let lastTagRealtime = 0;
  for (const [index, tag] of chain.tags.entries()) {
    const fail = (message: string): SealVerification => ({ ok: false, offset: tag.offset, message });
    if (!(index === 0 || (index === 1 && tag.epoch === lastEpoch) || tag.epoch === lastEpoch + 1)) {
      return fail(`Epoch sequence not continuous (${tag.epoch} vs ${lastEpoch})`);
    }
    const start = key.startUsec + tag.epoch * key.intervalUsec;
    const end = start + key.intervalUsec;
    if (tag.lastEntryRealtime !== null && tag.lastEntryRealtime >= end) {
      return fail(`tag/entry realtime timestamp out of synchronization (${tag.lastEntryRealtime} >= ${end})`);
    }
    if (tag.maxEntryRealtime >= end) {
      return fail(`Entry realtime (${tag.maxEntryRealtime}, ${format(tag.maxEntryRealtime)}) is too late with respect to tag (${end}, ${format(end)})`);
    }
    if (tag.minEntryRealtime < start) {
      return fail(`Entry realtime (${tag.minEntryRealtime}, ${format(tag.minEntryRealtime)}) is too early with respect to tag (${start}, ${format(start)})`);
    }
    if (state !== null && tag.epoch === epochOf(state) + 1) evolve(state);
    else if (state === null || tag.epoch !== epochOf(state)) {
      master ??= generateMasterKey(key.seed);
      state = seek(tag.epoch, master, key.seed);
    }
    const stream = tag.headerIndex === null ? tag.stream : tag.stream.map((chunk, at) => (at === tag.headerIndex ? file.currentSealedHeader() : chunk));
    if (!sameBytes(tagValue(tagKey(state), stream), tag.tag)) return fail('Tag failed verification');
    lastTagRealtime = start;
    lastEpoch = tag.epoch;
  }
  return { ok: true, validatedUsec: lastTagRealtime + key.intervalUsec };
}
