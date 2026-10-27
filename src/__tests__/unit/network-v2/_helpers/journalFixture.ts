import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { JournalImage } from '@/network/devices/linux/journal/format/JournalImage';
import { DATA, ENTRY, ENTRY_ARRAY, HEADER, HEADER_SIZE, OBJECT_TAG } from '@/network/devices/linux/journal/format/JournalLayout';
import { epochOf, evolve } from '@/network/devices/linux/journal/seal/Fsprg';
import { SealChain, type SealKey } from '@/network/devices/linux/journal/seal/SealChain';
import { decodeSealingKey } from '@/network/devices/linux/journal/seal/SealingKeyFile';

export interface RecordedScenario {
  readonly name: string;
  readonly allocated: number;
  readonly file: { readonly size: number; readonly chunks: readonly (readonly [number, string])[] };
  readonly export: string;
  readonly header: string;
  readonly verify: { readonly status: number; readonly stdout: string; readonly stderr: string };
  readonly sealing: null | { readonly setup: string; readonly fss: string; readonly key: string; readonly machine: string; readonly status: number; readonly stdout: string; readonly stderr: string };
}

export function recordedScenarios(): RecordedScenario[] {
  const text = gunzipSync(readFileSync(new URL('../../../support/oracle/journal/systemd-journal-files.json.gz', import.meta.url))).toString('utf8');
  return (JSON.parse(text) as { scenarios: RecordedScenario[] }).scenarios;
}

export function fileBytes(scenario: RecordedScenario): Uint8Array {
  const bytes = new Uint8Array(scenario.file.size);
  for (const [offset, hex] of scenario.file.chunks) bytes.set(Buffer.from(hex, 'hex'), offset);
  return bytes;
}

export interface ReadEntry {
  readonly payloads: Uint8Array[];
  readonly seqnum: number;
  readonly realtime: number;
  readonly monotonic: number;
  readonly bootId: Uint8Array;
  readonly xorHash: bigint;
}

export function readEntries(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const u64 = (offset: number): number => view.getUint32(offset + 4, true) * 0x100000000 + view.getUint32(offset, true);
  const entries: number[] = [];
  const total = u64(HEADER.nEntries);
  for (let array = u64(HEADER.entryArrayOffset); array !== 0 && entries.length < total; array = u64(array + ENTRY_ARRAY.nextEntryArrayOffset)) {
    const capacity = (u64(array + 8) - 24) / 4;
    for (let index = 0; index < capacity && entries.length < total; index++) {
      const item = view.getUint32(array + ENTRY_ARRAY.items + index * 4, true);
      if (item === 0) break;
      entries.push(item);
    }
  }
  return entries.map((offset) => {
    const size = u64(offset + 8);
    const count = (size - ENTRY.items) / 4;
    const payloads: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const data = view.getUint32(offset + ENTRY.items + index * 4, true);
      payloads.push(bytes.slice(data + DATA.payload, data + u64(data + 8)));
    }
    return {
      payloads, seqnum: u64(offset + ENTRY.seqnum), realtime: u64(offset + ENTRY.realtime), monotonic: u64(offset + ENTRY.monotonic),
      bootId: bytes.slice(offset + ENTRY.bootId, offset + ENTRY.bootId + 16), xorHash: view.getBigUint64(offset + ENTRY.xorHash, true),
    };
  });
}

function sealKeyOf(scenario: RecordedScenario, real: Uint8Array): SealKey | null {
  if (scenario.sealing === null) return null;
  const text = Buffer.from(scenario.sealing.fss, 'hex').toString('latin1');
  const decoded = decodeSealingKey(text, scenario.sealing.machine);
  if (typeof decoded === 'string') throw new Error(decoded);
  const view = new DataView(real.buffer, real.byteOffset, real.length);
  let at = HEADER_SIZE;
  while (real[at] !== OBJECT_TAG) at += Number((view.getBigUint64(at + 8, true) + 7n) & ~7n);
  const firstTagEpoch = Number(view.getBigUint64(at + 24, true));
  while (epochOf(decoded.state) < firstTagEpoch) evolve(decoded.state);
  return { startUsec: decoded.startUsec, intervalUsec: decoded.intervalUsec, state: decoded.state, persist: () => undefined };
}

export function replayScenario(scenario: RecordedScenario, real: Uint8Array): JournalImage {
  const view = new DataView(real.buffer);
  const fileId = real.slice(HEADER.fileId, HEADER.fileId + 16);
  const finalSeqnumId = real.slice(HEADER.seqnumId, HEADER.seqnumId + 16);
  const key = sealKeyOf(scenario, real);
  const image = new JournalImage({
    identity: { fileId, machineId: real.slice(HEADER.machineId, HEADER.machineId + 16), seqnumId: key === null || scenario.name === 'sealed-rotated' ? finalSeqnumId : fileId },
    dataTableItems: view.getUint32(HEADER.dataHashTableSize, true) / 16,
    compressEnabled: false,
    sealed: key !== null,
    allocate: () => scenario.allocated,
  });
  if (key !== null) image.attachSealer(new SealChain(key, () => image.appendTagObject(), (offset, seqnum, epoch, tag) => image.writeTag(offset, seqnum, epoch, tag)));
  let first = true;
  for (const entry of readEntries(real)) {
    image.appendEntry(entry.payloads, entry.realtime, entry.monotonic, entry.seqnum, entry.bootId);
    if (first && scenario.name !== 'sealed-rotated') image.setSeqnumId(finalSeqnumId);
    first = false;
  }
  image.closeFile(key === null ? 0 : closingTime(key, real));
  image.setState(real[HEADER.state] as 0);
  return image;
}


function closingTime(key: SealKey, real: Uint8Array): number {
  const view = new DataView(real.buffer, real.byteOffset, real.length);
  let at = HEADER_SIZE;
  let epoch = 0;
  const tail = Number(view.getBigUint64(HEADER.tailObjectOffset, true));
  while (at <= tail) {
    if (real[at] === OBJECT_TAG) epoch = Number(view.getBigUint64(at + 24, true));
    at += Number((view.getBigUint64(at + 8, true) + 7n) & ~7n);
  }
  return key.startUsec + epoch * key.intervalUsec;
}
