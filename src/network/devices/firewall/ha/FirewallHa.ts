import type { EthernetFrame, MACAddress } from '../../../core/types';
import type { SessionTable } from '../session/SessionTable';
import { HaAgent } from './HaAgent';
import { exportSessions, importSessions } from './HaSessionSync';

export interface FirewallHaDeps {
  readonly serial: () => string;
  readonly now: () => number;
  readonly sendFrame: (iface: string, frame: EthernetFrame) => void;
  readonly interfaceMac: (iface: string) => MACAddress | undefined;
  readonly interfaceUp: (iface: string) => boolean;
  readonly sessions: () => SessionTable;
}

export class FirewallHa {
  readonly agent: HaAgent;
  private read?: () => string;
  private apply?: (text: string) => void;

  constructor(deps: FirewallHaDeps) {
    this.agent = new HaAgent({
      serial: deps.serial,
      now: deps.now,
      sendFrame: deps.sendFrame,
      interfaceMac: deps.interfaceMac,
      interfaceUp: deps.interfaceUp,
      configurationText: () => this.read?.() ?? '',
      applyConfiguration: (text) => { this.apply?.(text); },
      exportSessions: () => exportSessions(deps.sessions()),
      importSessions: (sessions) => { importSessions(deps.sessions(), sessions); },
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
