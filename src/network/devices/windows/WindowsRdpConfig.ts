import { RdpSessionTable } from './server/rdp/RdpSession';

export const TERMINAL_SERVER_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server';
export const DENY_CONNECTIONS_VALUE = 'fDenyTSConnections';

export interface RdpRegistry {
  getItemPropertyValues(path: string): Record<string, string | number> | null;
  setItemProperty(path: string, name: string, value: string | number): string;
}

export class WindowsRdpConfig {
  readonly sessions = new RdpSessionTable();

  constructor(private readonly registry: RdpRegistry) {}

  get enabled(): boolean {
    const values = this.registry.getItemPropertyValues(TERMINAL_SERVER_KEY);
    if (!values) return false;
    const wanted = DENY_CONNECTIONS_VALUE.toLowerCase();
    for (const [name, value] of Object.entries(values)) {
      if (name.toLowerCase() === wanted) return String(value).trim() !== '' && Number(value) === 0;
    }
    return false;
  }

  enable(): void { this.registry.setItemProperty(TERMINAL_SERVER_KEY, DENY_CONNECTIONS_VALUE, 0); }

  disable(): void { this.registry.setItemProperty(TERMINAL_SERVER_KEY, DENY_CONNECTIONS_VALUE, 1); }
}
