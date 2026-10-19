import type { NtpAgent } from '../../ntp/NtpAgent';
import { NTP_MAX_STRATUM, type NtpAssociation, type NtpMode } from '../../ntp/types';
import { simulationNowMs } from '../../core/SystemClock';
import type { SnmpValue } from '../types';

export const NTPV4_MIB = '1.3.6.1.2.1.197.1';
const INFO = `${NTPV4_MIB}.1`;
const STATUS = `${NTPV4_MIB}.2`;
const ASSOCIATION = `${NTPV4_MIB}.3`;

export interface NtpV4MibIdentity {
  readonly softwareName: string;
  readonly softwareVersion: string;
  readonly vendor: string;
  readonly systemType: string;
}

export const NTPV4_CURRENT_MODE = {
  notRunning: 1, notSynchronized: 2, noneConfigured: 3, syncToLocal: 4, syncToRefclock: 5, syncToRemoteServer: 6, unknown: 99,
} as const;

const PACKET_MODES: readonly { readonly index: number; readonly sent: NtpMode; readonly received: NtpMode }[] = [
  { index: 1, sent: 'symmetric-active', received: 'symmetric-active' },
  { index: 2, sent: 'symmetric-passive', received: 'symmetric-passive' },
  { index: 3, sent: 'client', received: 'client' },
  { index: 4, sent: 'server', received: 'server' },
  { index: 5, sent: 'broadcast', received: 'server' },
  { index: 6, sent: 'server', received: 'broadcast' },
];

const text = (value: string): SnmpValue => ({ type: 'octet-string', value });
const integer = (value: number): SnmpValue => ({ type: 'integer', value });
const unsigned = (value: number): SnmpValue => ({ type: 'gauge32', value: Math.max(0, Math.trunc(value)) });
const counter = (value: number): SnmpValue => ({ type: 'counter32', value: Math.max(0, Math.trunc(value)) % 4294967296 });

function withUnit(milliseconds: number): string {
  return Math.abs(milliseconds) >= 1000 ? `${(milliseconds / 1000).toFixed(3)} s` : `${milliseconds.toFixed(3)} ms`;
}

function ntpDateTime(epochMs: number): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  const seconds = Math.floor(epochMs / 1000) + 2208988800;
  const era = Math.floor(seconds / 4294967296);
  view.setUint32(0, era >>> 0);
  view.setUint32(4, seconds % 4294967296);
  const fraction = Math.floor(((epochMs % 1000) / 1000) * 4294967296);
  view.setUint32(8, fraction >>> 0);
  return out;
}

export function currentMode(agent: NtpAgent): number {
  const config = agent.getConfig();
  if (!config.enabled) return NTPV4_CURRENT_MODE.notRunning;
  if (agent.isSynced()) return config.system.peerIp === null ? NTPV4_CURRENT_MODE.syncToLocal : NTPV4_CURRENT_MODE.syncToRemoteServer;
  return config.associations.size === 0 ? NTPV4_CURRENT_MODE.noneConfigured : NTPV4_CURRENT_MODE.notSynchronized;
}

function scalars(agent: NtpAgent, identity: NtpV4MibIdentity): Map<string, () => SnmpValue> {
  const config = agent.getConfig();
  const system = config.system;
  const counters = config.counters;
  const rootDistance = (): number => system.rootDelayMs / 2 + system.rootDispersionMs;
  const syspeer = (): NtpAssociation | undefined => (system.peerIp === null ? undefined : config.associations.get(system.peerIp));
  const rows = new Map<string, () => SnmpValue>();
  const set = (oid: string, read: () => SnmpValue): void => { rows.set(`${oid}.0`, read); };
  set(`${INFO}.1`, () => text(identity.softwareName));
  set(`${INFO}.2`, () => text(identity.softwareVersion));
  set(`${INFO}.3`, () => text(identity.vendor));
  set(`${INFO}.4`, () => text(identity.systemType));
  set(`${INFO}.5`, () => unsigned(Math.round(1 / 2 ** system.precision)));
  set(`${INFO}.6`, () => integer(system.precision));
  set(`${INFO}.7`, () => text(withUnit(rootDistance())));
  set(`${STATUS}.1`, () => integer(currentMode(agent)));
  set(`${STATUS}.2`, () => unsigned(agent.isSynced() ? agent.getStratum() : NTP_MAX_STRATUM));
  set(`${STATUS}.3`, () => unsigned(system.peerIp === null ? 0 : agent.associationId(system.peerIp)));
  set(`${STATUS}.4`, () => text(system.peerIp ?? ''));
  set(`${STATUS}.5`, () => text(withUnit(syspeer()?.offsetMs ?? 0)));
  set(`${STATUS}.6`, () => unsigned(config.associations.size));
  set(`${STATUS}.7`, () => text(system.rootDispersionMs.toFixed(3)));
  set(`${STATUS}.8`, () => ({ type: 'timeticks', value: Math.floor((simulationNowMs() - config.startedAtMs) / 10) }));
  set(`${STATUS}.9`, () => ({ type: 'octet-string', value: agent.isSynced() ? ntpDateTime(agent.now()) : new Uint8Array(0) }));
  set(`${STATUS}.10`, () => ({ type: 'octet-string', value: new Uint8Array(16) }));
  set(`${STATUS}.11`, () => integer(0));
  set(`${STATUS}.12`, () => counter(counters.received));
  set(`${STATUS}.13`, () => counter(counters.sent));
  set(`${STATUS}.14`, () => counter(counters.badVersion));
  set(`${STATUS}.15`, () => counter(counters.protocolError));
  set(`${STATUS}.16`, () => counter(0));
  for (const mode of PACKET_MODES) {
    rows.set(`${STATUS}.17.1.2.${mode.index}`, () => counter(counters.sentByMode[mode.sent]));
    rows.set(`${STATUS}.17.1.3.${mode.index}`, () => counter(counters.receivedByMode[mode.received]));
  }
  return rows;
}

export function ntpV4MibRows(agent: NtpAgent, identity: NtpV4MibIdentity): ReadonlyMap<string, () => SnmpValue> {
  const rows = scalars(agent, identity);
  for (const association of agent.getConfig().associations.values()) {
    const id = agent.associationId(association.serverIp);
    const octets = association.serverIp.split('.').map(Number);
    const entry = (column: number, read: () => SnmpValue): void => { rows.set(`${ASSOCIATION}.1.1.${column}.${id}`, read); };
    entry(2, () => text(association.serverIp));
    entry(3, () => text(''));
    entry(4, () => integer(1));
    entry(5, () => ({ type: 'octet-string', value: Uint8Array.from(octets) }));
    entry(6, () => text(withUnit(association.offsetMs)));
    entry(7, () => unsigned(Math.min(Math.max(association.stratum, 1), NTP_MAX_STRATUM)));
    entry(8, () => text(association.jitterMs.toFixed(3)));
    entry(9, () => text(association.delayMs.toFixed(3)));
    entry(10, () => text(association.dispersionMs.toFixed(3)));
    rows.set(`${ASSOCIATION}.2.1.1.${id}`, () => counter(association.received));
    rows.set(`${ASSOCIATION}.2.1.2.${id}`, () => counter(association.sent));
    rows.set(`${ASSOCIATION}.2.1.3.${id}`, () => counter(0));
  }
  return rows;
}
