import { strerror, type Errno } from '@/network/core/Errno';

export const RSYSLOG_VERSION = '8.2112.0';

export const RS_RET = {
  ERR: -3000,
  NO_ERRCODE: -1,
  NOT_FOUND: -3003,
  SUSPENDED: -2007,
  INVALID_VALUE: -2009,
  FILE_NOT_FOUND: -2040,
  CONFIG_ERROR: -2046,
  MODULE_LOAD_ERR_DLOPEN: -2066,
  NO_ACTIONS: -2103,
  GNUTLS_ERR: -2078,
  TLS_HANDSHAKE_ERR: -2083,
  TLS_CERT_ERR: -2084,
  TLS_NO_CERT: -2085,
  INVALID_FINGERPRINT: -2088,
  CERT_INVALID: -2090,
  CERT_EXPIRED: -2092,
  CERT_NOT_YET_ACTIVE: -2094,
  INVALID_WILDCARD: -2098,
  CRL_INVALID: -2333,
  CERT_REVOKED: -2334,
  CA_CERT_MISSING: -2329,
  CERT_MISSING: -2330,
  CERTKEY_MISSING: -2331,
  VALUE_NOT_SUPPORTED: -2086,
  CONF_FILE_NOT_FOUND: -2104,
  CMD_GONE_AWAY: -2204,
  CONF_PARSE_ERROR: -2207,
  CONF_RQRD_PARAM_MISSING: -2208,
  MOD_UNKNOWN: -2209,
  RULESET_EXISTS: -2306,
  CONF_PARSE_WARNING: -2357,
  DEBUG: -2458,
  MALICIOUS_ENTITY: -2021,
  HOST_NOT_PERMITTED: -2063,
  INVALID_PORT: -2076,
  MAX_SESS_REACHED: -2079,
  NO_LISTNERS: -2212,
  ERR_SCHED_PARAMS: -2205,
  OVERSIZE_MSG: -2445,
  SERVER_NO_TLS: -2465,
  DEPRECATED: -2307,
  CONFOBJ_UNSUPPORTED: -2210,
  MISSING_CNFPARAMS: -2211,
  OK_WARN: -2186,
  RATE_LIMITED: -2177,
  RESUMED: -2359,
  ACTION_FAILED: -2123,
  IO_ERROR: -2027,
  PEER_CLOSED_CONN: -2144,
  ERR_UDPSEND: -2354,
  UDP_MSGSIZE_TOO_LARGE: -2440,
  PARAM_ERROR: -1000,
  INVALID_PARAMS: -2016,
  INVLD_PROTOCOL: -2213,
  CNF_INVLD_FRAMING: -2214,
  INTERNAL_ERROR: -2175,
  NOT_IMPLEMENTED: -7,
  DUP_PARAM: -2220,
  FILE_OPEN_ERROR: -2433,
} as const;

export type LogSeverity = 'error' | 'warning' | 'info';

export interface LogEntry {
  readonly severity: LogSeverity;
  readonly code: number;
  readonly text: string;
}

export function formatLogEntry(text: string, code: number, errno: Errno | null = null): string {
  const base = errno === null ? text : `${text}: ${strerror(errno)}`;
  if (code === RS_RET.NO_ERRCODE || code === RS_RET.ERR) return `${base} [v${RSYSLOG_VERSION}]`;
  return `${base} [v${RSYSLOG_VERSION} try https://www.rsyslog.com/e/${-code} ]`;
}

export class DiagnosticLog {
  readonly entries: LogEntry[] = [];

  error(text: string, code: number = RS_RET.ERR, errno?: Errno): void {
    this.entries.push({ severity: 'error', code, text: errno === undefined ? text : `${text}: ${strerror(errno)}` });
  }

  warning(text: string, code: number = RS_RET.NO_ERRCODE): void {
    this.entries.push({ severity: 'warning', code, text });
  }

  info(text: string, code: number = RS_RET.NO_ERRCODE): void {
    this.entries.push({ severity: 'info', code, text });
  }

  hadErrors(): boolean {
    return this.entries.some((entry) => entry.severity === 'error');
  }

  lines(): string[] {
    return this.entries.map((entry) => `rsyslogd: ${formatLogEntry(entry.text, entry.code)}`);
  }
}
