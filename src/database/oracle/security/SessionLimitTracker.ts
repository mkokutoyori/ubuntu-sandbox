/**
 * SessionLimitTracker — Track active sessions per user for SESSIONS_PER_USER enforcement.
 *
 * Also tracks session metadata (terminal, program, hostname) for V$SESSION.
 */

import type { OsSecurityContext } from './types';

export type SessionStatus = 'ACTIVE' | 'INACTIVE' | 'KILLED' | 'SNIPED' | 'CACHED';

export const SESSION_KILLED = { code: 28, message: 'your session has been killed' };
export const SESSION_IDLE_SNIPED = {
  code: 2396, message: 'exceeded maximum idle time, please connect again',
};
export const SESSION_CONNECT_TIME_EXCEEDED = {
  code: 2399, message: 'exceeded maximum connect time, you are being logged off',
};

export interface ActiveSessionInfo {
  sessionId: string;
  sid: number;
  serial: number;
  username: string;
  schema: string;
  osUser: string;
  machine: string;
  /** Client's real IPv4 for TCP (Oracle Net) sessions; null for bequeath. */
  clientIp: string | null;
  terminal: string;
  program: string;
  logonTime: Date;
  status: SessionStatus;
  lastCallAt: Date;
  terminationError: { code: number; message: string } | null;
  type: 'USER' | 'BACKGROUND';
  lastCallEt: number; // seconds since last call
  sqlId: string | null;
  sqlExecStart: Date | null;
  sqlChildNumber: number | null;
  blockingSession: number | null;
  event: string;
  waitClass: string;
  secondsInWait: number;
  state: 'WAITING' | 'WAITED SHORT TIME' | 'WAITED KNOWN TIME' | 'WAITED UNKNOWN TIME';
  service: string;
  module: string | null;
  action: string | null;
  clientInfo: string | null;
  resourceConsumerGroup: string;
}

export class SessionLimitTracker {
  private sessions = new Map<string, ActiveSessionInfo>();
  private nextSid = 10;
  private nextSerial = 100;

  // ── Session lifecycle ─────────────────────────────────────────────

  registerSession(
    sessionId: string,
    username: string,
    schema: string,
    osCtx: OsSecurityContext,
    type: 'USER' | 'BACKGROUND' = 'USER',
    overrideSid?: number,
    overrideSerial?: number,
  ): ActiveSessionInfo {
    const numericId = parseInt(sessionId, 10);
    const resolvedSid = overrideSid ?? (!isNaN(numericId) ? numericId : this.nextSid++);
    const resolvedSerial = overrideSerial ?? this.nextSerial++;
    const info: ActiveSessionInfo = {
      sessionId,
      sid: resolvedSid,
      serial: resolvedSerial,
      username: username.toUpperCase(),
      schema: schema.toUpperCase(),
      osUser: osCtx.osUser,
      machine: osCtx.hostname,
      clientIp: osCtx.clientIp ?? null,
      terminal: osCtx.terminal,
      program: osCtx.program,
      logonTime: new Date(),
      status: 'ACTIVE',
      type,
      lastCallEt: 0,
      lastCallAt: new Date(),
      terminationError: null,
      sqlId: null,
      sqlExecStart: null,
      sqlChildNumber: null,
      blockingSession: null,
      event: 'SQL*Net message from client',
      waitClass: 'Idle',
      secondsInWait: 0,
      state: 'WAITING',
      service: 'orcl',
      module: null,
      action: null,
      clientInfo: null,
      resourceConsumerGroup: 'DEFAULT_CONSUMER_GROUP',
    };
    this.sessions.set(sessionId, info);
    return info;
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): ActiveSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  updateSqlContext(sessionId: string, sqlId: string | null, sqlText: string | null): void {
    const info = this.sessions.get(sessionId);
    if (!info) return;
    info.sqlId = sqlId;
    info.sqlExecStart = sqlId ? new Date() : null;
    info.sqlChildNumber = sqlId ? 0 : null;
    info.lastCallEt = 0;
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    const info = this.sessions.get(sessionId);
    if (info) info.status = status;
  }

  noteCall(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (!info) return;
    info.lastCallAt = new Date();
    info.lastCallEt = 0;
  }

  idleSeconds(info: ActiveSessionInfo, now: Date = new Date()): number {
    return Math.max(info.lastCallEt,
      Math.floor((now.getTime() - info.lastCallAt.getTime()) / 1000));
  }

  connectedSeconds(info: ActiveSessionInfo, now: Date = new Date()): number {
    return Math.floor((now.getTime() - info.logonTime.getTime()) / 1000);
  }

  terminate(
    sid: number, serial: number | null,
    status: 'KILLED' | 'SNIPED', error: { code: number; message: string },
  ): ActiveSessionInfo | null {
    for (const info of this.sessions.values()) {
      if (info.sid !== sid) continue;
      if (serial !== null && info.serial !== serial) continue;
      info.status = status;
      info.terminationError = error;
      return info;
    }
    return null;
  }

  pendingTermination(sid: number): ActiveSessionInfo | null {
    for (const info of this.sessions.values()) {
      if (info.sid === sid && info.terminationError !== null) return info;
    }
    return null;
  }

  // ── Session counting ──────────────────────────────────────────────

  /** Count active USER sessions for a specific user. */
  countUserSessions(username: string): number {
    const upper = username.toUpperCase();
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.username === upper && s.type === 'USER' && s.terminationError === null) count++;
    }
    return count;
  }

  getAllSessions(): ActiveSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getSessionBySid(sid: number): ActiveSessionInfo | undefined {
    for (const s of this.sessions.values()) {
      if (s.sid === sid) return s;
    }
    return undefined;
  }

  getSessionBySerial(sid: number, serial: number): ActiveSessionInfo | undefined {
    for (const s of this.sessions.values()) {
      if (s.sid === sid && s.serial === serial) return s;
    }
    return undefined;
  }

  killSession(sid: number, serial: number): boolean {
    return this.terminate(sid, serial, 'KILLED', SESSION_KILLED) !== null;
  }

  killBySid(sid: number): boolean {
    for (const [key, s] of this.sessions.entries()) {
      if (s.sid === sid) {
        this.sessions.delete(key);
        return true;
      }
    }
    return false;
  }

  /** Kill all sessions for a user (used when locking / dropping user). Returns the killed SIDs. */
  killUserSessions(username: string): number[] {
    const upper = username.toUpperCase();
    const killed: number[] = [];
    for (const [key, s] of this.sessions.entries()) {
      if (s.username === upper && s.type === 'USER') {
        killed.push(s.sid);
        this.sessions.delete(key);
      }
    }
    return killed;
  }
}
