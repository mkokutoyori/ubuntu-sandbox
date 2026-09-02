import type { EthernetFrame, MACAddress } from '../../../core/types';
import type { SessionTable } from '../session/SessionTable';
import { HaAgent } from './HaAgent';
import { exportSessions, importSessions } from './HaSessionSync';

export interface FirewallHaDeps {
  readonly serial: () => string;
  readonly hostname: () => string;
  readonly now: () => number;
  readonly sendFrame: (iface: string, frame: EthernetFrame) => void;
  readonly interfaceMac: (iface: string) => MACAddress | undefined;
  readonly interfaceUp: (iface: string) => boolean;
  readonly sessions: () => SessionTable;
  readonly authenticateAdmin: (admin: string, secret: string) => boolean;
  readonly runCommand: (admin: string, line: string) => string;
  readonly leaveCluster: (iface: string, ip: string, mask: string) => string;
  readonly setDevicePriority: (priority: number) => string;
}

export class FirewallHa {
  readonly agent: HaAgent;
  private read?: () => string;
  private apply?: (text: string) => void;

  constructor(deps: FirewallHaDeps) {
    this.agent = new HaAgent({
      serial: deps.serial,
      hostname: deps.hostname,
      now: deps.now,
      sendFrame: deps.sendFrame,
      interfaceMac: deps.interfaceMac,
      interfaceUp: deps.interfaceUp,
      configurationText: () => this.read?.() ?? '',
      applyConfiguration: (text) => { this.apply?.(text); },
      exportSessions: () => exportSessions(deps.sessions()),
      importSessions: (sessions) => { importSessions(deps.sessions(), sessions); },
      authenticateAdmin: deps.authenticateAdmin,
      runCommand: deps.runCommand,
      leaveCluster: deps.leaveCluster,
      setDevicePriority: deps.setDevicePriority,
    });
  }

  bindConfiguration(read: () => string, apply: (text: string) => void): void {
    this.read = read;
    this.apply = apply;
  }
}

export function serialNumberOf(name: string): string {
  const digits = name.split('').reduce(
    (total, letter) => (total * 31 + letter.charCodeAt(0)) % 100000000, 7);
  return `FGVMEV${String(digits).padStart(10, '0')}`;
}

export interface HaWiringHost {
  serial(): string;
  hostname(): string;
  now(): number;
  sendFrame(iface: string, frame: EthernetFrame): void;
  port(iface: string): {
    getMAC(): MACAddress;
    isConnected(): boolean;
    isOperationallyUp(): boolean;
  } | undefined;
  sessions(): SessionTable;
  authenticateAdmin(admin: string, secret: string): boolean;
  runManagementCommand(admin: string, line: string): string;
  leaveCluster(iface: string, ip: string, mask: string): string;
  setDevicePriority(priority: number): string;
}

export function buildFirewallHa(host: HaWiringHost): FirewallHa {
  return new FirewallHa({
    serial: () => host.serial(),
    hostname: () => host.hostname(),
    now: () => host.now(),
    sendFrame: (iface, frame) => { host.sendFrame(iface, frame); },
    interfaceMac: (iface) => host.port(iface)?.getMAC(),
    interfaceUp: (iface) => {
      const port = host.port(iface);
      return port !== undefined && port.isConnected() && port.isOperationallyUp();
    },
    sessions: () => host.sessions(),
    authenticateAdmin: (admin, secret) => host.authenticateAdmin(admin, secret),
    runCommand: (admin, line) => host.runManagementCommand(admin, line),
    leaveCluster: (iface, ip, mask) => host.leaveCluster(iface, ip, mask),
    setDevicePriority: (priority) => host.setDevicePriority(priority),
  });
}
