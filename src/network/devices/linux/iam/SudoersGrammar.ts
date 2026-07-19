/**
 * SudoersGrammar — structured parser for sudoers-format text.
 *
 * `PwGrCheck.ts`'s `validateSudoersLine` only answers "is this line
 * syntactically valid" (for `visudo -c`) — it throws its parse away. The
 * real policy engine (`SudoPolicyEngine.ts`) needs the parsed *fields*
 * (users, hosts, runas, tags, commands) and alias definitions to actually
 * decide who can run what, so this is a second, structure-preserving
 * parser over the same grammar rather than a reuse of that one.
 *
 * Grammar covered (single cmndspec per rule line — chained cmndspecs
 * separated by `:` on one line are not supported, matching the existing
 * syntax validator's documented limitation):
 *   User_Alias|Host_Alias|Runas_Alias|Cmnd_Alias NAME = item, item, ...
 *   Defaults [flag | key=value], ...
 *   user_list host_list = [(runas_list)] [TAG:]* cmnd_list
 */

export type AliasKind = 'User_Alias' | 'Host_Alias' | 'Runas_Alias' | 'Cmnd_Alias';

/** A single list entry, e.g. `!INTERDITES` → { negated: true, token: 'INTERDITES' }. */
export interface ListItem {
  negated: boolean;
  token: string;
}

export interface RuleTags {
  nopasswd?: boolean;
  noexec?: boolean;
}

export interface SudoersRule {
  users: ListItem[];
  hosts: ListItem[];
  /** null = rule specifies no explicit Runas_Spec — real sudoers defaults to root. */
  runasUsers: ListItem[] | null;
  runasGroups: ListItem[] | null;
  tags: RuleTags;
  cmnds: ListItem[];
  sourceFile: string;
  lineNo: number;
}

export interface DefaultsConfig {
  logfile?: string;
  flags: Set<string>;
}

export interface AliasTable {
  User_Alias: Map<string, ListItem[]>;
  Host_Alias: Map<string, ListItem[]>;
  Runas_Alias: Map<string, ListItem[]>;
  Cmnd_Alias: Map<string, ListItem[]>;
}

export interface ParsedSudoers {
  aliases: AliasTable;
  rules: SudoersRule[];
  defaults: DefaultsConfig;
}

export interface SudoersParseError {
  file: string;
  lineNo: number;
  message: string;
}

function emptyAliasTable(): AliasTable {
  return {
    User_Alias: new Map(),
    Host_Alias: new Map(),
    Runas_Alias: new Map(),
    Cmnd_Alias: new Map(),
  };
}

const ALIAS_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** A list item: optional `!`, then a bare word (name/alias/%group,
 *  optionally a `host/NN` CIDR for Host_Alias entries) or an absolute-path
 *  command optionally followed by a space-separated glob argument pattern
 *  (`/bin/cat /etc/*`). */
const LIST_ITEM_RE = /^(!*)(ALL|[A-Z][A-Z0-9_]*|%?[\w.\-]+(?:\/\d{1,2})?(?::%?[\w.\-]+)?|\/\S+(?:\s+\S+)*)$/;

function parseListItems(raw: string): ListItem[] | null {
  const items = splitTopLevel(raw, ',');
  const out: ListItem[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) return null;
    const m = LIST_ITEM_RE.exec(trimmed);
    if (!m) return null;
    const negated = m[1].length % 2 === 1;
    out.push({ negated, token: m[2] });
  }
  return out.length > 0 ? out : null;
}

/** Split on a top-level separator character, honouring that command
 *  items may themselves contain commas inside a glob pattern only in
 *  theory — sudoers doesn't quote them, so a plain split is faithful. */
function splitTopLevel(raw: string, sep: string): string[] {
  return raw.split(sep);
}

function parseLine(rawLine: string, sourceFile: string, lineNo: number): {
  kind: 'blank' | 'alias' | 'defaults' | 'rule';
  alias?: { kind: AliasKind; name: string; items: ListItem[] };
  rule?: SudoersRule;
  defaultsFlags?: string[];
  error?: string;
} {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#') && !/^#include(dir)?\s+\S+$/.test(trimmed)) {
    return { kind: 'blank' };
  }
  if (/^#include(dir)?\s+\S+$/.test(trimmed) || /^@include(dir)?\s+\S+$/.test(trimmed)) {
    return { kind: 'blank' };
  }

  const aliasMatch = /^(User_Alias|Host_Alias|Runas_Alias|Cmnd_Alias)\s+([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(trimmed);
  if (aliasMatch) {
    const [, kindRaw, name, rhs] = aliasMatch;
    if (!ALIAS_NAME_RE.test(name)) return { kind: 'alias', error: `invalid alias name '${name}'` };
    const items = parseListItems(rhs);
    if (!items) return { kind: 'alias', error: `invalid alias definition for '${name}'` };
    return { kind: 'alias', alias: { kind: kindRaw as AliasKind, name, items } };
  }

  if (/^Defaults\b/.test(trimmed)) {
    const rest = trimmed.slice('Defaults'.length).replace(/^[:@>][\w.\-]+/, '').trim();
    if (rest.length === 0) return { kind: 'defaults', error: 'empty Defaults entry' };
    return { kind: 'defaults', defaultsFlags: splitTopLevel(rest, ',').map((s) => s.trim()).filter(Boolean) };
  }

  const eq = trimmed.indexOf('=');
  if (eq === -1) return { kind: 'rule', error: `expected '=' (user host = privileges)` };
  const left = trimmed.slice(0, eq).trim();
  const right = trimmed.slice(eq + 1).trim();

  const leftParts = left.split(/\s+/);
  if (leftParts.length < 2) return { kind: 'rule', error: `expected 'user host' before '='` };
  const hostRaw = leftParts.pop()!;
  const userRaw = leftParts.join(' ');
  const users = parseListItems(userRaw);
  const hosts = parseListItems(hostRaw);
  if (!users) return { kind: 'rule', error: `invalid user list '${userRaw}'` };
  if (!hosts) return { kind: 'rule', error: `invalid host list '${hostRaw}'` };

  if (right.length === 0) return { kind: 'rule', error: `empty privilege specification after '='` };
  let privileges = right;
  let runasUsers: ListItem[] | null = null;
  let runasGroups: ListItem[] | null = null;
  const runasMatch = /^\(([^)]*)\)\s*/.exec(privileges);
  if (privileges.startsWith('(') && !runasMatch) return { kind: 'rule', error: `unbalanced parentheses in Runas list` };
  if (runasMatch) {
    const runasRaw = runasMatch[1].trim();
    if (runasRaw.length === 0) return { kind: 'rule', error: `empty Runas list` };
    const [usersPart, groupsPart] = splitRunas(runasRaw);
    runasUsers = parseListItems(usersPart);
    runasGroups = groupsPart !== null ? parseListItems(groupsPart) : null;
    if (!runasUsers) return { kind: 'rule', error: `invalid Runas list '${runasRaw}'` };
    privileges = privileges.slice(runasMatch[0].length);
  }

  const tags: RuleTags = {};
  const tagRe = /^(NOPASSWD|PASSWD|NOEXEC|EXEC|SETENV|NOSETENV|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT):\s*/;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(privileges))) {
    if (m[1] === 'NOPASSWD') tags.nopasswd = true;
    if (m[1] === 'PASSWD') tags.nopasswd = false;
    if (m[1] === 'NOEXEC') tags.noexec = true;
    privileges = privileges.slice(m[0].length);
  }

  const cmnds = parseListItems(privileges.trim());
  if (!cmnds) return { kind: 'rule', error: `invalid command list '${privileges.trim()}'` };

  return {
    kind: 'rule',
    rule: { users, hosts, runasUsers, runasGroups, tags, cmnds, sourceFile, lineNo },
  };
}

/** `(user1,user2:group1,group2)` — colon separates the runas-user part
 *  from an optional runas-group part. */
function splitRunas(raw: string): [string, string | null] {
  // Find a colon that isn't part of a bare `user:group` single-item form
  // consumed by LIST_ITEM_RE — for a runas list, a top-level `:` only
  // ever appears once, separating users from groups.
  const idx = raw.indexOf(':');
  if (idx === -1) return [raw, null];
  // A single `user:group` pair (no comma) is one runas *user* entry with
  // an inline primary-group override in real sudoers, not a users:groups
  // split — but for the simulator's needs (no per-entry group override),
  // treat a lone colon as the users/groups separator.
  return [raw.slice(0, idx), raw.slice(idx + 1)];
}

export function parseSudoersText(content: string, sourceFile: string): { parsed: ParsedSudoers; errors: SudoersParseError[] } {
  const aliases = emptyAliasTable();
  const rules: SudoersRule[] = [];
  const defaults: DefaultsConfig = { flags: new Set() };
  const errors: SudoersParseError[] = [];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const result = parseLine(lines[i], sourceFile, lineNo);
    if (result.error) {
      errors.push({ file: sourceFile, lineNo, message: result.error });
      continue;
    }
    if (result.kind === 'alias' && result.alias) {
      aliases[result.alias.kind].set(result.alias.name, result.alias.items);
    } else if (result.kind === 'defaults' && result.defaultsFlags) {
      for (const flag of result.defaultsFlags) {
        const kv = /^logfile\s*=\s*"?([^"]+)"?$/.exec(flag);
        if (kv) defaults.logfile = kv[1];
        else defaults.flags.add(flag);
      }
    } else if (result.kind === 'rule' && result.rule) {
      rules.push(result.rule);
    }
  }

  return { parsed: { aliases, rules, defaults }, errors };
}
