export interface SessionTtlPort {
  readonly id: string;
  readonly protocol: number;
  readonly startPort: number;
  readonly endPort: number;
  readonly timeoutSec: number;
}

export const SESSION_TTL_DEFAULT_SEC = 3600;
export const SESSION_TTL_PORT_DEFAULT_SEC = 300;

export class SessionTtlTable {
  private defaultSec = SESSION_TTL_DEFAULT_SEC;
  private readonly ports = new Map<string, SessionTtlPort>();

  setDefault(seconds: number): void { this.defaultSec = seconds; }

  getDefault(): number { return this.defaultSec; }

  upsertPort(entry: SessionTtlPort): void { this.ports.set(entry.id, entry); }

  removePort(id: string): boolean { return this.ports.delete(id); }

  list(): readonly SessionTtlPort[] { return Object.freeze([...this.ports.values()]); }

  timeoutFor(protocol: number, destinationPort: number): number | undefined {
    for (const entry of this.ports.values()) {
      if (entry.protocol !== 0 && entry.protocol !== protocol) continue;
      if (destinationPort < entry.startPort || destinationPort > entry.endPort) continue;
      return entry.timeoutSec;
    }
    return undefined;
  }
}
