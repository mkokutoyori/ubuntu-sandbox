import type { ReassemblyCounters } from '../../../l3/FragmentReassembly';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

const LABEL_WIDTH = 16;

export function renderIpFrags(counters: ReassemblyCounters): string {
  return [
    ['ReasmTimeout', counters.reasmTimeout],
    ['ReasmReqds', counters.reasmReqds],
    ['ReasmOKs', counters.reasmOKs],
    ['ReasmFails', counters.reasmFails],
  ].map(([label, value]) => `${padToWidth(String(label), LABEL_WIDTH)}${value}`)
    .join('\n');
}
