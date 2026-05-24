/**
 * SshSshdConfig — pure parser/serializer for /etc/ssh/sshd_config.
 *
 * Covers the directives required by BRD SSH-07-R4/R5 plus the realism
 * additions:
 *   - Original: Port, MaxAuthTries, PermitRootLogin, PasswordAuthentication,
 *               PubkeyAuthentication, AllowUsers, Banner.
 *   - Added:    PermitEmptyPasswords, LoginGraceTime, ClientAliveInterval,
 *               ClientAliveCountMax, MaxSessions, LogLevel, SyslogFacility,
 *               KbdInteractiveAuthentication, X11Forwarding, AllowTcpForwarding,
 *               DenyUsers, AllowGroups, DenyGroups.
 *
 * Reference: man 5 sshd_config — Ubuntu defaults.
 */

import type { SshServerConfig } from './ISshServerContext';

export type SshLogLevel =
  | 'QUIET'
  | 'FATAL'
  | 'ERROR'
  | 'INFO'
  | 'VERBOSE'
  | 'DEBUG'
  | 'DEBUG1'
  | 'DEBUG2'
  | 'DEBUG3';

export type TcpForwardingValue = 'yes' | 'no' | 'local' | 'remote' | 'all';

export interface SshdConfig extends SshServerConfig {
  readonly allowUsers: readonly string[];
  readonly denyUsers: readonly string[];
  readonly allowGroups: readonly string[];
  readonly denyGroups: readonly string[];
  readonly banner: string | null;
  readonly permitEmptyPasswords: boolean;
  /** Seconds the client has to authenticate. 0 disables the grace timer. */
  readonly loginGraceTime: number;
  /** Seconds between keepalive probes. 0 disables. */
  readonly clientAliveInterval: number;
  /** Unanswered probes before the connection is dropped. */
  readonly clientAliveCountMax: number;
  /** Max simultaneous sessions per network connection. */
  readonly maxSessions: number;
  readonly logLevel: SshLogLevel;
  readonly syslogFacility: string;
  readonly kbdInteractiveAuthentication: boolean;
  readonly x11Forwarding: boolean;
  readonly allowTcpForwarding: TcpForwardingValue;
  /** PermitUserEnvironment yes — let ~/.ssh/environment overlay the shell. */
  readonly permitUserEnvironment: boolean;
}

export const DEFAULT_SSHD_CONFIG: SshdConfig = Object.freeze({
  listenPort: 22,
  maxAuthTries: 6,
  permitRootLogin: false,
  passwordAuthentication: true,
  pubkeyAuthentication: true,
  allowUsers: Object.freeze([]),
  denyUsers: Object.freeze([]),
  allowGroups: Object.freeze([]),
  denyGroups: Object.freeze([]),
  banner: null,
  permitEmptyPasswords: false,
  loginGraceTime: 120,
  clientAliveInterval: 0,
  clientAliveCountMax: 3,
  maxSessions: 10,
  logLevel: 'INFO' as SshLogLevel,
  syslogFacility: 'AUTH',
  kbdInteractiveAuthentication: false,
  x11Forwarding: false,
  allowTcpForwarding: 'yes' as TcpForwardingValue,
  permitUserEnvironment: false,
});

const LOG_LEVELS: readonly SshLogLevel[] = [
  'QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE',
  'DEBUG', 'DEBUG1', 'DEBUG2', 'DEBUG3',
];
const TCP_FWD_VALUES: readonly TcpForwardingValue[] = [
  'yes', 'no', 'local', 'remote', 'all',
];

const DIRECTIVE_PARSERS: Record<string, (value: string) => Partial<SshdConfig>> = {
  port: (v) => ({ listenPort: Number.parseInt(v, 10) }),
  maxauthtries: (v) => ({ maxAuthTries: Number.parseInt(v, 10) }),
  permitrootlogin: (v) => ({ permitRootLogin: parseBool(v) }),
  passwordauthentication: (v) => ({ passwordAuthentication: parseBool(v) }),
  pubkeyauthentication: (v) => ({ pubkeyAuthentication: parseBool(v) }),
  allowusers: (v) => ({ allowUsers: splitList(v) }),
  denyusers: (v) => ({ denyUsers: splitList(v) }),
  allowgroups: (v) => ({ allowGroups: splitList(v) }),
  denygroups: (v) => ({ denyGroups: splitList(v) }),
  banner: (v) => ({ banner: v.trim() === 'none' ? null : v.trim() }),
  permitemptypasswords: (v) => ({ permitEmptyPasswords: parseBool(v) }),
  logingracetime: (v) => ({ loginGraceTime: parseSeconds(v) }),
  clientaliveinterval: (v) => ({ clientAliveInterval: parseSeconds(v) }),
  clientalivecountmax: (v) => ({ clientAliveCountMax: Number.parseInt(v, 10) }),
  maxsessions: (v) => ({ maxSessions: Number.parseInt(v, 10) }),
  loglevel: (v) => {
    const upper = v.trim().toUpperCase();
    if (LOG_LEVELS.includes(upper as SshLogLevel)) {
      return { logLevel: upper as SshLogLevel };
    }
    return {};
  },
  syslogfacility: (v) => ({ syslogFacility: v.trim().toUpperCase() }),
  kbdinteractiveauthentication: (v) => ({ kbdInteractiveAuthentication: parseBool(v) }),
  x11forwarding: (v) => ({ x11Forwarding: parseBool(v) }),
  allowtcpforwarding: (v) => {
    const lower = v.trim().toLowerCase();
    if (TCP_FWD_VALUES.includes(lower as TcpForwardingValue)) {
      return { allowTcpForwarding: lower as TcpForwardingValue };
    }
    // OpenSSH treats yes/no booleans as the corresponding string.
    return { allowTcpForwarding: parseBool(v) ? 'yes' : 'no' };
  },
};

export function parseSshdConfig(content: string): SshdConfig {
  const cfg: Partial<SshdConfig> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.search(/\s/);
    if (idx === -1) continue;
    const key = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).trim();
    const parser = DIRECTIVE_PARSERS[key];
    if (parser) Object.assign(cfg, parser(value));
  }
  return Object.freeze({ ...DEFAULT_SSHD_CONFIG, ...cfg });
}

/** Outcome of an `sshd -t` style configuration test. */
export interface SshdConfigValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate /etc/ssh/sshd_config the way `sshd -t` does before a reload.
 *
 * Unknown directives are tolerated (the simulator's parser silently ignores
 * directives it does not model, and tests legitimately append things like
 * `AcceptEnv`). Only directives we *do* model are range-checked, so a reload
 * is rejected solely for values real sshd would also refuse.
 */
export function validateSshdConfig(
  content: string,
  path = '/etc/ssh/sshd_config',
): SshdConfigValidation {
  const errors: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.search(/\s/);
    if (idx === -1) continue;
    const key = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'port') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        errors.push(
          `${path} line ${i + 1}: Bad configuration option: invalid port number "${value}" — out of range 1..65535.`,
        );
      }
    } else if (key === 'maxauthtries' || key === 'maxsessions') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        errors.push(
          `${path} line ${i + 1}: Bad configuration option: invalid ${key} value "${value}".`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function serializeSshdConfig(cfg: SshdConfig): string {
  const lines = [
    `Port ${cfg.listenPort}`,
    `LogLevel ${cfg.logLevel}`,
    `SyslogFacility ${cfg.syslogFacility}`,
    `LoginGraceTime ${cfg.loginGraceTime}`,
    `MaxAuthTries ${cfg.maxAuthTries}`,
    `MaxSessions ${cfg.maxSessions}`,
    `PermitRootLogin ${cfg.permitRootLogin ? 'yes' : 'no'}`,
    `PasswordAuthentication ${cfg.passwordAuthentication ? 'yes' : 'no'}`,
    `PubkeyAuthentication ${cfg.pubkeyAuthentication ? 'yes' : 'no'}`,
    `PermitEmptyPasswords ${cfg.permitEmptyPasswords ? 'yes' : 'no'}`,
    `KbdInteractiveAuthentication ${cfg.kbdInteractiveAuthentication ? 'yes' : 'no'}`,
    `ClientAliveInterval ${cfg.clientAliveInterval}`,
    `ClientAliveCountMax ${cfg.clientAliveCountMax}`,
    `X11Forwarding ${cfg.x11Forwarding ? 'yes' : 'no'}`,
    `AllowTcpForwarding ${cfg.allowTcpForwarding}`,
    `PermitUserEnvironment ${cfg.permitUserEnvironment ? 'yes' : 'no'}`,
  ];
  if (cfg.allowUsers.length > 0) lines.push(`AllowUsers ${cfg.allowUsers.join(' ')}`);
  if (cfg.denyUsers.length > 0) lines.push(`DenyUsers ${cfg.denyUsers.join(' ')}`);
  if (cfg.allowGroups.length > 0) lines.push(`AllowGroups ${cfg.allowGroups.join(' ')}`);
  if (cfg.denyGroups.length > 0) lines.push(`DenyGroups ${cfg.denyGroups.join(' ')}`);
  if (cfg.banner) lines.push(`Banner ${cfg.banner}`);
  return lines.join('\n') + '\n';
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1';
}

/**
 * sshd_config time values: bare integer = seconds, suffix h/m/s also accepted
 * (e.g. "2m" = 120). Returns 0 on parse failure.
 */
function parseSeconds(value: string): number {
  const v = value.trim().toLowerCase();
  const m = /^(\d+)([smhd]?)$/.exec(v);
  if (!m) return Number.parseInt(v, 10) || 0;
  const n = Number.parseInt(m[1], 10);
  switch (m[2]) {
    case 'h': return n * 3600;
    case 'm': return n * 60;
    case 'd': return n * 86400;
    case 's':
    default:  return n;
  }
}

function splitList(value: string): readonly string[] {
  return Object.freeze(value.split(/\s+/).filter(Boolean));
}
