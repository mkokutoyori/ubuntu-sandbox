import type { SshAuthMethod } from '../../../devices/router/aaa/NetworkOsAccount';

export interface SshPortForwardSpec {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
}

export interface SshForwardingRequest {
  readonly agent: boolean;
  readonly x11: boolean;
  readonly locals: readonly SshPortForwardSpec[];
  readonly remotes: readonly SshPortForwardSpec[];
  readonly dynamics: readonly { listenHost: string; listenPort: number }[];
}

export interface SshPtyRequest {
  readonly termType: string;
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth?: number;
  readonly pixelHeight?: number;
  readonly modes?: ReadonlyMap<string, number>;
}

export interface SshConnectionRequestSnapshot {
  readonly requestedUser: string;
  readonly requestedHost: string;
  readonly requestedPort: number;
  readonly sourceIp: string;
  readonly sourcePort: number;
  readonly sourceHostname: string;
  readonly clientVersion: string;
  readonly offeredAuthMethods: readonly SshAuthMethod[];
  readonly offeredCiphers: readonly string[];
  readonly offeredMacs: readonly string[];
  readonly offeredKex: readonly string[];
  readonly offeredHostKeyAlgorithms: readonly string[];
  readonly offeredCompression: readonly string[];
  readonly sentEnv: Readonly<Record<string, string>>;
  readonly pty: SshPtyRequest | null;
  readonly forwarding: SshForwardingRequest;
  readonly requestedSubsystem: string | null;
  readonly command: string | null;
  readonly receivedAt: number;
}

export class SshConnectionRequest implements SshConnectionRequestSnapshot {
  readonly requestedUser: string;
  readonly requestedHost: string;
  readonly requestedPort: number;
  readonly sourceIp: string;
  readonly sourcePort: number;
  readonly sourceHostname: string;
  readonly clientVersion: string;
  readonly offeredAuthMethods: readonly SshAuthMethod[];
  readonly offeredCiphers: readonly string[];
  readonly offeredMacs: readonly string[];
  readonly offeredKex: readonly string[];
  readonly offeredHostKeyAlgorithms: readonly string[];
  readonly offeredCompression: readonly string[];
  readonly sentEnv: Readonly<Record<string, string>>;
  readonly pty: SshPtyRequest | null;
  readonly forwarding: SshForwardingRequest;
  readonly requestedSubsystem: string | null;
  readonly command: string | null;
  readonly receivedAt: number;

  private constructor(s: SshConnectionRequestSnapshot) {
    this.requestedUser = s.requestedUser;
    this.requestedHost = s.requestedHost;
    this.requestedPort = s.requestedPort;
    this.sourceIp = s.sourceIp;
    this.sourcePort = s.sourcePort;
    this.sourceHostname = s.sourceHostname;
    this.clientVersion = s.clientVersion;
    this.offeredAuthMethods = s.offeredAuthMethods;
    this.offeredCiphers = s.offeredCiphers;
    this.offeredMacs = s.offeredMacs;
    this.offeredKex = s.offeredKex;
    this.offeredHostKeyAlgorithms = s.offeredHostKeyAlgorithms;
    this.offeredCompression = s.offeredCompression;
    this.sentEnv = s.sentEnv;
    this.pty = s.pty;
    this.forwarding = s.forwarding;
    this.requestedSubsystem = s.requestedSubsystem;
    this.command = s.command;
    this.receivedAt = s.receivedAt;
  }

  static create(init: {
    requestedUser: string; requestedHost: string; requestedPort: number;
    sourceIp: string; sourcePort: number; sourceHostname: string;
    clientVersion: string;
    offeredAuthMethods: SshAuthMethod[]; offeredCiphers: string[]; offeredMacs: string[];
    offeredKex: string[]; offeredHostKeyAlgorithms: string[]; offeredCompression: string[];
    sentEnv: Record<string, string>;
    pty: SshPtyRequest | null;
    forwarding: SshForwardingRequest;
    requestedSubsystem: string | null;
    command: string | null;
    now: number;
  }): SshConnectionRequest {
    return new SshConnectionRequest({
      requestedUser: init.requestedUser,
      requestedHost: init.requestedHost,
      requestedPort: init.requestedPort,
      sourceIp: init.sourceIp,
      sourcePort: init.sourcePort,
      sourceHostname: init.sourceHostname,
      clientVersion: init.clientVersion,
      offeredAuthMethods: Object.freeze([...init.offeredAuthMethods]),
      offeredCiphers: Object.freeze([...init.offeredCiphers]),
      offeredMacs: Object.freeze([...init.offeredMacs]),
      offeredKex: Object.freeze([...init.offeredKex]),
      offeredHostKeyAlgorithms: Object.freeze([...init.offeredHostKeyAlgorithms]),
      offeredCompression: Object.freeze([...init.offeredCompression]),
      sentEnv: Object.freeze({ ...init.sentEnv }),
      pty: init.pty,
      forwarding: init.forwarding,
      requestedSubsystem: init.requestedSubsystem,
      command: init.command,
      receivedAt: init.now,
    });
  }

  isExecMode(): boolean { return this.command !== null && this.requestedSubsystem === null; }
  isInteractive(): boolean { return this.command === null && this.requestedSubsystem === null; }
  isSubsystem(): boolean { return this.requestedSubsystem !== null; }
  hasPty(): boolean { return this.pty !== null; }
  hasForwarding(): boolean {
    return this.forwarding.agent || this.forwarding.x11
      || this.forwarding.locals.length > 0
      || this.forwarding.remotes.length > 0
      || this.forwarding.dynamics.length > 0;
  }
}

export type SshConnectionOutcome = 'accepted' | 'rejected' | 'dropped';

export interface SshConnectionDecisionSnapshot {
  readonly outcome: SshConnectionOutcome;
  readonly method: SshAuthMethod | null;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly at: number;
}

export class SshConnectionDecision implements SshConnectionDecisionSnapshot {
  readonly outcome: SshConnectionOutcome;
  readonly method: SshAuthMethod | null;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly at: number;

  private constructor(s: SshConnectionDecisionSnapshot) {
    this.outcome = s.outcome;
    this.method = s.method;
    this.reason = s.reason;
    this.sessionId = s.sessionId;
    this.at = s.at;
  }

  get ok(): boolean { return this.outcome === 'accepted'; }

  static accept(method: SshAuthMethod, init: { sessionId: string; at?: number } = { sessionId: '' }): SshConnectionDecision {
    return new SshConnectionDecision({
      outcome: 'accepted',
      method,
      reason: null,
      sessionId: init.sessionId,
      at: init.at ?? Date.now(),
    });
  }

  static reject(reason: string, at: number = Date.now()): SshConnectionDecision {
    return new SshConnectionDecision({
      outcome: 'rejected', method: null, reason, sessionId: null, at,
    });
  }

  static drop(reason: string, at: number = Date.now()): SshConnectionDecision {
    return new SshConnectionDecision({
      outcome: 'dropped', method: null, reason, sessionId: null, at,
    });
  }
}
