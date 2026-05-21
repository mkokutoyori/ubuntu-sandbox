/**
 * INssSource — one row in `/etc/nsswitch.conf`.
 *
 * A source answers per-database lookups (`getpwnam`, `getgrgid`,
 * `gethostbyname`, …). Each method returns a tagged {@link NssResult}
 * so the resolver can apply the `[STATUS=action]` rules of the source's
 * declaration. Methods are optional — a source signals "I don't answer
 * this database" by simply not implementing the method; the resolver
 * treats a missing method as `UNAVAIL`.
 *
 * Sources are deliberately *passive* providers: they don't know about
 * caching, ordering, or fall-through — the {@link NameServiceSwitch}
 * orchestrates that. This keeps each source independently testable.
 *
 * Naming follows the glibc convention:
 *   - `getXYnam(name)`   — lookup by name
 *   - `getXYid(id)`      — lookup by numeric id (uid/gid/port/proto-no)
 *   - `enumXY()`         — enumerate all (for `getent passwd` with no key)
 */

import type {
  NssResult, NssEnumResult,
  NssPasswdEntry, NssGroupEntry, NssShadowEntry, NssGshadowEntry,
  NssHostEntry, NssServiceEntry, NssProtocolEntry, NssNetworkEntry,
  NssEthersEntry, NssRpcEntry, NssNetgroupEntry,
} from './types';

export interface INssSource {
  /** Canonical name used in `/etc/nsswitch.conf`. */
  readonly name: string;

  // ── passwd ─────────────────────────────────────────────────────────
  getpwnam?(name: string): NssResult<NssPasswdEntry>;
  getpwuid?(uid: number): NssResult<NssPasswdEntry>;
  enumPasswd?(): NssEnumResult<NssPasswdEntry>;

  // ── group ──────────────────────────────────────────────────────────
  getgrnam?(name: string): NssResult<NssGroupEntry>;
  getgrgid?(gid: number): NssResult<NssGroupEntry>;
  enumGroup?(): NssEnumResult<NssGroupEntry>;
  /** initgroups(user) — list of supplementary GIDs for a user. */
  initgroups?(user: string): NssResult<number[]>;

  // ── shadow / gshadow ───────────────────────────────────────────────
  getspnam?(name: string): NssResult<NssShadowEntry>;
  enumShadow?(): NssEnumResult<NssShadowEntry>;
  getsgnam?(name: string): NssResult<NssGshadowEntry>;
  enumGshadow?(): NssEnumResult<NssGshadowEntry>;

  // ── hosts (gethostbyname/-byaddr) ──────────────────────────────────
  gethostbyname?(name: string, family?: 2 | 10): NssResult<NssHostEntry[]>;
  gethostbyaddr?(addr: string): NssResult<NssHostEntry>;
  enumHosts?(): NssEnumResult<NssHostEntry>;

  // ── services / protocols / networks ────────────────────────────────
  getservbyname?(name: string, protocol?: string): NssResult<NssServiceEntry>;
  getservbyport?(port: number, protocol?: string): NssResult<NssServiceEntry>;
  enumServices?(): NssEnumResult<NssServiceEntry>;

  getprotobyname?(name: string): NssResult<NssProtocolEntry>;
  getprotobynumber?(num: number): NssResult<NssProtocolEntry>;
  enumProtocols?(): NssEnumResult<NssProtocolEntry>;

  getnetbyname?(name: string): NssResult<NssNetworkEntry>;
  getnetbyaddr?(addr: string): NssResult<NssNetworkEntry>;
  enumNetworks?(): NssEnumResult<NssNetworkEntry>;

  // ── ethers / rpc / netgroup ────────────────────────────────────────
  getetherbyaddr?(mac: string): NssResult<NssEthersEntry>;
  getetherbyname?(host: string): NssResult<NssEthersEntry>;
  enumEthers?(): NssEnumResult<NssEthersEntry>;

  getrpcbyname?(name: string): NssResult<NssRpcEntry>;
  getrpcbynumber?(num: number): NssResult<NssRpcEntry>;
  enumRpc?(): NssEnumResult<NssRpcEntry>;

  getnetgrent?(name: string): NssResult<NssNetgroupEntry>;
  enumNetgroup?(): NssEnumResult<NssNetgroupEntry>;
}
