import { simulationNowMs } from '@/network/core/SystemClock';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export type OutgoingProtocol = 'telnet' | 'ssh';

export interface OutgoingSession {
  conn: number;
  host: string;
  address: string;
  protocol: OutgoingProtocol;
  user: string;
  openedAtMs: number;
  lastActiveMs: number;
  bytes: number;
  socket?: { close(): void };
}

export class OutgoingSessionRegistry {
  private readonly sessions = new Map<number, OutgoingSession>();
  private seq = 0;

  open(args: { host: string; address: string; protocol: OutgoingProtocol; user: string; socket?: { close(): void } }): OutgoingSession {
    const now = simulationNowMs();
    this.seq += 1;
    const session: OutgoingSession = {
      conn: this.seq,
      host: args.host,
      address: args.address,
      protocol: args.protocol,
      user: args.user,
      openedAtMs: now,
      lastActiveMs: now,
      bytes: 0,
      ...(args.socket === undefined ? {} : { socket: args.socket }),
    };
    this.sessions.set(session.conn, session);
    return session;
  }

  list(): OutgoingSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => a.conn - b.conn);
  }

  get(conn: number): OutgoingSession | undefined {
    return this.sessions.get(conn);
  }

  touch(conn: number, bytes = 0): void {
    const s = this.sessions.get(conn);
    if (s) { s.lastActiveMs = simulationNowMs(); s.bytes += bytes; }
  }

  close(conn: number): boolean {
    this.sessions.get(conn)?.socket?.close();
    return this.sessions.delete(conn);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.socket?.close();
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

function idle(ms: number): string {
  const sec = Math.max(0, Math.floor((simulationNowMs() - ms) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function renderSessions(reg: OutgoingSessionRegistry): string {
  const list = reg.list();
  if (list.length === 0) return '% No connections open';
  const lines = ['Conn Host                Address             Byte  Idle Conn Name'];
  const active = list[list.length - 1].conn;
  for (const s of list) {
    const star = s.conn === active ? '*' : ' ';
    lines.push(
      `${star}${padToWidth(String(s.conn), 3, 'right')} ${padToWidth(s.host, 19)} ` +
      `${padToWidth(s.address, 19)} ${padToWidth(String(s.bytes), 4, 'right')} ` +
      `${padToWidth(idle(s.lastActiveMs), 5, 'right')} ${s.host}`,
    );
  }
  return lines.join('\n');
}
