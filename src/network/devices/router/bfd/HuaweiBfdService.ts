export interface BfdSession {
  name: string;
  peerIp?: string;
  sourceIp?: string;
  outIface?: string;
  auto?: boolean;
  discriminatorLocal?: number;
  discriminatorRemote?: number;
  minTxIntervalMs?: number;
  minRxIntervalMs?: number;
  detectMultiplier?: number;
  oneArmEcho?: boolean;
  state: 'Down' | 'Init' | 'Up' | 'AdminDown';
}

export class HuaweiBfdService {
  private enabled = false;
  private readonly sessions: Map<string, BfdSession> = new Map();

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  ensureSession(name: string): BfdSession {
    let s = this.sessions.get(name);
    if (!s) { s = { name, state: 'Down' }; this.sessions.set(name, s); this.enabled = true; }
    return s;
  }
  removeSession(name: string): boolean { return this.sessions.delete(name); }
  getSession(name: string): BfdSession | undefined { return this.sessions.get(name); }
  list(): readonly BfdSession[] { return [...this.sessions.values()]; }

  asRunningConfigLines(): string[] {
    if (!this.enabled && this.sessions.size === 0) return [];
    const lines: string[] = ['bfd'];
    for (const s of this.sessions.values()) {
      let header = `bfd ${s.name} bind peer-ip ${s.peerIp ?? '0.0.0.0'}`;
      if (s.sourceIp) header += ` source-ip ${s.sourceIp}`;
      if (s.auto) header += ' auto';
      if (s.outIface) header += ` interface ${s.outIface}`;
      lines.push(header);
      if (s.discriminatorLocal !== undefined) lines.push(` discriminator local ${s.discriminatorLocal}`);
      if (s.discriminatorRemote !== undefined) lines.push(` discriminator remote ${s.discriminatorRemote}`);
      if (s.minTxIntervalMs !== undefined) lines.push(` min-tx-interval ${s.minTxIntervalMs}`);
      if (s.minRxIntervalMs !== undefined) lines.push(` min-rx-interval ${s.minRxIntervalMs}`);
      if (s.detectMultiplier !== undefined) lines.push(` detect-multiplier ${s.detectMultiplier}`);
      if (s.oneArmEcho) lines.push(' one-arm-echo');
    }
    return lines;
  }
}
