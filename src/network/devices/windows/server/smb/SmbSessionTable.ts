/**
 * SmbSessionTable — live inbound SMB sessions on THIS device, backing
 * `Get-SmbSession` / `net session` (PRD-Windows-Server.md §5 P3).
 *
 * Instance-owned. A fresh `SmbServerHandler` is constructed per accepted
 * TCP connection (mirroring `WindowsPC.getSshServerHandler()`), so the
 * session registry that must survive across connections lives here
 * instead, shared via `WindowsPC.smbSessions`.
 */

import type { SmbSessionEntry, SmbSessionView } from './SmbTypes';

export class SmbSessionTable {
  private readonly sessions = new Map<number, SmbSessionEntry>();
  private nextId = 1;

  open(clientComputerName: string, clientIp: string, user: string, nowMs: number): number {
    const id = this.nextId++;
    this.sessions.set(id, {
      id, clientComputerName, clientIp, user,
      shares: new Set(), connectedAtMs: nowMs, numOpens: 0,
    });
    return id;
  }

  addShare(id: number, shareName: string): void {
    this.sessions.get(id)?.shares.add(shareName);
  }

  removeShare(id: number, shareName: string): void {
    this.sessions.get(id)?.shares.delete(shareName);
  }

  recordOpen(id: number): void {
    const s = this.sessions.get(id);
    if (s) s.numOpens += 1;
  }

  close(id: number): void {
    this.sessions.delete(id);
  }

  list(): SmbSessionEntry[] {
    return [...this.sessions.values()];
  }

  toView(s: SmbSessionEntry): SmbSessionView {
    return {
      id: s.id, clientComputerName: s.clientComputerName, clientIp: s.clientIp,
      user: s.user, shares: [...s.shares], numOpens: s.numOpens,
    };
  }
}
