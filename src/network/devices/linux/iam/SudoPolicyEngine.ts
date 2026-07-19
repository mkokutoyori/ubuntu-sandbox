/**
 * SudoPolicyEngine — resolves aliases and evaluates sudoers rules for
 * real authorization decisions (`canSudoCommand`, `sudo -l`), unlike
 * `canSudo()`'s historical pure-group-membership check or `sudoList()`'s
 * substring search over raw file text.
 *
 * Loading aggregates `/etc/sudoers` with `/etc/sudoers.d/*` (alphabetical,
 * matching real sudo's `#includedir` semantics: files containing a `.`
 * or ending in `~` are silently skipped, and a file whose owner/mode
 * isn't root-owned 0440-or-stricter is skipped with a warning — but a
 * syntax error anywhere in the chain fails the WHOLE load closed, since
 * a real broken sudoers config leaves every `sudo` invocation refused
 * rather than partially enforced).
 */

import type { VirtualFileSystem } from '../VirtualFileSystem';
import {
  parseSudoersText, type AliasTable, type SudoersRule, type SudoersParseError,
  type ListItem, type DefaultsConfig,
} from './SudoersGrammar';

export interface SudoActor {
  user: string;
  groups: string[];
}

export interface SudoEvalResult {
  allowed: boolean;
  nopasswd: boolean;
  matchedRule?: SudoersRule;
}

export interface SkippedSudoersFile {
  path: string;
  reason: string;
}

export interface SudoPolicyLoadResult {
  ok: boolean;
  engine: SudoPolicyEngine | null;
  errors: SudoersParseError[];
  skippedFiles: SkippedSudoersFile[];
  /** Every file whose content was actually parsed (main + includes, in
   *  inclusion order) — used by `visudo -c` to report per-file status. */
  checkedFiles: string[];
}

const ALIAS_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Expand alias references into a flat list of literal tokens,
 *  combining negation (`!ALIAS` where the alias itself has `!member`
 *  entries flips those members back) with a cycle guard. */
function flattenAliasItems(
  items: ListItem[],
  aliasMap: Map<string, ListItem[]>,
  seen: Set<string> = new Set(),
): ListItem[] {
  const out: ListItem[] = [];
  for (const item of items) {
    if (item.token !== 'ALL' && ALIAS_NAME_RE.test(item.token) && aliasMap.has(item.token)) {
      if (seen.has(item.token)) continue;
      const nestedSeen = new Set(seen).add(item.token);
      const nested = flattenAliasItems(aliasMap.get(item.token)!, aliasMap, nestedSeen);
      for (const n of nested) out.push({ negated: item.negated !== n.negated, token: n.token });
    } else {
      out.push(item);
    }
  }
  return out;
}

function tokenMatchesUser(token: string, actor: SudoActor): boolean {
  if (token === 'ALL') return true;
  if (token.startsWith('%')) return actor.groups.includes(token.slice(1));
  return token === actor.user;
}

function tokenMatchesHost(token: string, hostname: string, hostIps: readonly string[]): boolean {
  if (token === 'ALL') return true;
  if (token === hostname) return true;
  if (token.includes('/')) return hostIps.some((ip) => ipInCidr(ip, token));
  return hostIps.includes(token);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipNum = ipToInt(ip);
  const baseNum = ipToInt(base);
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function globMatch(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(text);
}

/** `/bin/cat /etc/*` → command path must match exactly; if a glob-arg
 *  suffix is present the joined argument string must match it too. A
 *  bare path with no suffix allows that command with ANY arguments. */
function tokenMatchesCommand(token: string, cmdPath: string, argsJoined: string): boolean {
  if (token === 'ALL') return true;
  if (!token.startsWith('/')) return false;
  const spaceIdx = token.indexOf(' ');
  const tokPath = spaceIdx === -1 ? token : token.slice(0, spaceIdx);
  if (tokPath !== cmdPath) return false;
  if (spaceIdx === -1) return true;
  return globMatch(token.slice(spaceIdx + 1).trim(), argsJoined);
}

function lastMatchVerdict(flat: ListItem[], matches: (token: string) => boolean): boolean {
  let verdict = false;
  for (const item of flat) {
    if (matches(item.token)) verdict = !item.negated;
  }
  return verdict;
}

export class SudoPolicyEngine {
  constructor(
    private readonly aliases: AliasTable,
    readonly rules: readonly SudoersRule[],
    readonly defaults: DefaultsConfig,
  ) {}

  private ruleApplies(rule: SudoersRule, actor: SudoActor, hostname: string, hostIps: readonly string[]): boolean {
    const users = flattenAliasItems(rule.users, this.aliases.User_Alias);
    const hosts = flattenAliasItems(rule.hosts, this.aliases.Host_Alias);
    return lastMatchVerdict(users, (t) => tokenMatchesUser(t, actor))
      && lastMatchVerdict(hosts, (t) => tokenMatchesHost(t, hostname, hostIps));
  }

  private matchesRunas(rule: SudoersRule, requestedUser: string): boolean {
    if (rule.runasUsers === null) return requestedUser === 'root';
    const flat = flattenAliasItems(rule.runasUsers, this.aliases.Runas_Alias);
    return lastMatchVerdict(flat, (t) => t === 'ALL' || t === requestedUser);
  }

  /** True if the actor has ANY applicable rule on this host, regardless
   *  of which command — the "in the sudoers file at all" gate. */
  hasAnyAccess(actor: SudoActor, hostname: string, hostIps: readonly string[]): boolean {
    return this.rules.some((r) => this.ruleApplies(r, actor, hostname, hostIps));
  }

  /** The real authorization decision for one command invocation. */
  evaluate(
    actor: SudoActor, hostname: string, hostIps: readonly string[],
    runasUser: string, cmdPath: string, args: readonly string[],
  ): SudoEvalResult {
    const argsJoined = args.join(' ');
    let allowed = false;
    let nopasswd = false;
    let matchedRule: SudoersRule | undefined;
    for (const rule of this.rules) {
      if (!this.ruleApplies(rule, actor, hostname, hostIps)) continue;
      if (!this.matchesRunas(rule, runasUser)) continue;
      const flatCmnds = flattenAliasItems(rule.cmnds, this.aliases.Cmnd_Alias);
      let local: boolean | null = null;
      for (const item of flatCmnds) {
        if (tokenMatchesCommand(item.token, cmdPath, argsJoined)) local = !item.negated;
      }
      if (local !== null) {
        allowed = local;
        nopasswd = !!rule.tags.nopasswd;
        matchedRule = rule;
      }
    }
    return { allowed, nopasswd, matchedRule };
  }

  /** Rules applicable to `actor` on this host, resolved into a
   *  `sudo -l`-style rendering: one line per distinct (runas, tags) group. */
  renderMatchingRules(actor: SudoActor, hostname: string, hostIps: readonly string[]): string[] {
    const lines: string[] = [];
    for (const rule of this.rules) {
      if (!this.ruleApplies(rule, actor, hostname, hostIps)) continue;
      const runasUsersStr = rule.runasUsers === null
        ? 'root'
        : flattenAliasItems(rule.runasUsers, this.aliases.Runas_Alias)
          .filter((i) => !i.negated).map((i) => i.token).join(', ');
      const runasGroupsStr = rule.runasGroups
        ? flattenAliasItems(rule.runasGroups, this.aliases.Runas_Alias)
          .filter((i) => !i.negated).map((i) => i.token).join(', ')
        : null;
      const runasPart = runasGroupsStr !== null ? `${runasUsersStr} : ${runasGroupsStr}` : runasUsersStr;
      const tagPrefix = rule.tags.nopasswd ? 'NOPASSWD: ' : '';
      const cmndStr = flattenAliasItems(rule.cmnds, this.aliases.Cmnd_Alias)
        .map((i) => (i.negated ? `!${i.token}` : i.token)).join(', ');
      lines.push(`(${runasPart}) ${tagPrefix}${cmndStr}`);
    }
    return lines;
  }
}

/** Real sudo's `#includedir` skip rule: ignore names containing `.` or
 *  ending in `~` (editor backups, `.bak`, `.rpmnew`, …). */
function isSkippableSudoersDName(name: string): boolean {
  return name.includes('.') || name.endsWith('~');
}

export function loadSudoPolicy(vfs: VirtualFileSystem): SudoPolicyLoadResult {
  const mainContent = vfs.readFile('/etc/sudoers');
  if (mainContent === null) {
    return {
      ok: false, engine: null,
      errors: [{ file: '/etc/sudoers', lineNo: 0, message: 'file not found' }],
      skippedFiles: [], checkedFiles: [],
    };
  }

  const skippedFiles: SkippedSudoersFile[] = [];
  const includePaths: string[] = [];
  const dirEntries = vfs.listDirectory('/etc/sudoers.d');
  if (dirEntries) {
    const names = [...dirEntries]
      .map((e) => e.name)
      .filter((n) => n !== '.' && n !== '..')
      .sort();
    for (const name of names) {
      if (isSkippableSudoersDName(name)) {
        skippedFiles.push({ path: `/etc/sudoers.d/${name}`, reason: 'ignored file name (contains "." or ends with "~")' });
        continue;
      }
      const path = `/etc/sudoers.d/${name}`;
      const inode = vfs.resolveInode(path);
      if (!inode) continue;
      const mode = inode.permissions & 0o7777;
      // The real convention (0440 root:root) always has group-READ set —
      // only group write/exec and any "other" bit make a file insecure.
      const insecure = inode.uid !== 0 || (mode & 0o0037) !== 0;
      if (insecure) {
        skippedFiles.push({ path, reason: `insecure permissions/owner (mode ${mode.toString(8)}, uid ${inode.uid}) — must be root-owned 0440 or stricter` });
        continue;
      }
      includePaths.push(path);
    }
  }

  const allErrors: SudoersParseError[] = [];
  const aliases: AliasTable = { User_Alias: new Map(), Host_Alias: new Map(), Runas_Alias: new Map(), Cmnd_Alias: new Map() };
  const rules: SudoersRule[] = [];
  const defaults: DefaultsConfig = { flags: new Set() };

  const files: Array<[string, string]> = [['/etc/sudoers', mainContent]];
  for (const p of includePaths) files.push([p, vfs.readFile(p) ?? '']);

  for (const [path, content] of files) {
    const { parsed, errors } = parseSudoersText(content, path);
    allErrors.push(...errors);
    for (const kind of ['User_Alias', 'Host_Alias', 'Runas_Alias', 'Cmnd_Alias'] as const) {
      for (const [name, items] of parsed.aliases[kind]) aliases[kind].set(name, items);
    }
    rules.push(...parsed.rules);
    if (parsed.defaults.logfile) defaults.logfile = parsed.defaults.logfile;
    for (const f of parsed.defaults.flags) defaults.flags.add(f);
  }

  const checkedFiles = files.map(([path]) => path);
  if (allErrors.length > 0) {
    return { ok: false, engine: null, errors: allErrors, skippedFiles, checkedFiles };
  }
  return { ok: true, engine: new SudoPolicyEngine(aliases, rules, defaults), errors: [], skippedFiles, checkedFiles };
}
