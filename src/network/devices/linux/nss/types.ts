/**
 * Name Service Switch — type vocabulary.
 *
 * Modelled after the glibc NSS API (`nss.h`, nsswitch.conf(5)). Every
 * lookup answer is wrapped in an {@link NssStatus}-tagged result so the
 * resolver can implement the action codes (`SUCCESS=`, `NOTFOUND=`,
 * `UNAVAIL=`, `TRYAGAIN=`) declared in `/etc/nsswitch.conf`.
 *
 * The simulator's payload shapes are deliberately faithful to the
 * canonical line formats of `/etc/passwd`, `/etc/group`, etc. — even
 * fields the sim does not yet exercise are kept so a future feature
 * (uid filtering, expanded `getent ahostsv4`, NIS map import, …) does
 * not require a vocabulary churn.
 */

// ─── Action / status codes ──────────────────────────────────────────────

/**
 * Per-source result status. Maps 1-to-1 onto the glibc NSS `nss_status`
 * enum (NSS_STATUS_SUCCESS / NSS_STATUS_NOTFOUND / NSS_STATUS_UNAVAIL /
 * NSS_STATUS_TRYAGAIN). The resolver decides whether to continue to the
 * next source based on the `[STATUS=action]` rule attached to it.
 */
export type NssStatus = 'SUCCESS' | 'NOTFOUND' | 'UNAVAIL' | 'TRYAGAIN';

/** Result envelope for a single-key lookup. */
export interface NssResult<T> {
  status: NssStatus;
  /** Populated iff status === 'SUCCESS'. */
  entry?: T;
}

/** Result envelope for a setX/getXent/enumerate-all call. */
export interface NssEnumResult<T> {
  status: NssStatus;
  /** Sequence of records in the order the source returned them. */
  entries: T[];
}

// ─── passwd database (/etc/passwd) ──────────────────────────────────────

/**
 * One `/etc/passwd` line. Field order matches `struct passwd` and the
 * colon-separated text format: `name:passwd:uid:gid:gecos:dir:shell`.
 * `passwd` is always `x` when shadow is configured — the encrypted
 * secret lives in `/etc/shadow`.
 */
export interface NssPasswdEntry {
  name: string;
  passwd: string;
  uid: number;
  gid: number;
  gecos: string;
  dir: string;
  shell: string;
}

// ─── group database (/etc/group) ────────────────────────────────────────

/** One `/etc/group` line: `name:passwd:gid:members`. */
export interface NssGroupEntry {
  name: string;
  passwd: string;
  gid: number;
  members: string[];
}

// ─── shadow database (/etc/shadow, root-only) ──────────────────────────

/**
 * One `/etc/shadow` line. Fields match `struct spwd`:
 * `name:passwd:lstchg:min:max:warn:inact:expire:flag`.
 */
export interface NssShadowEntry {
  name: string;
  /** Encrypted hash, `*`, `!`, or empty. */
  passwd: string;
  /** Days since 1970-01-01 of last change. */
  lstchg: number | '';
  /** Minimum days between changes. */
  min: number | '';
  /** Maximum days between changes. */
  max: number | '';
  /** Days before expire to warn. */
  warn: number | '';
  /** Days of inactivity allowed after expire. */
  inact: number | '';
  /** Absolute expire date (days since 1970-01-01). */
  expire: number | '';
  /** Reserved flag. */
  flag: number | '';
}

// ─── gshadow (/etc/gshadow, root-only) ─────────────────────────────────

/** One `/etc/gshadow` line: `name:passwd:admins:members`. */
export interface NssGshadowEntry {
  name: string;
  passwd: string;
  admins: string[];
  members: string[];
}

// ─── hosts (/etc/hosts) ────────────────────────────────────────────────

/** One IPv4/IPv6 host record. Matches `struct hostent`. */
export interface NssHostEntry {
  /** Canonical name (first hostname on the `/etc/hosts` line). */
  canonicalName: string;
  /** Address family. 2 = AF_INET, 10 = AF_INET6. */
  addressFamily: 2 | 10;
  /** Dotted-quad or colon-hex string. */
  address: string;
  /** Aliases — every hostname on the line beyond the canonical one. */
  aliases: string[];
}

// ─── services (/etc/services) ──────────────────────────────────────────

/** One `/etc/services` line: `name port/proto [aliases...]`. */
export interface NssServiceEntry {
  name: string;
  port: number;
  protocol: 'tcp' | 'udp' | 'sctp' | 'dccp' | string;
  aliases: string[];
}

// ─── protocols (/etc/protocols) ────────────────────────────────────────

/** One `/etc/protocols` line: `name number [aliases...]`. */
export interface NssProtocolEntry {
  name: string;
  number: number;
  aliases: string[];
}

// ─── networks (/etc/networks) ──────────────────────────────────────────

/** One `/etc/networks` line: `name net [aliases...]`. */
export interface NssNetworkEntry {
  name: string;
  network: string;
  aliases: string[];
}

// ─── ethers (/etc/ethers) ──────────────────────────────────────────────

/** One `/etc/ethers` line: `<mac> <hostname>`. */
export interface NssEthersEntry {
  mac: string;
  hostname: string;
}

// ─── rpc (/etc/rpc) ────────────────────────────────────────────────────

export interface NssRpcEntry {
  name: string;
  number: number;
  aliases: string[];
}

// ─── netgroup (/etc/netgroup) ─────────────────────────────────────────

/**
 * One netgroup triple `(host, user, domain)`. The legacy NIS netgroup
 * machinery; rarely populated on modern Ubuntu, but we keep the shape
 * so `getent netgroup` answers without erroring.
 */
export interface NssNetgroupTriple {
  host: string;
  user: string;
  domain: string;
}

export interface NssNetgroupEntry {
  name: string;
  triples: NssNetgroupTriple[];
}

// ─── Source action codes (per nsswitch.conf) ───────────────────────────

/**
 * Action attached to an `[STATUS=action]` pair inside `/etc/nsswitch.conf`.
 * The defaults are: `SUCCESS=return`, `NOTFOUND=continue`,
 * `UNAVAIL=continue`, `TRYAGAIN=continue`.
 */
export type NssAction = 'return' | 'continue' | 'merge';

/** Source declaration as read from nsswitch.conf. */
export interface NssSourceSpec {
  /** Source name (`files`, `dns`, `systemd`, `compat`, `ldap`, …). */
  name: string;
  /** Per-status action overrides. */
  actions: Partial<Record<NssStatus, NssAction>>;
}

/** Per-database source ordering, as read from `/etc/nsswitch.conf`. */
export interface NssDatabaseConfig {
  /** Lower-case database name (`passwd`, `group`, `hosts`, …). */
  database: string;
  /** Sources in declared order. */
  sources: NssSourceSpec[];
}

/** Supported database identifier strings (lower-case). */
export type NssDatabase =
  | 'passwd' | 'group' | 'shadow' | 'gshadow'
  | 'hosts' | 'ahosts' | 'ahostsv4' | 'ahostsv6'
  | 'services' | 'protocols' | 'networks'
  | 'ethers' | 'rpc' | 'netgroup' | 'aliases' | 'initgroups';
