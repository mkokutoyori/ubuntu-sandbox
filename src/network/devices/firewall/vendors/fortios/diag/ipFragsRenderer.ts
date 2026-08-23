import type { ReassemblyCounters } from '../../../l3/FragmentReassembly';

const LABEL_WIDTH = 16;

export function renderIpFrags(counters: ReassemblyCounters): string {
  return [
    ['ReasmTimeout', counters.reasmTimeout],
    ['ReasmReqds', counters.reasmReqds],
    ['ReasmOKs', counters.reasmOKs],
    ['ReasmFails', counters.reasmFails],
  ].map(([label, value]) => `${String(label).padEnd(LABEL_WIDTH)}${value}`)
    .join('\n');
}
