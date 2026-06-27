export type MirrorDirection = 'rx' | 'tx' | 'both';

export interface MirrorSource {
  rx: boolean;
  tx: boolean;
}

export interface MirrorSession {
  id: number;
  sources: Map<string, MirrorSource>;
  destination: string | null;
}

function normalizeDirection(dir: MirrorDirection): { rx: boolean; tx: boolean } {
  return { rx: dir !== 'tx', tx: dir !== 'rx' };
}

function summarizeDirection(s: MirrorSource): MirrorDirection {
  if (s.rx && s.tx) return 'both';
  if (s.rx) return 'rx';
  return 'tx';
}

export class PortMirror {
  private readonly sessions = new Map<number, MirrorSession>();

  list(): MirrorSession[] {
    return [...this.sessions.values()].sort((a, b) => a.id - b.id);
  }

  get(id: number): MirrorSession | undefined { return this.sessions.get(id); }

  hasAny(): boolean { return this.sessions.size > 0; }

  private ensure(id: number): MirrorSession {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, sources: new Map(), destination: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  addSource(id: number, portName: string, dir: MirrorDirection): void {
    const session = this.ensure(id);
    const flags = normalizeDirection(dir);
    const existing = session.sources.get(portName);
    if (existing) {
      existing.rx = existing.rx || flags.rx;
      existing.tx = existing.tx || flags.tx;
    } else {
      session.sources.set(portName, flags);
    }
  }

  removeSource(id: number, portName: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    const removed = session.sources.delete(portName);
    if (session.sources.size === 0 && session.destination === null) {
      this.sessions.delete(id);
    }
    return removed;
  }

  setDestination(id: number, portName: string): void {
    const session = this.ensure(id);
    session.destination = portName;
  }

  clearDestination(id: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.destination === null) return false;
    session.destination = null;
    if (session.sources.size === 0) this.sessions.delete(id);
    return true;
  }

  removeSession(id: number): boolean {
    return this.sessions.delete(id);
  }

  removeAll(): void { this.sessions.clear(); }

  /**
   * All destination ports that should receive a copy of a frame seen on
   * `srcPort` in direction `dir`. Empty when no session matches.
   */
  destinationsFor(srcPort: string, dir: 'rx' | 'tx'): string[] {
    const out: string[] = [];
    for (const session of this.sessions.values()) {
      if (!session.destination) continue;
      const src = session.sources.get(srcPort);
      if (!src) continue;
      if (dir === 'rx' ? src.rx : src.tx) out.push(session.destination);
    }
    return out;
  }

  /** True if `portName` is the destination of any session. */
  isDestination(portName: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.destination === portName) return true;
    }
    return false;
  }

  format(): string {
    if (this.sessions.size === 0) return '';
    return this.list().map((s) => this.formatOne(s.id)).filter(Boolean).join('\n');
  }

  formatOne(id: number): string {
    const s = this.sessions.get(id);
    if (!s) return `% Session ${id} does not exist.`;
    const lines: string[] = [];
    lines.push(`Session ${s.id}`);
    lines.push('---------');
    lines.push('Type                   : Local Session');
    const sources = [...s.sources.entries()];
    const rx = sources.filter(([, v]) => v.rx).map(([p]) => p);
    const tx = sources.filter(([, v]) => v.tx).map(([p]) => p);
    lines.push(`Source Ports           :`);
    lines.push(`    RX Only            : ${this.fmtList(sources.filter(([, v]) => v.rx && !v.tx).map(([p]) => p))}`);
    lines.push(`    TX Only            : ${this.fmtList(sources.filter(([, v]) => v.tx && !v.rx).map(([p]) => p))}`);
    lines.push(`    Both               : ${this.fmtList(sources.filter(([, v]) => v.rx && v.tx).map(([p]) => p))}`);
    lines.push(`Destination Ports      : ${s.destination ?? 'None'}`);
    lines.push(`Ingress                : Disabled`);
    if (rx.length + tx.length === 0 && !s.destination) {
      lines.push('Status                 : Empty');
    }
    return lines.join('\n');
  }

  private fmtList(arr: readonly string[]): string {
    return arr.length === 0 ? 'None' : arr.join(',');
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    for (const s of this.list()) {
      const sources = [...s.sources.entries()];
      for (const [port, dir] of sources) {
        const verb = summarizeDirection(dir);
        lines.push(`monitor session ${s.id} source interface ${port}${verb === 'both' ? '' : ` ${verb}`}`);
      }
      if (s.destination) {
        lines.push(`monitor session ${s.id} destination interface ${s.destination}`);
      }
    }
    return lines;
  }
}
