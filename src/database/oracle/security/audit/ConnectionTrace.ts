/**
 * ConnectionTrace — concrete implementation of `IConnectionTrace`.
 *
 * Holds every attribute Oracle exposes through DBA_AUDIT_SESSION /
 * V$SESSION_CONNECT_INFO at logon time, plus extra forensic fields
 * (offHours flag, network protocol, derived role). Attributes the
 * simulator does not animate yet are kept as real Oracle defaults so
 * downstream consumers see truthful values.
 */

import type { IConnectionTrace, ConnectionOutcome } from './interfaces';

export interface ConnectionTraceInit {
  traceId: number;
  username: string;
  sessionId: number;
  serial: number;
  osUser: string;
  userhost: string;
  terminal: string;
  program: string;
  ipAddress: string;
  networkProtocol: string;
  authenticationMethod: string;
  authenticationType: string;
  role: 'NORMAL' | 'SYSDBA' | 'SYSOPER';
  outcome: ConnectionOutcome;
  returncode: number;
  offHours: boolean;
  timestamp?: Date;
}

export class ConnectionTrace implements IConnectionTrace {
  readonly traceId: number;
  readonly timestamp: Date;
  readonly username: string;
  readonly sessionId: number;
  readonly serial: number;
  readonly osUser: string;
  readonly userhost: string;
  readonly terminal: string;
  readonly program: string;
  readonly ipAddress: string;
  readonly networkProtocol: string;
  readonly authenticationMethod: string;
  readonly authenticationType: string;
  readonly role: 'NORMAL' | 'SYSDBA' | 'SYSOPER';
  readonly outcome: ConnectionOutcome;
  readonly returncode: number;
  readonly offHours: boolean;

  /** Logoff timestamp — set later when the matching disconnect lands. */
  logoffAt: Date | null = null;
  /** Seconds the session stayed open. Computed when logoffAt is set. */
  durationSeconds: number = 0;
  /** Bytes received / sent — placeholder for future TNS-layer accounting. */
  bytesReceived: number = 0;
  bytesSent: number = 0;

  constructor(init: ConnectionTraceInit) {
    this.traceId = init.traceId;
    this.timestamp = init.timestamp ?? new Date();
    this.username = init.username.toUpperCase();
    this.sessionId = init.sessionId;
    this.serial = init.serial;
    this.osUser = init.osUser;
    this.userhost = init.userhost;
    this.terminal = init.terminal;
    this.program = init.program;
    this.ipAddress = init.ipAddress;
    this.networkProtocol = init.networkProtocol;
    this.authenticationMethod = init.authenticationMethod;
    this.authenticationType = init.authenticationType;
    this.role = init.role;
    this.outcome = init.outcome;
    this.returncode = init.returncode;
    this.offHours = init.offHours;
  }

  /** Stamp a logoff timestamp and compute the elapsed duration in seconds. */
  closeAt(logoffAt: Date): void {
    this.logoffAt = logoffAt;
    this.durationSeconds = Math.max(
      0,
      Math.floor((logoffAt.getTime() - this.timestamp.getTime()) / 1000),
    );
  }
}
