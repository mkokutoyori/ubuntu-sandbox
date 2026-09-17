import type { IPAddress, PortCounters, SubnetMask } from '@/network/core/types';

export interface IfconfigAddress {
  readonly ip: IPAddress;
  readonly mask: SubnetMask;
}

export interface IfconfigView {
  readonly name: string;
  readonly hardwareAddress: string;
  readonly address?: IfconfigAddress;
  readonly adminUp: boolean;
  readonly linkUp: boolean;
  readonly mtu: number;
  readonly counters: Readonly<PortCounters>;
}

const INDENT = ' '.repeat(8);
const METRIC = 1;
const TX_QUEUE_LENGTH = 1000;

const SCALED_UNITS: ReadonlyArray<readonly [number, string]> = Object.freeze([
  [1024 ** 3, 'GB'],
  [1024 ** 2, 'MB'],
  [1024, 'KB'],
]);

function scaledBytes(count: number): string {
  for (const [divisor, unit] of SCALED_UNITS) {
    if (count >= divisor) return `${(count / divisor).toFixed(1)} ${unit}`;
  }
  return `${count}  Bytes`;
}

function flagWords(view: IfconfigView): string {
  const words: string[] = [];
  if (view.adminUp) words.push('UP');
  words.push('BROADCAST');
  if (view.linkUp) words.push('RUNNING');
  words.push('MULTICAST');
  return words.join(' ');
}

function addressLine(address: IfconfigAddress): string {
  return `inet addr:${address.ip}`
    + `  Bcast:${address.ip.broadcastAddress(address.mask)}`
    + `  Mask:${address.mask}`;
}

export function renderIfconfig(view: IfconfigView): string {
  const counters = view.counters;
  const lines = [`${view.name}\tLink encap:Ethernet  HWaddr ${view.hardwareAddress}`];
  if (view.address !== undefined) lines.push(INDENT + addressLine(view.address));
  lines.push(
    `${INDENT}${flagWords(view)}  MTU:${view.mtu}  Metric:${METRIC}`,
    `${INDENT}RX packets:${counters.framesIn} errors:${counters.errorsIn}`
      + ` dropped:${counters.dropsIn} overruns:0 frame:0`,
    `${INDENT}TX packets:${counters.framesOut} errors:${counters.errorsOut}`
      + ` dropped:${counters.dropsOut} overruns:0 carrier:0`,
    `${INDENT}collisions:0 txqueuelen:${TX_QUEUE_LENGTH}`,
    `${INDENT}RX bytes:${counters.bytesIn} (${scaledBytes(counters.bytesIn)})`
      + `  TX bytes:${counters.bytesOut} (${scaledBytes(counters.bytesOut)})`,
  );
  return lines.join('\n');
}

export function renderIfconfigList(views: readonly IfconfigView[]): string {
  return views.map(renderIfconfig).join('\n\n');
}
