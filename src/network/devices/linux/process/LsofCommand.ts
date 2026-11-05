import { renderTableText, LSOF_TABLE, type TableColumn } from '@/network/devices/shells/cli/TextTable';

export interface LsofInet {
  readonly protocol: 'tcp' | 'udp';
  readonly family: 4 | 6;
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: string;
}

export interface LsofRow {
  readonly command: string;
  readonly pid: number;
  readonly uid: number;
  readonly user: string;
  readonly fd: string;
  readonly access: string;
  readonly type: string;
  readonly device: string;
  readonly sizeOff: string;
  readonly node: string;
  readonly name: string;
  readonly inet?: LsofInet;
}

export interface LsofHost {
  uidOf(name: string): number | null;
  fileExists(path: string): boolean;
  absolute(path: string): string;
}

export interface LsofRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const USAGE = [
  'lsof 4.95.0',
  ' latest revision: https://github.com/lsof-org/lsof',
  ' latest FAQ: https://github.com/lsof-org/lsof/blob/master/00FAQ',
  ' latest (non-formatted) man page: https://github.com/lsof-org/lsof/blob/master/Lsof.8',
  ' usage: [-?abhKlnNoOPRtUvVX] [+|-c c] [+|-d s] [+D D] [+|-E] [+|-e s] [+|-f[gG]]',
  ' [-F [f]] [-g [s]] [-i [i]] [+|-L [l]] [+m [m]] [+|-M] [-o [o]] [-p s]',
  ' [+|-r [t]] [-s [p:s]] [-S [t]] [-T [t]] [-u s] [+|-w] [-x [fl]] [--] [names]',
];

const HELP = [
  "lsof 4.95.0",
  " latest revision: https://github.com/lsof-org/lsof",
  " latest FAQ: https://github.com/lsof-org/lsof/blob/master/00FAQ",
  " latest (non-formatted) man page: https://github.com/lsof-org/lsof/blob/master/Lsof.8",
  " usage: [-?abhKlnNoOPRtUvVX] [+|-c c] [+|-d s] [+D D] [+|-E] [+|-e s] [+|-f[gG]]",
  " [-F [f]] [-g [s]] [-i [i]] [+|-L [l]] [+m [m]] [+|-M] [-o [o]] [-p s]",
  " [+|-r [t]] [-s [p:s]] [-S [t]] [-T [t]] [-u s] [+|-w] [-x [fl]] [--] [names]",
  "Defaults in parentheses; comma-separated set (s) items; dash-separated ranges.",
  "  -?|-h list help          -a AND selections (OR)     -b avoid kernel blocks",
  "  -c c  cmd c ^c /c/[bix]  +c w  COMMAND width (9)    +d s  dir s files",
  "  -d s  select by FD set   +D D  dir D tree *SLOW?*   +|-e s  exempt s *RISKY*",
  "  -i select IPv[46] files  -K [i] list|(i)gn tasKs    -l list UID numbers",
  "  -n no host names         -N select NFS files        -o list file offset",
  "  -O no overhead *RISKY*   -P no port names           -Q allow failed search",
  "  -R list paRent PID       -s list file size          -t terse listing",
  "  -T disable TCP/TPI info  -U select Unix socket      -v list version info",
  "  -V verbose search        +|-w  Warnings (+)         -X skip TCP&UDP* files",
  "  -Z Z  context [Z]        -- end option scan       ",
  "  -E display endpoint info              +E display endpoint info and files",
  "  +f|-f  +filesystem or -file names     +|-f[gG] flaGs ",
  "  -F [f] select fields; -F? for help  ",
  "  +|-L [l] list (+) suppress (-) link counts < l (0 = all; default = 0)",
  "                                        +m [m] use|create mount supplement",
  "  +|-M   portMap registration (-)       -o o   o 0t offset digits (8)",
  "  -p s   exclude(^)|select PIDs         -S [t] t second stat timeout (15)",
  "  -T fqs TCP/TPI Fl,Q,St (s) info",
  "  -g [s] exclude(^)|select and print process group IDs",
  "  -i i   select by IPv[46] address: [46][proto][@host|addr][:svc_list|port_list]",
  "  +|-r [t[m<fmt>]] repeat every t seconds (15);  + until no files, - forever.",
  "       An optional suffix to t is m<fmt>; m must separate t from <fmt> and",
  "      <fmt> is an strftime(3) format for the marker line.",
  "  -s p:s  exclude(^)|select protocol (p = TCP|UDP) states by name(s).",
  "  -u s   exclude(^)|select login|UID set s",
  "  -x [fl] cross over +d|+D File systems or symbolic Links",
  "  names  select named files or files on named file systems",
  "Anyone can list all files; /dev warnings disabled; kernel ID check disabled."
];

const SERVICES: Readonly<Record<string, number>> = {
  ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, http: 80, pop3: 110, ntp: 123, imap: 143, snmp: 161, ldap: 389, https: 443, syslog: 514, imaps: 993, pop3s: 995, mysql: 3306, postgresql: 5432,
};
const TCP_STATES = ['CLOSED', 'IDLE', 'BOUND', 'LISTEN', 'SYN_SENT', 'SYN_RCVD', 'ESTABLISHED', 'CLOSE_WAIT', 'FIN_WAIT1', 'CLOSING', 'LAST_ACK', 'FIN_WAIT2', 'TIME_WAIT'];
const FIELD_LETTERS = 'acCdDfFgGikKlLmnNopPrRsStTuz0';
const COMMAND_WIDTH = 9;

interface InetSpec { family: 4 | 6 | null; protocol: 'tcp' | 'udp' | null; host: string | null; ports: Array<[number, number]> | null }

interface Selection {
  and: boolean;
  terse: boolean;
  fields: string | null;
  fieldNul: boolean;
  pids: Set<number>;
  excludedPids: Set<number>;
  uids: Set<number>;
  excludedUids: Set<number>;
  commands: Array<{ test: (name: string) => boolean; exclude: boolean }>;
  inet: InetSpec[] | null;
  fds: Array<{ from: string; to: string | null; exclude: boolean }>;
  files: string[];
  directories: Array<{ path: string; recursive: boolean }>;
  unixOnly: boolean;
  states: { include: Set<string>; exclude: Set<string> } | null;
  errors: string[];
}

class LsofError extends Error {}

function fail(message: string): never {
  throw new LsofError(message);
}

function parseInet(text: string, shown: string): InetSpec {
  const match = /^(4|6)?(tcp|udp)?(?:@([^:]*))?(?::(.*))?$/i.exec(text);
  if (match === null) fail(`unknown protocol name (${text}) in: ${shown}`);
  const rest = text.replace(/^(4|6)?/, '');
  if (match[2] === undefined && rest !== '' && !rest.startsWith('@') && !rest.startsWith(':')) fail(`unknown protocol name (${rest.split(/[@:]/)[0]}) in: ${shown}`);
  let ports: Array<[number, number]> | null = null;
  if (match[4] !== undefined && match[4] !== '') {
    ports = [];
    for (const part of match[4].split(',')) {
      const range = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (range !== null) ports.push([Number(range[1]), Number(range[2] ?? range[1])]);
      else if (SERVICES[part] !== undefined) ports.push([SERVICES[part], SERVICES[part]]);
      else fail(`unknown service ${part}${match[2] === undefined ? '' : ` for ${match[2].toLowerCase()}`} in: ${shown}`);
    }
  }
  if (match[3] !== undefined && match[3] !== '' && !/^(\d{1,3}(\.\d{1,3}){3}|localhost|\*|\[.*\]|[0-9a-fA-F:]+)$/.test(match[3])) fail(`unknown host name (${match[3]}) in: ${shown}`);
  return { family: match[1] === undefined ? null : Number(match[1]) as 4 | 6, protocol: match[2] === undefined ? null : match[2].toLowerCase() as 'tcp' | 'udp', host: match[3] === undefined || match[3] === '' ? null : match[3], ports };
}

function parseSelection(args: readonly string[], host: LsofHost): Selection {
  const selection: Selection = {
    and: false, terse: false, fields: null, fieldNul: false, pids: new Set(), excludedPids: new Set(), uids: new Set(), excludedUids: new Set(),
    commands: [], inet: null, fds: [], files: [], directories: [], unixOnly: false, states: null, errors: [],
  };
  let crossOver = false;
  let optionsEnded = false;
  let wantsHelp = false;
  const take = (index: number, attached: string, missing: string): { value: string; next: number } => {
    if (attached !== '') return { value: attached, next: index };
    if (index + 1 >= args.length) fail(missing);
    return { value: args[index + 1], next: index + 1 };
  };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (optionsEnded || !(token.startsWith('-') || token.startsWith('+')) || token === '-' || token === '+') {
      selection.files.push(token);
      optionsEnded = true;
      continue;
    }
    if (token === '--') { optionsEnded = true; continue; }
    const sign = token[0];
    for (let at = 1; at < token.length; at++) {
      const letter = token[at];
      const attached = token.slice(at + 1);
      if (sign === '+' && (letter === 'D' || letter === 'd')) {
        const { value, next } = take(index, attached, '+d not followed by a directory path');
        index = next;
        if (!host.fileExists(value)) fail(`WARNING: can't stat(${value}): No such file or directory`);
        selection.directories.push({ path: value, recursive: letter === 'D' });
        break;
      }
      if (sign === '+') continue;
      switch (letter) {
        case 'a': selection.and = true; break;
        case 't': selection.terse = true; break;
        case 'U': selection.unixOnly = true; break;
        case 'x': crossOver = true; if (attached !== '' && /^[fl]+$/.test(attached)) at = token.length; break;
        case 'p': {
          const { value, next } = take(index, attached, 'no process ID specified');
          index = next;
          for (const part of value.split(',')) {
            const excluded = part.startsWith('^');
            const number = part.replace(/^\^/, '');
            if (!/^\d+$/.test(number)) fail(`illegal process ID: ${part}`);
            (excluded ? selection.excludedPids : selection.pids).add(Number(number));
          }
          at = token.length;
          break;
        }
        case 'u': {
          const { value, next } = take(index, attached, 'no UIDs specified');
          index = next;
          for (const part of value.split(',')) {
            const excluded = part.startsWith('^');
            const name = part.replace(/^\^/, '');
            const uid = /^\d+$/.test(name) ? Number(name) : host.uidOf(name);
            if (uid === null) fail(`can't get UID for ${name}`);
            if (excluded) {
              if (selection.uids.has(uid)) fail(`UID ${uid} has been included and excluded.`);
              selection.excludedUids.add(uid);
            } else {
              if (selection.excludedUids.has(uid)) fail(`UID ${uid} has been included and excluded.`);
              selection.uids.add(uid);
            }
          }
          at = token.length;
          break;
        }
        case 'c': {
          const { value, next } = take(index, attached, 'missing -c option value');
          index = next;
          const exclude = value.startsWith('^');
          const pattern = exclude ? value.slice(1) : value;
          if (pattern.startsWith('/')) {
            const close = pattern.lastIndexOf('/');
            if (close === 0) fail(`regexp doesn't end with '/': ${pattern}`);
            const expression = new RegExp(pattern.slice(1, close), pattern.slice(close + 1).includes('i') ? 'i' : '');
            selection.commands.push({ test: (name) => expression.test(name), exclude });
          } else selection.commands.push({ test: (name) => name.startsWith(pattern), exclude });
          at = token.length;
          break;
        }
        case 'd': {
          const { value, next } = take(index, attached, 'no file descriptor specified');
          index = next;
          for (const part of value.split(',')) {
            const exclude = part.startsWith('^');
            const body = part.replace(/^\^/, '');
            const range = /^(\d+)-(\d+)$/.exec(body);
            selection.fds.push(range === null ? { from: body, to: null, exclude } : { from: range[1], to: range[2], exclude });
          }
          at = token.length;
          break;
        }
        case 'i': {
          let value = attached;
          if (value === '' && index + 1 < args.length && !/^[-+]/.test(args[index + 1])) value = args[++index];
          selection.inet = [...(selection.inet ?? []), ...(value === '' ? [{ family: null, protocol: null, host: null, ports: null } as InetSpec] : [parseInet(value, `-i ${value}`)])];
          at = token.length;
          break;
        }
        case 's': {
          const { value, next } = take(index, attached, 'no protocol state specified');
          index = next;
          const match = /^([A-Za-z]+):(.*)$/.exec(value);
          if (match === null) fail(`unknown -s protocol: "${value}"`);
          const protocol = match[1].toUpperCase();
          if (protocol === 'UDP') fail(`no UDP state names available: ${value}`);
          if (protocol !== 'TCP') fail(`unknown -s protocol: "${value}"`);
          selection.states ??= { include: new Set(), exclude: new Set() };
          for (const part of match[2].split(',')) {
            const exclude = part.startsWith('^');
            const state = part.replace(/^\^/, '').toUpperCase();
            if (!TCP_STATES.includes(state)) fail(`unknown TCP state name: ${part.replace(/^\^/, '')}`);
            (exclude ? selection.states.exclude : selection.states.include).add(state);
          }
          at = token.length;
          break;
        }
        case 'F': {
          let value = attached;
          if (value === '' && index + 1 < args.length && !/^[-+]/.test(args[index + 1])) value = args[++index];
          selection.fields = value;
          for (const character of value) {
            if (!FIELD_LETTERS.includes(character)) fail(`unknown field: ${character}`);
          }
          selection.fieldNul = value.includes('0');
          at = token.length;
          break;
        }
        case 'h': case '?': wantsHelp = true; break;
        case 'Z': return fail('-Z limited to SELinux');
        case 'g': {
          let value = attached;
          if (value === '' && index + 1 < args.length && !/^[-+]/.test(args[index + 1])) value = args[++index];
          for (const part of value === '' ? [] : value.split(',')) {
            if (!/^\^?\d+$/.test(part)) selection.errors.push(`illegal process group ID: ${part}`);
          }
          at = token.length;
          break;
        }
        case 'o': {
          at += (/^\d*/.exec(attached)?.[0] ?? '').length;
          break;
        }
        case 'e': case 'T': case 'S': case 'r': case 'L': case 'm': case 'M': case 'f':
          if (attached !== '') at = token.length;
          break;
        case 'l': case 'n': case 'P': case 'R': case 'V': case 'w': case 'b': case 'O': case 'Q': case 'N': case 'X': case 'K': case 'v': case 'E': break;
        default: selection.errors.push(`illegal option character: ${letter}`);
      }
    }
  }
  if (selection.errors.length > 0) fail(selection.errors.join('\nlsof: '));
  if (wantsHelp) fail('__help__');
  if (crossOver && selection.directories.length === 0) fail('-x must accompany +d or +D');
  if (selection.and && !hasSelectors(selection)) fail('no select options to AND via -a');
  return selection;
}

function hasSelectors(selection: Selection): boolean {
  return selection.pids.size + selection.excludedPids.size + selection.uids.size + selection.excludedUids.size + selection.commands.length
    + selection.fds.length + selection.files.length + selection.directories.length > 0 || selection.inet !== null || selection.unixOnly;
}

function inetMatches(spec: InetSpec, inet: LsofInet): boolean {
  if (spec.family !== null && spec.family !== inet.family) return false;
  if (spec.protocol !== null && spec.protocol !== inet.protocol) return false;
  if (spec.host !== null && ![inet.localAddress, inet.remoteAddress].includes(spec.host)) return false;
  if (spec.ports !== null && !spec.ports.some(([low, high]) => (inet.localPort >= low && inet.localPort <= high) || (inet.remotePort >= low && inet.remotePort <= high))) return false;
  return true;
}

function fdMatches(entry: Selection['fds'][number], row: LsofRow): boolean {
  if (entry.to === null) return row.fd === entry.from;
  const number = Number(row.fd);
  return Number.isInteger(number) && number >= Number(entry.from) && number <= Number(entry.to);
}

function stateAllows(selection: Selection, row: LsofRow): boolean {
  if (selection.states === null || row.inet === undefined || row.inet.protocol !== 'tcp') return true;
  if (selection.states.exclude.has(row.inet.state)) return false;
  return selection.states.include.size === 0 || selection.states.include.has(row.inet.state);
}

function selected(selection: Selection, row: LsofRow, host: LsofHost): boolean {
  if (!stateAllows(selection, row)) return false;
  const tests: boolean[] = [];
  if (selection.pids.size > 0) tests.push(selection.pids.has(row.pid));
  if (selection.uids.size > 0) tests.push(selection.uids.has(row.uid));
  const positiveCommands = selection.commands.filter((entry) => !entry.exclude);
  if (positiveCommands.length > 0) tests.push(positiveCommands.some((entry) => entry.test(row.command)));
  const positiveFds = selection.fds.filter((entry) => !entry.exclude);
  if (positiveFds.length > 0) tests.push(positiveFds.some((entry) => fdMatches(entry, row)));
  if (selection.inet !== null) tests.push(row.inet !== undefined && selection.inet.some((spec) => inetMatches(spec, row.inet as LsofInet)));
  if (selection.unixOnly) tests.push(row.type === 'unix');
  if (selection.files.length > 0) tests.push(selection.files.some((file) => row.name === host.absolute(file) || row.name.startsWith(`${host.absolute(file)} (`)));
  if (selection.directories.length > 0) {
    tests.push(selection.directories.some((entry) => {
      const base = host.absolute(entry.path).replace(/\/$/, '');
      if (!row.name.startsWith(`${base}/`)) return false;
      return entry.recursive || !row.name.slice(base.length + 1).includes('/');
    }));
  }
  const excluded = selection.excludedPids.has(row.pid) || selection.excludedUids.has(row.uid)
    || selection.commands.some((entry) => entry.exclude && entry.test(row.command))
    || selection.fds.some((entry) => entry.exclude && fdMatches(entry, row));
  if (excluded) return false;
  if (tests.length === 0) return true;
  return selection.and ? tests.every(Boolean) : tests.some(Boolean);
}

function renderTable(rows: readonly LsofRow[]): string {
  const fdWidth = Math.max(2, ...rows.map((r) => r.fd.length + 2));
  const columns: TableColumn<LsofRow>[] = [
    { header: 'COMMAND', value: (r) => r.command.slice(0, COMMAND_WIDTH) },
    { header: 'PID', align: 'right', value: (r) => String(r.pid) },
    { header: 'USER', align: 'right', value: (r) => r.user },
    { header: `${'FD'.padStart(fdWidth - 2)}  `, value: (r) => `${r.fd.padStart(fdWidth - 2)}${r.access} ` },
    { header: 'TYPE', align: 'right', value: (r) => r.type },
    { header: 'DEVICE', align: 'right', value: (r) => r.device },
    { header: 'SIZE/OFF', align: 'right', value: (r) => r.sizeOff },
    { header: 'NODE', align: 'right', value: (r) => r.node },
    { header: 'NAME', value: (r) => r.name },
  ];
  return renderTableText(rows, columns, LSOF_TABLE);
}

const FIELD_VALUES: Readonly<Record<string, (row: LsofRow) => string>> = {
  c: (row) => row.command, u: (row) => String(row.uid), L: (row) => row.user, f: (row) => row.fd, a: (row) => row.access.trim(), t: (row) => row.type,
  D: (row) => row.device, s: (row) => row.sizeOff.replace(/^0t/, ''), i: (row) => row.node, n: (row) => row.name,
};

function renderFields(selection: Selection, rows: readonly LsofRow[]): string {
  const letters = selection.fields === '' || selection.fields === null ? 'pgRcuLfatDsin' : selection.fields.replace(/0/g, '');
  const terminator = selection.fieldNul ? '\0' : '\n';
  const lines: string[] = [];
  let currentPid = -1;
  for (const row of rows) {
    if (row.pid !== currentPid) {
      currentPid = row.pid;
      if (letters.includes('p')) lines.push(`p${row.pid}`);
      for (const letter of letters) {
        if (letter === 'g') lines.push('g0');
        if (letter === 'R') lines.push('R0');
        if ('cuL'.includes(letter)) lines.push(`${letter}${FIELD_VALUES[letter](row)}`);
      }
    }
    for (const letter of letters) if ('fatDsin'.includes(letter)) lines.push(`${letter}${FIELD_VALUES[letter](row)}`);
  }
  return lines.map((line) => `${line}${terminator}`).join('').replace(/\n$/, '');
}

function hasOtherSelectors(selection: Selection): boolean {
  return selection.pids.size + selection.uids.size + selection.commands.length + selection.fds.length + selection.directories.length > 0 || selection.inet !== null || selection.unixOnly;
}

export function runLsof(args: readonly string[], rows: readonly LsofRow[], host: LsofHost): LsofRun {
  let selection: Selection;
  try {
    selection = parseSelection(args, host);
  } catch (error) {
    if (!(error instanceof LsofError)) throw error;
    if (error.message === '__help__') return { stdout: '', stderr: `${HELP.join('\n')}\n`, exitCode: 0 };
    return { stdout: '', stderr: `lsof: ${error.message}\n${USAGE.join('\n')}\nUse the \`\`-h'' option to get more help information.\n`, exitCode: 1 };
  }
  const missing = selection.files.filter((file) => !host.fileExists(file));
  const diagnostics = missing.map((file) => `lsof: status error on ${file}: No such file or directory\n`).join('');
  const chosen = rows.filter((row) => selected(selection, row, host));
  if (chosen.length === 0 || (missing.length === selection.files.length && selection.files.length > 0 && !hasOtherSelectors(selection))) {
    return { stdout: '', stderr: diagnostics, exitCode: 1 };
  }
  let stdout: string;
  if (selection.fields !== null) stdout = renderFields(selection, chosen);
  else if (selection.terse) stdout = [...new Set(chosen.map((row) => row.pid))].join('\n');
  else stdout = renderTable(chosen);
  return { stdout, stderr: diagnostics, exitCode: missing.length > 0 ? 1 : 0 };
}
