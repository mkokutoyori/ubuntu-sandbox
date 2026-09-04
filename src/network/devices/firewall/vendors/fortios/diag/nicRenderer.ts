import type { PortCounters } from '@/network/core/types';

export interface NicView {
  readonly name: string;
  readonly currentMac: string;
  readonly permanentMac: string;
  readonly adminUp: boolean;
  readonly linkUp: boolean;
  readonly speed: number;
  readonly duplex: string;
  readonly counters: Readonly<PortCounters>;
}

const FIELD_WIDTH = 22;

function field(name: string, value: string): string {
  return `${name.padEnd(FIELD_WIDTH)}${value}`;
}

function statLine(counters: Readonly<PortCounters>): string {
  return `stat: rxp=${counters.framesIn} txp=${counters.framesOut}`
    + ` rxb=${counters.bytesIn} txb=${counters.bytesOut}`
    + ` rxe=${counters.errorsIn} txe=${counters.errorsOut}`
    + ` rxd=${counters.dropsIn} txd=${counters.dropsOut}`
    + ` mc=${counters.multicastIn} collision=0`;
}

export function renderNic(nic: NicView): string {
  return [
    field('Current_HWaddr', nic.currentMac),
    field('Permanent_HWaddr', nic.permanentMac),
    field('Admin', `:${nic.adminUp ? 'up' : 'down'}`),
    field('netdev status', `:${nic.linkUp ? 'up' : 'down'}`),
    field('Speed', `:${nic.speed}`),
    field('Duplex', `:${nic.duplex}`),
    field('link_status', `:${nic.linkUp ? 'Up' : 'Down'}`),
    statLine(nic.counters),
  ].join('\n');
}

export function renderNicList(nics: readonly NicView[]): string {
  return nics.map(nic => `${nic.name}\n${renderNic(nic)}`).join('\n\n');
}
