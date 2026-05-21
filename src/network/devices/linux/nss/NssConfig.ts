/**
 * NssConfig — model + parser for `/etc/nsswitch.conf`.
 *
 * Faithful to nsswitch.conf(5):
 *   - lines may be blank or comments (`#`)
 *   - the rest is `database: source [STATUS=action] source ...`
 *   - status tokens are space-tolerant inside the brackets
 *   - default actions: SUCCESS=return, NOTFOUND=continue,
 *     UNAVAIL=continue, TRYAGAIN=continue
 *
 * The config is a *projection* — `LinuxMachine` boot seeds the file with
 * the Ubuntu 22.04 defaults; admins can override via a real `echo > /etc/
 * nsswitch.conf` in the simulator. The resolver re-reads the projection
 * on each lookup (cheap, faithful to real getent which honours edits
 * immediately, and avoids stale cache headaches).
 */

import type {
  NssAction, NssDatabaseConfig, NssSourceSpec, NssStatus,
} from './types';

/**
 * Ubuntu 22.04 LTS default nsswitch.conf content. Verbatim from a fresh
 * install so the simulator's behaviour matches what users see on real
 * boxes. The resolver still reads the live file — this is only the seed.
 */
export const DEFAULT_NSSWITCH_CONF: string = [
  '# /etc/nsswitch.conf',
  '#',
  '# Example configuration of GNU Name Service Switch functionality.',
  '# If you have the `glibc-doc-reference\' and `info\' packages installed, try:',
  '# `info libc "Name Service Switch"\' for information about this file.',
  '',
  'passwd:         files systemd',
  'group:          files systemd',
  'shadow:         files',
  'gshadow:        files',
  '',
  'hosts:          files dns',
  'networks:       files',
  '',
  'protocols:      db files',
  'services:       db files',
  'ethers:         db files',
  'rpc:            db files',
  '',
  'netgroup:       nis',
  '',
].join('\n');

/** Per-database default action map, matching glibc. */
const DEFAULT_ACTIONS: Record<NssStatus, NssAction> = {
  SUCCESS: 'return',
  NOTFOUND: 'continue',
  UNAVAIL: 'continue',
  TRYAGAIN: 'continue',
};

/**
 * Parse the body of `/etc/nsswitch.conf`. Returns the list of database
 * declarations in file order. Malformed lines are silently dropped —
 * matches glibc's permissive behaviour (it logs to syslog and skips).
 */
export function parseNsswitchConf(content: string): NssDatabaseConfig[] {
  const result: NssDatabaseConfig[] = [];

  for (const rawLine of content.split('\n')) {
    // Strip everything after `#` so trailing comments are tolerated.
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const database = line.slice(0, colon).trim().toLowerCase();
    const sourceText = line.slice(colon + 1).trim();
    if (!database) continue;

    const sources = tokeniseSources(sourceText);
    if (sources.length === 0) continue;

    result.push({ database, sources });
  }

  return result;
}

/**
 * Tokenise the source list of a database line.
 *
 * Grammar:
 *   sources := source (whitespace source)*
 *   source  := name action-block?
 *   action-block := '[' rule (rule)* ']'
 *   rule    := '!'? STATUS '=' ACTION
 *
 * Names are lower-cased; status names are upper-cased, actions are
 * lower-cased — matches `getent` parsing in glibc.
 */
function tokeniseSources(text: string): NssSourceSpec[] {
  const out: NssSourceSpec[] = [];
  let i = 0;

  while (i < text.length) {
    // Skip whitespace.
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    // Source name — until whitespace or `[`.
    const nameStart = i;
    while (i < text.length && !/\s/.test(text[i]) && text[i] !== '[') i++;
    const name = text.slice(nameStart, i).toLowerCase();
    if (!name) break;

    // Optional [STATUS=action ...] block immediately after the name.
    const actions: Partial<Record<NssStatus, NssAction>> = {};
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '[') {
      const close = text.indexOf(']', i);
      if (close === -1) {
        // Malformed — consume the rest as the bracket body and stop.
        i = text.length;
      } else {
        const body = text.slice(i + 1, close).trim();
        for (const rule of body.split(/\s+/)) {
          const eq = rule.indexOf('=');
          if (eq === -1) continue;
          const statusRaw = rule.slice(0, eq).replace(/^!/, '').toUpperCase() as NssStatus;
          const actionRaw = rule.slice(eq + 1).toLowerCase() as NssAction;
          if (!isStatus(statusRaw) || !isAction(actionRaw)) continue;
          actions[statusRaw] = actionRaw;
        }
        i = close + 1;
      }
    }

    out.push({ name, actions });
  }

  return out;
}

function isStatus(s: string): s is NssStatus {
  return s === 'SUCCESS' || s === 'NOTFOUND' || s === 'UNAVAIL' || s === 'TRYAGAIN';
}

function isAction(s: string): s is NssAction {
  return s === 'return' || s === 'continue' || s === 'merge';
}

/**
 * Resolve the action for a given status on a source spec, falling back
 * to the glibc-defined defaults when the spec is silent.
 */
export function effectiveAction(spec: NssSourceSpec, status: NssStatus): NssAction {
  return spec.actions[status] ?? DEFAULT_ACTIONS[status];
}

/** Hard-coded fallback config used when `/etc/nsswitch.conf` is missing. */
export const FALLBACK_CONFIG: ReadonlyArray<NssDatabaseConfig> = [
  { database: 'passwd',    sources: [{ name: 'files', actions: {} }] },
  { database: 'group',     sources: [{ name: 'files', actions: {} }] },
  { database: 'shadow',    sources: [{ name: 'files', actions: {} }] },
  { database: 'gshadow',   sources: [{ name: 'files', actions: {} }] },
  { database: 'hosts',     sources: [{ name: 'files', actions: {} }, { name: 'dns', actions: {} }] },
  { database: 'networks',  sources: [{ name: 'files', actions: {} }] },
  { database: 'services',  sources: [{ name: 'files', actions: {} }] },
  { database: 'protocols', sources: [{ name: 'files', actions: {} }] },
  { database: 'ethers',    sources: [{ name: 'files', actions: {} }] },
  { database: 'rpc',       sources: [{ name: 'files', actions: {} }] },
  { database: 'netgroup',  sources: [{ name: 'files', actions: {} }] },
];

/**
 * Lookup the source list for a database in a parsed config. Falls back
 * to the FALLBACK_CONFIG entry, or to a single `files` source when the
 * database is unknown — never returns an empty list so callers can
 * always iterate.
 */
export function sourcesFor(
  parsed: ReadonlyArray<NssDatabaseConfig>,
  database: string,
): NssSourceSpec[] {
  const direct = parsed.find(c => c.database === database);
  if (direct) return direct.sources;

  // `ahosts*` aliases all inherit the `hosts` line on real Linux.
  if (database === 'ahosts' || database === 'ahostsv4' || database === 'ahostsv6') {
    const hosts = parsed.find(c => c.database === 'hosts');
    if (hosts) return hosts.sources;
  }

  // `initgroups` inherits `group` when missing (glibc default).
  if (database === 'initgroups') {
    const groups = parsed.find(c => c.database === 'group');
    if (groups) return groups.sources;
  }

  const fallback = FALLBACK_CONFIG.find(c => c.database === database);
  return fallback ? [...fallback.sources] : [{ name: 'files', actions: {} }];
}
