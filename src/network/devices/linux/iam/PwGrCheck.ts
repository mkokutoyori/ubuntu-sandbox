/**
 * PwGrCheck — real file-content validation backing `pwck`, `grpck`, and
 * `visudo -c`.
 *
 * Unlike the rest of the IAM layer (which reasons about in-memory
 * `LinuxUserAccount`/`LinuxGroup` objects and projects them onto the VFS),
 * these checks re-parse the *live file content* on every call — exactly
 * like the real coreutils/shadow-utils tools, which have no in-memory
 * account cache to fall back on. This is what lets a test hand-edit
 * `/etc/passwd` (e.g. `echo` a duplicate line) and have `pwck` actually
 * catch it, instead of validating a model that never saw the edit.
 */

import type { VirtualFileSystem } from '../VirtualFileSystem';
import { IAM_PATHS } from './fs/IamPaths';

export interface CheckResult {
  lines: string[];
  exitCode: number;
}

function splitLines(content: string): string[] {
  return content.split('\n').filter((l) => l.length > 0);
}

interface PasswdEntry {
  lineNo: number;
  raw: string;
  name: string;
  uid: string;
  gid: string;
  shell: string;
}

function parsePasswd(content: string): { entries: PasswdEntry[]; malformed: number[] } {
  const entries: PasswdEntry[] = [];
  const malformed: number[] = [];
  splitLines(content).forEach((raw, i) => {
    const fields = raw.split(':');
    if (fields.length !== 7) { malformed.push(i + 1); return; }
    const [name, , uid, gid, , , shell] = fields;
    entries.push({ lineNo: i + 1, raw, name, uid, gid, shell });
  });
  return { entries, malformed };
}

interface ShadowEntry {
  lineNo: number;
  name: string;
  password: string;
}

function parseShadow(content: string): { entries: ShadowEntry[]; malformed: number[] } {
  const entries: ShadowEntry[] = [];
  const malformed: number[] = [];
  splitLines(content).forEach((raw, i) => {
    const fields = raw.split(':');
    if (fields.length !== 9) { malformed.push(i + 1); return; }
    entries.push({ lineNo: i + 1, name: fields[0], password: fields[1] });
  });
  return { entries, malformed };
}

/**
 * `pwck -r` — cross-checks `/etc/passwd` against `/etc/shadow`: field
 * counts, duplicate usernames/UIDs, and entries missing on either side.
 * Read-only in this simulator (no interactive fix prompts), matching the
 * `-r` flag's real meaning.
 */
export function checkPwck(vfs: VirtualFileSystem): CheckResult {
  const lines: string[] = [];
  let hasError = false;

  const passwdContent = vfs.readFile(IAM_PATHS.passwd) ?? '';
  const shadowContent = vfs.readFile(IAM_PATHS.shadow) ?? '';
  const { entries: passwdEntries, malformed: passwdMalformed } = parsePasswd(passwdContent);
  const { entries: shadowEntries, malformed: shadowMalformed } = parseShadow(shadowContent);

  for (const lineNo of passwdMalformed) {
    lines.push(`pwck: invalid password file entry, line ${lineNo}`);
    hasError = true;
  }
  for (const lineNo of shadowMalformed) {
    lines.push(`pwck: invalid shadow file entry, line ${lineNo}`);
    hasError = true;
  }

  const seenNames = new Map<string, number>();
  for (const e of passwdEntries) {
    const prior = seenNames.get(e.name);
    if (prior !== undefined) {
      lines.push(`pwck: duplicate password entry: ${e.name} (lines ${prior} and ${e.lineNo})`);
      hasError = true;
    } else {
      seenNames.set(e.name, e.lineNo);
    }
  }

  const seenUids = new Map<string, string[]>();
  for (const e of passwdEntries) {
    const names = seenUids.get(e.uid) ?? [];
    names.push(e.name);
    seenUids.set(e.uid, names);
  }
  for (const [uid, names] of seenUids) {
    if (names.length > 1) {
      lines.push(`pwck: duplicate uid ${uid} in /etc/passwd (${names.join(', ')})`);
      hasError = true;
    }
  }

  const shadowNames = new Set(shadowEntries.map((e) => e.name));
  for (const e of passwdEntries) {
    if (!shadowNames.has(e.name)) {
      lines.push(`pwck: user '${e.name}' in /etc/passwd but not in /etc/shadow`);
      hasError = true;
    }
  }
  const passwdNames = new Set(passwdEntries.map((e) => e.name));
  for (const e of shadowEntries) {
    if (!passwdNames.has(e.name)) {
      lines.push(`pwck: user '${e.name}' in /etc/shadow but not in /etc/passwd`);
      hasError = true;
    }
  }

  if (!hasError) lines.push('pwck: no errors');
  return { lines, exitCode: hasError ? 1 : 0 };
}

interface GroupEntryLine {
  lineNo: number;
  name: string;
  gid: string;
  members: string[];
}

function parseGroup(content: string): { entries: GroupEntryLine[]; malformed: number[] } {
  const entries: GroupEntryLine[] = [];
  const malformed: number[] = [];
  splitLines(content).forEach((raw, i) => {
    const fields = raw.split(':');
    if (fields.length !== 4) { malformed.push(i + 1); return; }
    const [name, , gid, membersField] = fields;
    const members = membersField ? membersField.split(',').filter((m) => m.length > 0) : [];
    entries.push({ lineNo: i + 1, name, gid, members });
  });
  return { entries, malformed };
}

/**
 * `grpck` — cross-checks `/etc/group` against `/etc/gshadow` and
 * `/etc/passwd`: field counts, duplicate names/GIDs, entries missing on
 * either side, and members referencing unknown users.
 */
export function checkGrpck(vfs: VirtualFileSystem): CheckResult {
  const lines: string[] = [];
  let hasError = false;

  const groupContent = vfs.readFile(IAM_PATHS.group) ?? '';
  const gshadowContent = vfs.readFile(IAM_PATHS.gshadow) ?? '';
  const passwdContent = vfs.readFile(IAM_PATHS.passwd) ?? '';
  const { entries: groupEntries, malformed: groupMalformed } = parseGroup(groupContent);
  const gshadowNames = new Set(
    splitLines(gshadowContent).map((raw) => raw.split(':')[0]).filter((n) => n),
  );
  const passwdNames = new Set(parsePasswd(passwdContent).entries.map((e) => e.name));

  for (const lineNo of groupMalformed) {
    lines.push(`grpck: invalid group file entry, line ${lineNo}`);
    hasError = true;
  }

  const seenNames = new Map<string, number>();
  const seenGids = new Map<string, string[]>();
  for (const e of groupEntries) {
    const prior = seenNames.get(e.name);
    if (prior !== undefined) {
      lines.push(`grpck: duplicate group entry: ${e.name} (lines ${prior} and ${e.lineNo})`);
      hasError = true;
    } else {
      seenNames.set(e.name, e.lineNo);
    }
    const names = seenGids.get(e.gid) ?? [];
    names.push(e.name);
    seenGids.set(e.gid, names);

    if (!gshadowNames.has(e.name)) {
      lines.push(`grpck: group '${e.name}' in /etc/group but not in /etc/gshadow`);
      hasError = true;
    }
    for (const member of e.members) {
      if (!passwdNames.has(member)) {
        lines.push(`grpck: group '${e.name}': unknown member '${member}'`);
        hasError = true;
      }
    }
  }
  for (const [gid, names] of seenGids) {
    if (names.length > 1) {
      lines.push(`grpck: duplicate gid ${gid} in /etc/group (${names.join(', ')})`);
      hasError = true;
    }
  }

  if (!hasError) lines.push('grpck: no errors');
  return { lines, exitCode: hasError ? 1 : 0 };
}

const SUDOERS_TAG =
  '(?:NOPASSWD|PASSWD|NOEXEC|EXEC|SETENV|NOSETENV|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT)';
const NAME_RE = String.raw`!?%?[\w.\-]+`;
const LIST_RE = (item: string) => new RegExp(`^${item}(?:\\s*,\\s*${item})*$`);
const USER_LIST_RE = LIST_RE(NAME_RE);
const HOST_LIST_RE = LIST_RE(NAME_RE);
const ALIAS_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const CMND_ITEM_RE = String.raw`!?(?:ALL|[A-Z][A-Z0-9_]*|/\S+(?:\s+\S+)*)`;
const CMND_LIST_RE = LIST_RE(CMND_ITEM_RE);
const RUNAS_ITEM_RE = String.raw`!?%?[\w.\-]+(?::!?%?[\w.\-]+)?`;
const RUNAS_LIST_RE = LIST_RE(RUNAS_ITEM_RE);

/**
 * Validate a single non-comment, non-blank sudoers line. Returns an error
 * message, or `null` if the line is well-formed. Covers alias definitions
 * (`User_Alias`/`Host_Alias`/`Runas_Alias`/`Cmnd_Alias`), `Defaults` lines,
 * `#include`/`#includedir`/`@include`/`@includedir` directives, and the
 * core `user host = (runas) TAG: cmnd` privilege spec — the sudoers
 * constructs that actually appear in real-world files. Multiple chained
 * cmndspecs on one line (`user host = (a) cmd1 : (b) cmd2`) are not
 * supported; each is written as its own line instead, matching common
 * `visudo`-formatted style.
 */
export function validateSudoersLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (/^#include(dir)?\s+\S+$/.test(trimmed)) return null;
  if (/^@include(dir)?\s+\S+$/.test(trimmed)) return null;
  if (trimmed.startsWith('#')) return null;

  const aliasMatch = /^(User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias)\s+(\S+)\s*=\s*(.+)$/.exec(trimmed);
  if (aliasMatch) {
    const [, , aliasName, rhs] = aliasMatch;
    if (!ALIAS_NAME_RE.test(aliasName)) return `invalid alias name '${aliasName}'`;
    if (rhs.trim().length === 0) return `empty alias definition for '${aliasName}'`;
    return null;
  }

  if (/^Defaults\b/.test(trimmed)) {
    const rest = trimmed.slice('Defaults'.length);
    if (rest.length > 0 && !/^[:@>]/.test(rest) && !/^\s/.test(rest)) {
      return `malformed Defaults entry`;
    }
    const params = rest.replace(/^[:@>][\w.\-]+/, '').trim();
    if (params.length === 0) return `empty Defaults entry`;
    return null;
  }

  const eq = trimmed.indexOf('=');
  if (eq === -1) return `expected '=' (user host = privileges)`;
  const left = trimmed.slice(0, eq).trim();
  const right = trimmed.slice(eq + 1).trim();

  const leftParts = left.split(/\s+/);
  if (leftParts.length < 2) return `expected 'user host' before '='`;
  const hostPart = leftParts.pop()!;
  const userPart = leftParts.join(' ');
  if (!USER_LIST_RE.test(userPart)) return `invalid user list '${userPart}'`;
  if (!HOST_LIST_RE.test(hostPart)) return `invalid host list '${hostPart}'`;

  if (right.length === 0) return `empty privilege specification after '='`;
  let privileges = right;
  const runasMatch = /^\(([^)]*)\)\s*/.exec(privileges);
  if (privileges.startsWith('(') && !runasMatch) return `unbalanced parentheses in Runas list`;
  if (runasMatch) {
    const runas = runasMatch[1].trim();
    if (runas.length === 0) return `empty Runas list`;
    if (!RUNAS_LIST_RE.test(runas)) return `invalid Runas list '${runas}'`;
    privileges = privileges.slice(runasMatch[0].length);
  }

  privileges = privileges.replace(new RegExp(`^(?:${SUDOERS_TAG}:\\s*)+`), '');
  if (privileges.trim().length === 0) return `missing command list`;
  if (!CMND_LIST_RE.test(privileges.trim())) return `invalid command list '${privileges.trim()}'`;

  return null;
}

/**
 * Syntax-check sudoers-style content line by line. Shared by `visudo -c`
 * (reads from the VFS) and interactive `visudo` (validates an edited
 * buffer before it's ever written to the real file) — both must apply
 * the exact same rules, or a save that `visudo -c` would reject could
 * slip through the interactive path and corrupt the real sudoers file.
 */
export function validateSudoersContent(content: string, path: string): CheckResult {
  const rawLines = content.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const error = validateSudoersLine(rawLines[i]);
    if (error) {
      return {
        lines: [`>>> ${path}: syntax error near line ${i + 1} <<<`, error],
        exitCode: 1,
      };
    }
  }
  return { lines: [`${path}: parsed OK`], exitCode: 0 };
}

/**
 * `visudo -c -f <path>` — syntax-checks a sudoers-style file without
 * modifying it. Reports the first syntax error's line number, matching
 * real `visudo -c` behaviour (`>>> path: syntax error near line N <<<`).
 */
export function checkSudoersFile(vfs: VirtualFileSystem, path: string): CheckResult {
  const content = vfs.readFile(path);
  if (content === null) {
    return { lines: [`visudo: ${path}: No such file or directory`], exitCode: 1 };
  }
  return validateSudoersContent(content, path);
}
