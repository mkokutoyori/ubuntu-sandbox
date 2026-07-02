/**
 * FilesNssSource — the `files` NSS source.
 *
 * Reads `/etc/passwd`, `/etc/group`, `/etc/shadow`, `/etc/gshadow`,
 * `/etc/hosts`, `/etc/services`, `/etc/protocols`, `/etc/networks`,
 * `/etc/ethers`, `/etc/rpc`, `/etc/netgroup` through the device's
 * VirtualFileSystem. The IamFilesystem (added in the recent main merge)
 * is the writer for the account databases; we just read.
 *
 * Faithful to real Linux:
 *   - empty/missing file → NOTFOUND (not UNAVAIL — the source itself is
 *     reachable, the requested record just isn't there).
 *   - shadow / gshadow → only readable when uid 0 ("getent shadow"
 *     run as user errors out with the same NOTFOUND glibc returns).
 *   - hosts → resolves IPv4 + IPv6 in a single sweep; the caller
 *     filters by family.
 *
 * Caching: `Files` is single-process in real glibc; the simulator reads
 * the VFS each call. The {@link NameServiceSwitch} can layer a cache on
 * top — invalidating via IAM events keeps it coherent.
 */

import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxUserManager } from '../LinuxUserManager';
import { HostsFile } from '../../HostsFile';
import type { INssSource } from './INssSource';
import type {
  NssEnumResult, NssResult,
  NssEthersEntry, NssGroupEntry, NssGshadowEntry, NssHostEntry,
  NssNetgroupEntry, NssNetworkEntry, NssPasswdEntry, NssProtocolEntry,
  NssRpcEntry, NssServiceEntry, NssShadowEntry,
} from './types';

import { nssOk as SUCCESS, nssNotFound as NOTFOUND, nssEnumOk as ENUM_OK, nssEnumEmpty as ENUM_EMPTY } from './nssResult';

/**
 * Read a colon/whitespace-separated file as a list of trimmed lines,
 * dropping comments and blanks. Returns null if the file is missing.
 */
function readRecords(vfs: VirtualFileSystem, path: string): string[] | null {
  const content = vfs.readFile(path);
  if (content == null) return null;
  const lines: string[] = [];
  for (const raw of content.split('\n')) {
    const stripped = raw.replace(/#.*$/, '').trim();
    if (stripped) lines.push(stripped);
  }
  return lines;
}

export class FilesNssSource implements INssSource {
  readonly name = 'files';

  /**
   * @param vfs     Owning device's VFS — single source of truth for the
   *                `/etc/*` projections.
   * @param userMgr Used for the privileged-uid check guarding shadow /
   *                gshadow reads. Pass `null` to disable the check
   *                (e.g. in unit tests that want to introspect shadow).
   */
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly userMgr: Pick<LinuxUserManager, 'currentUid'> | null = null,
  ) {}

  // ─── passwd ─────────────────────────────────────────────────────────

  getpwnam(name: string): NssResult<NssPasswdEntry> {
    for (const e of this.iteratePasswd()) {
      if (e.name === name) return SUCCESS(e);
    }
    return NOTFOUND();
  }

  getpwuid(uid: number): NssResult<NssPasswdEntry> {
    for (const e of this.iteratePasswd()) {
      if (e.uid === uid) return SUCCESS(e);
    }
    return NOTFOUND();
  }

  enumPasswd(): NssEnumResult<NssPasswdEntry> {
    const list = [...this.iteratePasswd()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iteratePasswd(): Generator<NssPasswdEntry> {
    const lines = readRecords(this.vfs, '/etc/passwd');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 7) continue;
      const uid = parseInt(parts[2], 10);
      const gid = parseInt(parts[3], 10);
      if (!Number.isFinite(uid) || !Number.isFinite(gid)) continue;
      yield {
        name: parts[0],
        passwd: parts[1],
        uid,
        gid,
        gecos: parts[4],
        dir: parts[5],
        shell: parts[6],
      };
    }
  }

  // ─── group ──────────────────────────────────────────────────────────

  getgrnam(name: string): NssResult<NssGroupEntry> {
    for (const g of this.iterateGroup()) if (g.name === name) return SUCCESS(g);
    return NOTFOUND();
  }

  getgrgid(gid: number): NssResult<NssGroupEntry> {
    for (const g of this.iterateGroup()) if (g.gid === gid) return SUCCESS(g);
    return NOTFOUND();
  }

  enumGroup(): NssEnumResult<NssGroupEntry> {
    const list = [...this.iterateGroup()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  initgroups(user: string): NssResult<number[]> {
    const gids: number[] = [];
    for (const g of this.iterateGroup()) {
      if (g.members.includes(user)) gids.push(g.gid);
    }
    // Also include the user's primary GID, if discoverable.
    const pw = this.getpwnam(user);
    if (pw.status === 'SUCCESS' && pw.entry && !gids.includes(pw.entry.gid)) {
      gids.unshift(pw.entry.gid);
    }
    return gids.length ? SUCCESS(gids) : NOTFOUND();
  }

  private *iterateGroup(): Generator<NssGroupEntry> {
    const lines = readRecords(this.vfs, '/etc/group');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 4) continue;
      const gid = parseInt(parts[2], 10);
      if (!Number.isFinite(gid)) continue;
      yield {
        name: parts[0],
        passwd: parts[1],
        gid,
        members: parts[3] ? parts[3].split(',').map(s => s.trim()).filter(Boolean) : [],
      };
    }
  }

  // ─── shadow / gshadow (root-only) ───────────────────────────────────

  getspnam(name: string): NssResult<NssShadowEntry> {
    if (!this.isRoot()) return NOTFOUND();
    for (const e of this.iterateShadow()) if (e.name === name) return SUCCESS(e);
    return NOTFOUND();
  }

  enumShadow(): NssEnumResult<NssShadowEntry> {
    if (!this.isRoot()) return ENUM_EMPTY();
    const list = [...this.iterateShadow()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateShadow(): Generator<NssShadowEntry> {
    const lines = readRecords(this.vfs, '/etc/shadow');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 9) continue;
      const toNum = (s: string) => s === '' ? '' : (parseInt(s, 10) || 0);
      yield {
        name: parts[0],
        passwd: parts[1],
        lstchg: toNum(parts[2]),
        min: toNum(parts[3]),
        max: toNum(parts[4]),
        warn: toNum(parts[5]),
        inact: toNum(parts[6]),
        expire: toNum(parts[7]),
        flag: toNum(parts[8]),
      };
    }
  }

  getsgnam(name: string): NssResult<NssGshadowEntry> {
    if (!this.isRoot()) return NOTFOUND();
    for (const e of this.iterateGshadow()) if (e.name === name) return SUCCESS(e);
    return NOTFOUND();
  }

  enumGshadow(): NssEnumResult<NssGshadowEntry> {
    if (!this.isRoot()) return ENUM_EMPTY();
    const list = [...this.iterateGshadow()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateGshadow(): Generator<NssGshadowEntry> {
    const lines = readRecords(this.vfs, '/etc/gshadow');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 4) continue;
      yield {
        name: parts[0],
        passwd: parts[1],
        admins: parts[2] ? parts[2].split(',').map(s => s.trim()).filter(Boolean) : [],
        members: parts[3] ? parts[3].split(',').map(s => s.trim()).filter(Boolean) : [],
      };
    }
  }

  private isRoot(): boolean {
    if (!this.userMgr) return true;
    return this.userMgr.currentUid === 0;
  }

  // ─── hosts ──────────────────────────────────────────────────────────

  gethostbyname(name: string, family?: 2 | 10): NssResult<NssHostEntry[]> {
    const matches: NssHostEntry[] = [];
    for (const h of this.iterateHosts()) {
      if (family && h.addressFamily !== family) continue;
      if (h.canonicalName === name || h.aliases.includes(name)) matches.push(h);
    }
    return matches.length ? SUCCESS(matches) : NOTFOUND();
  }

  gethostbyaddr(addr: string): NssResult<NssHostEntry> {
    for (const h of this.iterateHosts()) if (h.address === addr) return SUCCESS(h);
    return NOTFOUND();
  }

  enumHosts(): NssEnumResult<NssHostEntry> {
    const list = [...this.iterateHosts()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateHosts(): Generator<NssHostEntry> {
    const table = HostsFile.parse(this.vfs.readFile('/etc/hosts'));
    for (const entry of table.entries) {
      yield {
        address: entry.ip,
        addressFamily: entry.isIPv6 ? 10 : 2,
        canonicalName: entry.canonicalName,
        aliases: [...entry.aliases],
      };
    }
  }

  // ─── services ───────────────────────────────────────────────────────

  getservbyname(name: string, protocol?: string): NssResult<NssServiceEntry> {
    for (const s of this.iterateServices()) {
      if ((s.name === name || s.aliases.includes(name))
          && (!protocol || s.protocol === protocol)) {
        return SUCCESS(s);
      }
    }
    return NOTFOUND();
  }

  getservbyport(port: number, protocol?: string): NssResult<NssServiceEntry> {
    for (const s of this.iterateServices()) {
      if (s.port === port && (!protocol || s.protocol === protocol)) return SUCCESS(s);
    }
    return NOTFOUND();
  }

  enumServices(): NssEnumResult<NssServiceEntry> {
    const list = [...this.iterateServices()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateServices(): Generator<NssServiceEntry> {
    const lines = readRecords(this.vfs, '/etc/services');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const portProto = parts[1];
      const slash = portProto.indexOf('/');
      if (slash === -1) continue;
      const port = parseInt(portProto.slice(0, slash), 10);
      const protocol = portProto.slice(slash + 1);
      if (!Number.isFinite(port) || !protocol) continue;
      yield { name: parts[0], port, protocol, aliases: parts.slice(2) };
    }
  }

  // ─── protocols ──────────────────────────────────────────────────────

  getprotobyname(name: string): NssResult<NssProtocolEntry> {
    for (const p of this.iterateProtocols()) {
      if (p.name === name || p.aliases.includes(name)) return SUCCESS(p);
    }
    return NOTFOUND();
  }

  getprotobynumber(num: number): NssResult<NssProtocolEntry> {
    for (const p of this.iterateProtocols()) if (p.number === num) return SUCCESS(p);
    return NOTFOUND();
  }

  enumProtocols(): NssEnumResult<NssProtocolEntry> {
    const list = [...this.iterateProtocols()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateProtocols(): Generator<NssProtocolEntry> {
    const lines = readRecords(this.vfs, '/etc/protocols');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const number = parseInt(parts[1], 10);
      if (!Number.isFinite(number)) continue;
      yield { name: parts[0], number, aliases: parts.slice(2) };
    }
  }

  // ─── networks ───────────────────────────────────────────────────────

  getnetbyname(name: string): NssResult<NssNetworkEntry> {
    for (const n of this.iterateNetworks()) {
      if (n.name === name || n.aliases.includes(name)) return SUCCESS(n);
    }
    return NOTFOUND();
  }

  getnetbyaddr(addr: string): NssResult<NssNetworkEntry> {
    for (const n of this.iterateNetworks()) if (n.network === addr) return SUCCESS(n);
    return NOTFOUND();
  }

  enumNetworks(): NssEnumResult<NssNetworkEntry> {
    const list = [...this.iterateNetworks()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateNetworks(): Generator<NssNetworkEntry> {
    const lines = readRecords(this.vfs, '/etc/networks');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      yield { name: parts[0], network: parts[1], aliases: parts.slice(2) };
    }
  }

  // ─── ethers ─────────────────────────────────────────────────────────

  getetherbyaddr(mac: string): NssResult<NssEthersEntry> {
    for (const e of this.iterateEthers()) if (e.mac === mac) return SUCCESS(e);
    return NOTFOUND();
  }

  getetherbyname(host: string): NssResult<NssEthersEntry> {
    for (const e of this.iterateEthers()) if (e.hostname === host) return SUCCESS(e);
    return NOTFOUND();
  }

  enumEthers(): NssEnumResult<NssEthersEntry> {
    const list = [...this.iterateEthers()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateEthers(): Generator<NssEthersEntry> {
    const lines = readRecords(this.vfs, '/etc/ethers');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      yield { mac: parts[0], hostname: parts[1] };
    }
  }

  // ─── rpc ────────────────────────────────────────────────────────────

  getrpcbyname(name: string): NssResult<NssRpcEntry> {
    for (const r of this.iterateRpc()) {
      if (r.name === name || r.aliases.includes(name)) return SUCCESS(r);
    }
    return NOTFOUND();
  }

  getrpcbynumber(num: number): NssResult<NssRpcEntry> {
    for (const r of this.iterateRpc()) if (r.number === num) return SUCCESS(r);
    return NOTFOUND();
  }

  enumRpc(): NssEnumResult<NssRpcEntry> {
    const list = [...this.iterateRpc()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateRpc(): Generator<NssRpcEntry> {
    const lines = readRecords(this.vfs, '/etc/rpc');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const number = parseInt(parts[1], 10);
      if (!Number.isFinite(number)) continue;
      yield { name: parts[0], number, aliases: parts.slice(2) };
    }
  }

  // ─── netgroup ───────────────────────────────────────────────────────

  getnetgrent(name: string): NssResult<NssNetgroupEntry> {
    for (const g of this.iterateNetgroup()) if (g.name === name) return SUCCESS(g);
    return NOTFOUND();
  }

  enumNetgroup(): NssEnumResult<NssNetgroupEntry> {
    const list = [...this.iterateNetgroup()];
    return list.length ? ENUM_OK(list) : ENUM_EMPTY();
  }

  private *iterateNetgroup(): Generator<NssNetgroupEntry> {
    const lines = readRecords(this.vfs, '/etc/netgroup');
    if (!lines) return;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const triples = parts.slice(1)
        .filter(t => t.startsWith('(') && t.endsWith(')'))
        .map(t => {
          const inner = t.slice(1, -1).split(',');
          return {
            host: inner[0]?.trim() ?? '',
            user: inner[1]?.trim() ?? '',
            domain: inner[2]?.trim() ?? '',
          };
        });
      yield { name: parts[0], triples };
    }
  }
}
