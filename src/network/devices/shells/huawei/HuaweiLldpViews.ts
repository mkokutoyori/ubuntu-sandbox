import type { LldpAgent, LldpNeighbor } from '@/network/lldp/LldpAgent';
import { lldpCapabilityWords } from '@/network/lldp/types';
import { MACAddress } from '@/network/core/types';

const NOT_ADVERTISED = '--';

function vrpChassisId(n: { chassisId: string; chassisIdSubtype: string }): string {
  if (n.chassisIdSubtype !== 'macAddress') return n.chassisId;
  try { return new MACAddress(n.chassisId).toHuaweiString(); } catch { return n.chassisId; }
}

function field(label: string, value: string): string {
  return `${label} :${value}`;
}

export function renderVrpLldpNeighborBrief(
  agent: LldpAgent, displayName: (n: string) => string = (n) => n,
): string {
  const rows = agent.getNeighbors().map(n =>
    `${displayName(n.localPort).padEnd(25)} ${(n.systemName ?? NOT_ADVERTISED).padEnd(15)} ` +
    `${n.portId.padEnd(15)} ${agent.ttlRemainingSec(n)}`);
  return [
    'Local Intf                Neighbor Dev    Neighbor Intf   Exptime(s)',
    ...rows,
    `Total: ${rows.length}`,
  ].join('\n');
}

export function renderVrpLldpNeighborVerbose(
  agent: LldpAgent, portNames: readonly string[],
  displayName: (n: string) => string = (n) => n,
): string {
  const lines: string[] = [];
  let total = 0;
  for (const name of portNames) {
    const found = agent.getNeighborsOnPort(name);
    if (found.length === 0) {
      lines.push(`${displayName(name)} has 0 neighbors`, '');
      continue;
    }
    lines.push(`${displayName(name)} has ${found.length} neighbors:`, '');
    found.forEach((n, i) => {
      total += 1;
      lines.push(field('Neighbor index', ` ${i + 1}`));
      lines.push(field('Chassis type', n.chassisIdSubtype));
      lines.push(field('Chassis ID', vrpChassisId(n)));
      lines.push(field('Port ID type', n.portIdSubtype));
      lines.push(field('Port ID', n.portId));
      lines.push(field('Port description', n.portDescription ?? NOT_ADVERTISED));
      lines.push(field('System name', n.systemName ?? NOT_ADVERTISED));
      lines.push(field('System description', n.systemDescription ?? NOT_ADVERTISED));
      const caps = n.remoteCapabilities
        ? lldpCapabilityWords(n.remoteCapabilities) : NOT_ADVERTISED;
      lines.push(field('System capabilities supported', caps));
      lines.push(field('System capabilities enabled', caps));
      const addrs = n.managementAddresses ?? [];
      lines.push(field('Management address type', addrs.length ? 'ipV4' : NOT_ADVERTISED));
      lines.push(field('Management address', addrs.length ? ` ${addrs[0]}` : NOT_ADVERTISED));
      lines.push(field('Expired time', `${agent.ttlRemainingSec(n)}s`));
      lines.push('');
    });
  }
  lines.push(`Total: ${total}`);
  return lines.join('\n');
}

export function renderVrpLldpStatistics(
  agent: LldpAgent, portNames: readonly string[],
  displayName: (n: string) => string = (n) => n,
): string {
  const global = agent.getTraffic();
  const lines = [
    'LLDP statistics global Information:',
    field('Total Neighbors Expired', String(global.entriesAged)),
    '',
  ];
  for (const name of portNames) {
    const t = agent.getTraffic(name);
    lines.push(`Statistics for ${displayName(name)}:`);
    lines.push(field('Sent Frames', String(t.framesOut)));
    lines.push(field('Received Frames', String(t.framesIn)));
    lines.push(field('Frames Discarded', String(t.framesDiscarded)));
    lines.push(field('Frames Error', String(t.framesInError)));
    lines.push(field('TLVs Discarded', String(t.tlvsDiscarded)));
    lines.push(field('TLVs Unrecognized', String(t.tlvsUnrecognized)));
    lines.push(field('Neighbors Expired', String(t.entriesAged)));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function renderVrpLldpLocal(
  agent: LldpAgent, hostname: string,
  portNames: readonly string[], withGlobal: boolean,
  displayName: (n: string) => string = (n) => n,
): string {
  const lines: string[] = [];
  const cfg = agent.getConfig();
  if (withGlobal) {
    const first = portNames[0];
    const self = first ? agent.localIdentity(first) : undefined;
    lines.push('Global LLDP Information:');
    lines.push(field('Chassis type', self?.chassisIdSubtype ?? 'macAddress'));
    lines.push(field('Chassis ID', self ? vrpChassisId(self) : NOT_ADVERTISED));
    lines.push(field('System name', hostname));
    lines.push(field('System description', self?.systemDescription ?? NOT_ADVERTISED));
    const caps = self?.capabilities ? lldpCapabilityWords(self.capabilities) : NOT_ADVERTISED;
    lines.push(field('System capabilities supported', caps));
    lines.push(field('System capabilities enabled', caps));
    lines.push(field('LLDP Status', cfg.enabled ? 'enabled' : 'disabled'));
    lines.push(field('Message transmission interval', `${cfg.timerSec}`));
    lines.push(field('Message transmission hold multiplier', `${cfg.holdtimeMultiplier}`));
    lines.push(field('Reinit delay', `${cfg.reinitDelaySec}`));
    lines.push('');
  }
  for (const name of portNames) {
    const adv = agent.buildAdvertisement(name);
    lines.push(`${displayName(name)}:`);
    lines.push(field('Port ID type', adv.portIdSubtype));
    lines.push(field('Port ID', adv.portId));
    lines.push(field('Port description', adv.portDescription ?? NOT_ADVERTISED));
    lines.push(field('Port status',
      agent.isPortTransmitEnabled(name) || agent.isPortReceiveEnabled(name)
        ? 'enabled' : 'disabled'));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export interface VrpLldpViewHost {
  agent(): LldpAgent | null;
  hostname(): string;
  portNames(): string[];
  displayName(portName: string): string;
  resolveInterface(raw: string): string | null;
}

const WRONG_PARAMETER = "Error: Wrong parameter found at '^' position.";
const NO_SUCH_INTERFACE = 'Error: The interface does not exist.';

function namedInterface(host: VrpLldpViewHost, args: string[]): string | null | undefined {
  const rest = args.filter(a => a.toLowerCase() !== 'brief');
  if (rest.length === 0) return undefined;
  if (rest[0].toLowerCase() !== 'interface') return null;
  return host.resolveInterface(rest.slice(1).join(' '));
}

function scope(host: VrpLldpViewHost, args: string[]):
  { error: string } | { ports: string[]; named: boolean } {
  const named = namedInterface(host, args);
  if (named === null) return { error: WRONG_PARAMETER };
  if (named === undefined) return { ports: host.portNames(), named: false };
  const ports = host.portNames().filter(n => n === named);
  if (ports.length === 0) return { error: NO_SUCH_INTERFACE };
  return { ports, named: true };
}

export function registerVrpLldpDisplayCommands(
  trie: {
    registerGreedy(path: string, description: string,
      handler: (args: string[]) => string): void;
  },
  host: VrpLldpViewHost,
): void {
  const withAgent = (
    fn: (agent: LldpAgent, args: string[]) => string,
  ) => (args: string[]): string => {
    const agent = host.agent();
    if (!agent) return 'Info: LLDP is not enabled.';
    return fn(agent, args);
  };

  trie.registerGreedy('display lldp neighbor', 'Display LLDP neighbours', withAgent((agent, args) => {
    const show = (n: string) => host.displayName(n);
    if (args.some(a => a.toLowerCase() === 'brief')) {
      return renderVrpLldpNeighborBrief(agent, show);
    }
    const s = scope(host, args);
    return 'error' in s ? s.error : renderVrpLldpNeighborVerbose(agent, s.ports, show);
  }));
  trie.registerGreedy('display lldp statistics', 'Display LLDP packet statistics',
    withAgent((agent, args) => {
      const s = scope(host, args);
      return 'error' in s
        ? s.error : renderVrpLldpStatistics(agent, s.ports, (n) => host.displayName(n));
    }));
  trie.registerGreedy('display lldp local', 'Display local LLDP information',
    withAgent((agent, args) => {
      const s = scope(host, args);
      return 'error' in s
        ? s.error
        : renderVrpLldpLocal(agent, host.hostname(), s.ports, !s.named,
          (n) => host.displayName(n));
    }));
  trie.registerGreedy('reset lldp statistics', 'Clear LLDP packet statistics',
    withAgent((agent, args) => {
      const s = scope(host, args);
      if ('error' in s) return s.error;
      if (s.named) agent.resetTraffic(s.ports[0]); else agent.resetTraffic();
      return '';
    }));
}

export function applyVrpLldpAdminStatus(
  agent: LldpAgent | null, portName: string, mode: string,
): string {
  if (!agent) return 'Info: LLDP is not enabled.';
  switch (mode.toLowerCase()) {
    case 'tx': agent.setPortTransmit(portName, true); agent.setPortReceive(portName, false); return '';
    case 'rx': agent.setPortTransmit(portName, false); agent.setPortReceive(portName, true); return '';
    case 'txrx': agent.setPortTransmit(portName, true); agent.setPortReceive(portName, true); return '';
    case 'disabled': agent.setPortTransmit(portName, false); agent.setPortReceive(portName, false); return '';
    default: return WRONG_PARAMETER;
  }
}
