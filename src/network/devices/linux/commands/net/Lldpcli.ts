import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { LldpAgent, LldpNeighbor } from '@/network/lldp/LldpAgent';
import type { LldpCapability, LldpFrame } from '@/network/lldp/types';

const SEP = '-'.repeat(79);

const CAPABILITY_SYMBOL: Readonly<Record<LldpCapability, string>> = {
  Other: 'Other', Repeater: 'Repeater', Bridge: 'Bridge',
  Router: 'Router', Telephone: 'Tel', Station: 'Station',
};

const LLDPCLI_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-f', dest: 'format', takesArg: true, argName: 'format',
    description: 'Choose output format (plain, json)' },
];

class TextWriter {
  private readonly lines: string[] = [];
  private current = '';
  private level = 0;
  private attrs = 0;

  start(label: string): void {
    if (this.level === 0) {
      this.flush();
      this.lines.push(SEP);
    } else {
      this.flush();
    }
    const indent = '  '.repeat(Math.max(0, this.level - 1));
    this.current = `${indent}${`${label}:`.padEnd(13)}`;
    if (this.level === 0) {
      this.lines.push(this.current, SEP);
      this.current = '';
    }
    this.level += 1;
    this.attrs = 0;
  }

  attr(label: string, value: string): void {
    const prefix = this.attrs > 0 ? ', ' : ' ';
    this.current += label ? `${prefix}${label}: ${value}` : `${prefix}${value}`;
    this.attrs += 1;
  }

  data(value: string): void {
    this.current += ` ${value}`;
  }

  end(): void {
    this.level -= 1;
    this.attrs = 0;
    this.flush();
  }

  private flush(): void {
    if (this.current.trim().length > 0) this.lines.push(this.current.trimEnd());
    this.current = '';
  }

  render(): string {
    this.flush();
    this.lines.push(SEP);
    return this.lines.join('\n');
  }
}

function ageSince(ttlSec: number, remaining: number): string {
  const age = Math.max(0, ttlSec - remaining);
  const days = Math.floor(age / 86400);
  const hh = String(Math.floor(age / 3600) % 24).padStart(2, '0');
  const mm = String(Math.floor(age / 60) % 60).padStart(2, '0');
  const ss = String(age % 60).padStart(2, '0');
  return `${days} day${days > 1 ? 's' : ''}, ${hh}:${mm}:${ss}`;
}

function writeChassis(
  w: TextWriter, chassisId: string, systemName: string | undefined,
  systemDescription: string | undefined, capabilities: readonly LldpCapability[] | undefined,
  addresses: readonly string[] | undefined,
): void {
  w.start('Chassis');
  w.start('ChassisID');
  w.attr('', 'mac');
  w.data(chassisId);
  w.end();
  if (systemName !== undefined) { w.start('SysName'); w.data(systemName); w.end(); }
  if (systemDescription !== undefined) {
    w.start('SysDescr'); w.data(systemDescription); w.end();
  }
  for (const a of addresses ?? []) { w.start('MgmtIP'); w.data(a); w.end(); }
  for (const c of capabilities ?? []) {
    w.start('Capability');
    w.attr('', CAPABILITY_SYMBOL[c]);
    w.attr('', 'on');
    w.end();
  }
  w.end();
}

function renderNeighbors(agent: LldpAgent, ifaces: readonly string[]): string {
  const w = new TextWriter();
  w.start('LLDP neighbors');
  for (const iface of ifaces) {
    for (const n of agent.getNeighborsOnPort(iface)) {
      const remaining = agent.ttlRemainingSec(n);
      w.start('Interface');
      w.attr('', iface);
      w.attr('via', 'LLDP');
      w.attr('RID', '1');
      w.attr('Time', ageSince(n.ttlSec, remaining));
      writeChassis(w, n.chassisId, n.systemName, n.systemDescription,
        n.remoteCapabilities, n.managementAddresses);
      w.start('Port');
      w.start('PortID');
      w.attr('', 'ifname');
      w.data(n.portId);
      w.end();
      if (n.portDescription !== undefined) {
        w.start('PortDescr'); w.data(n.portDescription); w.end();
      }
      w.end();
      w.end();
    }
  }
  return w.render();
}

function renderChassis(agent: LldpAgent, iface: string): string {
  const w = new TextWriter();
  const self: LldpFrame = agent.localIdentity(iface);
  w.start('Local chassis');
  writeChassis(w, self.chassisId, self.systemName, self.systemDescription,
    self.capabilities, self.managementAddresses);
  return w.render();
}

function renderStatistics(agent: LldpAgent, ifaces: readonly string[]): string {
  const w = new TextWriter();
  w.start('LLDP statistics');
  for (const iface of ifaces) {
    const t = agent.getTraffic(iface);
    w.start('Interface');
    w.attr('', iface);
    for (const [label, value] of [
      ['Transmitted', t.framesOut], ['Received', t.framesIn],
      ['Discarded', t.framesDiscarded], ['Unrecognized', t.tlvsUnrecognized],
      ['Ageout', t.entriesAged], ['Inserted', t.framesIn], ['Deleted', t.entriesAged],
    ] as const) {
      w.start(label);
      w.data(String(value));
      w.end();
    }
    w.end();
  }
  return w.render();
}

function renderInterfaces(agent: LldpAgent, ifaces: readonly string[]): string {
  const w = new TextWriter();
  w.start('LLDP interfaces');
  for (const iface of ifaces) {
    if (!agent.isPortTransmitEnabled(iface) && !agent.isPortReceiveEnabled(iface)) continue;
    const self = agent.buildAdvertisement(iface);
    w.start('Interface');
    w.attr('', iface);
    w.attr('via', 'LLDP');
    writeChassis(w, self.chassisId, self.systemName, self.systemDescription,
      self.capabilities, self.managementAddresses);
    w.start('Port');
    w.start('PortID');
    w.attr('', 'ifname');
    w.data(self.portId);
    w.end();
    if (self.portDescription !== undefined) {
      w.start('PortDescr'); w.data(self.portDescription); w.end();
    }
    w.end();
    w.end();
  }
  return w.render();
}

function jsonNeighbor(agent: LldpAgent, iface: string, n: LldpNeighbor): unknown {
  return {
    name: iface,
    via: 'LLDP',
    rid: '1',
    age: ageSince(n.ttlSec, agent.ttlRemainingSec(n)),
    chassis: {
      id: { type: 'mac', value: n.chassisId },
      ...(n.systemName !== undefined ? { name: n.systemName } : {}),
      ...(n.systemDescription !== undefined ? { descr: n.systemDescription } : {}),
      ...(n.managementAddresses?.length ? { 'mgmt-ip': n.managementAddresses } : {}),
      capability: (n.remoteCapabilities ?? []).map(c => ({
        type: CAPABILITY_SYMBOL[c], enabled: true,
      })),
    },
    port: {
      id: { type: 'ifname', value: n.portId },
      ...(n.portDescription !== undefined ? { descr: n.portDescription } : {}),
    },
  };
}

function renderNeighborsJson(agent: LldpAgent, ifaces: readonly string[]): string {
  const interfaces = ifaces.flatMap(iface =>
    agent.getNeighborsOnPort(iface).map(n => jsonNeighbor(agent, iface, n)));
  return JSON.stringify({ lldp: { interface: interfaces } }, null, 2);
}

function runLldpcli(
  ctx: LinuxCommandContext, args: string[],
): { output: string; exitCode: number } {
  const agent = ctx.net.getLldpAgent();
  const running = ctx.executor.serviceMgr.isActive('lldpd');
  if (!running) {
    return {
      output: 'fatal: lldpctl: cannot connect to lldpd daemon\n'
        + 'fatal: lldpctl: is lldpd running?',
      exitCode: 1,
    };
  }
  let format = 'plain';
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-f' && args[i + 1] !== undefined) { format = args[i + 1]; i += 1; }
    else words.push(args[i]);
  }
  const ifaces = agent.manageablePorts().map(p => p.getName());
  if (words[0] !== 'show') {
    return { output: `lldpcli: unknown command ${words[0] ?? ''}`, exitCode: 1 };
  }
  const named = words.slice(2).filter(word => ifaces.includes(word));
  const scope = named.length > 0 ? named : ifaces;
  switch (words[1]) {
    case 'neighbors':
      return format === 'json'
        ? { output: renderNeighborsJson(agent, scope), exitCode: 0 }
        : { output: renderNeighbors(agent, scope), exitCode: 0 };
    case 'chassis':
      return { output: renderChassis(agent, ifaces[0] ?? ''), exitCode: 0 };
    case 'statistics':
      return { output: renderStatistics(agent, scope), exitCode: 0 };
    case 'interfaces':
      return { output: renderInterfaces(agent, scope), exitCode: 0 };
    default:
      return { output: `lldpcli: unknown command ${words.slice(1).join(' ')}`, exitCode: 1 };
  }
}

export const lldpcliCommand: LinuxCommand = {
  name: 'lldpcli',
  needsNetworkContext: true,
  usage: 'lldpcli [-f format] show {neighbors|chassis|statistics|interfaces} [ports <iface>]',
  manSection: 8,
  binaryPath: '/usr/sbin/lldpcli',
  options: LLDPCLI_OPTIONS,
  help: 'Control lldpd daemon.',
  run(ctx, args) { return runLldpcli(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runLldpcli(ctx, args); },
};
