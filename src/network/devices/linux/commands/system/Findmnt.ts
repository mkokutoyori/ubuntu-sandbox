import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';

export interface MountRow {
  readonly target: string;
  readonly source: string;
  readonly fstype: string;
  readonly options: string;
}

export interface FindmntHost {
  mounts(): MountRow[];
  fstab(): MountRow[];
  normalize(path: string): string;
  resolve(path: string): MountRow | undefined;
  versionBanner: string;
}

export interface FindmntOutcome {
  readonly output: string;
  readonly exitCode: number;
}

const SHORT = 'AabCcDd:efF:hiJkLlM:mNnO:o:PpRrsS:T:t:uUvVw:xy';

const LONG: readonly LongOption[] = [
  { name: 'ascii', letter: 'a', takesArgument: false },
  { name: 'all', letter: 'A', takesArgument: false },
  { name: 'bytes', letter: 'b', takesArgument: false },
  { name: 'canonicalize', letter: 'c', takesArgument: false },
  { name: 'df', letter: 'D', takesArgument: false },
  { name: 'evaluate', letter: 'e', takesArgument: false },
  { name: 'first-only', letter: 'f', takesArgument: false },
  { name: 'fstab', letter: 's', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'invert', letter: 'i', takesArgument: false },
  { name: 'json', letter: 'J', takesArgument: false },
  { name: 'kernel', letter: 'k', takesArgument: false },
  { name: 'list', letter: 'l', takesArgument: false },
  { name: 'mountpoint', letter: 'M', takesArgument: true },
  { name: 'mtab', letter: 'm', takesArgument: false },
  { name: 'noheadings', letter: 'n', takesArgument: false },
  { name: 'notruncate', letter: 'u', takesArgument: false },
  { name: 'options', letter: 'O', takesArgument: true },
  { name: 'output', letter: 'o', takesArgument: true },
  { name: 'pairs', letter: 'P', takesArgument: false },
  { name: 'raw', letter: 'r', takesArgument: false },
  { name: 'source', letter: 'S', takesArgument: true },
  { name: 'target', letter: 'T', takesArgument: true },
  { name: 'types', letter: 't', takesArgument: true },
  { name: 'uniq', letter: 'U', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'verify', letter: 'x', takesArgument: false },
];

const VFS_FLAGS = new Set(['ro', 'rw', 'nosuid', 'suid', 'nodev', 'dev', 'noexec', 'exec', 'sync', 'async', 'dirsync', 'mand', 'nomand', 'noatime', 'atime', 'nodiratime', 'diratime', 'relatime', 'norelatime', 'strictatime', 'nostrictatime', 'lazytime', 'silent', 'loud']);

const DEFAULT_COLUMNS = ['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS'];

const splitOptions = (options: string): { vfs: string; fs: string } => {
  const parts = options.split(',').filter((o) => o !== '');
  return {
    vfs: parts.filter((o) => VFS_FLAGS.has(o)).join(','),
    fs: parts.filter((o) => !VFS_FLAGS.has(o)).join(','),
  };
};

const COLUMN_VALUE: Record<string, (row: MountRow) => string> = {
  TARGET: (row) => row.target,
  SOURCE: (row) => row.source,
  FSTYPE: (row) => row.fstype,
  OPTIONS: (row) => row.options,
  FSROOT: () => '/',
  'VFS-OPTIONS': (row) => splitOptions(row.options).vfs,
  'FS-OPTIONS': (row) => splitOptions(row.options).fs,
};

const fail = (message: string): FindmntOutcome => ({ output: message, exitCode: 1 });

const splitTypes = (list: string): { types: Set<string>; inverted: boolean } => {
  const inverted = list.startsWith('no');
  return { types: new Set((inverted ? list.slice(2) : list).split(',').filter((t) => t !== '')), inverted };
};

const optionMatches = (rowOptions: string, wanted: string): boolean => {
  const have = new Set(rowOptions.split(','));
  return wanted.split(',').every((w) => (w.startsWith('no') && !have.has(w) && !VFS_FLAGS.has(w) ? !have.has(w.slice(2)) : have.has(w)));
};

interface TreeNode { readonly row: MountRow; readonly children: TreeNode[] }

const buildForest = (rows: readonly MountRow[]): TreeNode[] => {
  const nodes = rows.map((row): TreeNode => ({ row, children: [] }));
  const roots: TreeNode[] = [];
  for (const node of nodes) {
    let parent: TreeNode | undefined;
    for (const other of nodes) {
      if (other === node) continue;
      const prefix = other.row.target === '/' ? '/' : `${other.row.target}/`;
      if (node.row.target.startsWith(prefix) && (!parent || other.row.target.length > parent.row.target.length)) parent = other;
    }
    (parent ? parent.children : roots).push(node);
  }
  return roots;
};

const flatten = (forest: readonly TreeNode[]): Array<{ row: MountRow; prefix: string }> => {
  const out: Array<{ row: MountRow; prefix: string }> = [];
  const walk = (nodes: readonly TreeNode[], lead: string, nested: boolean): void => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      out.push({ row: node.row, prefix: nested ? `${lead}${last ? '└─' : '├─'}` : '' });
      walk(node.children, nested ? `${lead}${last ? '  ' : '│ '}` : '', true);
    });
  };
  for (const root of forest) {
    out.push({ row: root.row, prefix: '' });
    walk(root.children, '', true);
  }
  return out;
};

const jsonNode = (node: TreeNode, columns: readonly string[], indent: string): string => {
  const inner = `${indent}   `;
  const fields = columns.map((c) => `${inner}"${c.toLowerCase()}": ${JSON.stringify(COLUMN_VALUE[c](node.row))}`);
  if (node.children.length > 0) {
    const kids = node.children.map((child) => jsonNode(child, columns, `${inner}   `)).join(',\n');
    fields.push(`${inner}"children": [\n${kids}\n${inner}]`);
  }
  return `${indent}{\n${fields.join(',\n')}\n${indent}}`;
};

export function runFindmnt(args: readonly string[], host: FindmntHost): FindmntOutcome {
  let noHeadings = false;
  let list = false;
  let raw = false;
  let pairs = false;
  let json = false;
  let fstabMode = false;
  let verify = false;
  let firstOnly = false;
  let invert = false;
  let typeList: string | undefined;
  let optionsFilter: string | undefined;
  let sourceFilter: string | undefined;
  let targetFilter: string | undefined;
  let mountpointFilter: string | undefined;
  let resolveTarget: string | undefined;
  let columns = [...DEFAULT_COLUMNS];
  const operands: string[] = [];

  for (const item of shortOptions(args, SHORT, LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') {
      return fail(`${getoptDiagnostic('findmnt', item)}\nTry 'findmnt --help' for more information.`);
    }
    switch (item.letter) {
      case 'V': return { output: host.versionBanner, exitCode: 0 };
      case 'n': noHeadings = true; break;
      case 'l': list = true; break;
      case 'r': raw = true; list = true; break;
      case 'P': pairs = true; list = true; break;
      case 'J': json = true; break;
      case 's': fstabMode = true; break;
      case 'x': verify = true; break;
      case 'f': firstOnly = true; break;
      case 'i': invert = true; break;
      case 't': typeList = item.argument; break;
      case 'O': optionsFilter = item.argument; break;
      case 'S': sourceFilter = item.argument; break;
      case 'M': mountpointFilter = item.argument; break;
      case 'T': resolveTarget = item.argument; break;
      case 'o': {
        const spec = item.argument ?? '';
        const names = spec.replace(/^\+/, '').split(',').filter((n) => n !== '');
        columns = spec.startsWith('+') ? [...columns, ...names] : names;
        break;
      }
      default: break;
    }
  }

  const unknown = columns.find((c) => COLUMN_VALUE[c] === undefined);
  if (unknown !== undefined) return fail(`findmnt: unknown column: ${unknown}`);
  if (verify) return { output: 'Success, no errors or warnings detected', exitCode: 0 };

  let rows = fstabMode ? host.fstab() : host.mounts();
  if (typeList !== undefined) {
    const { types, inverted } = splitTypes(typeList);
    rows = rows.filter((r) => types.has(r.fstype) !== (inverted !== invert));
  }
  if (optionsFilter !== undefined) rows = rows.filter((r) => optionMatches(r.options, optionsFilter!));
  if (sourceFilter !== undefined) rows = rows.filter((r) => r.source === sourceFilter);
  if (mountpointFilter !== undefined) rows = rows.filter((r) => r.target === host.normalize(mountpointFilter!));
  if (resolveTarget !== undefined) {
    const found = host.resolve(resolveTarget);
    rows = found ? rows.filter((r) => r.target === found.target) : [];
  }
  const searched = operands.length === 1 ? operands[0] : undefined;
  if (operands.length > 1) rows = [];
  else if (searched !== undefined) {
    const path = host.normalize(searched);
    rows = rows.filter((r) => r.target === path || r.source === searched);
  }
  if (firstOnly) rows = rows.slice(0, 1);
  if (rows.length === 0) return { output: '', exitCode: 1 };

  const lookup = (row: MountRow): string[] => columns.map((c) => COLUMN_VALUE[c](row));
  const treeMode = !list && !fstabMode && searched === undefined && resolveTarget === undefined;

  if (json) {
    const forest = treeMode ? buildForest(rows) : rows.map((row): TreeNode => ({ row, children: [] }));
    const body = forest.map((n) => jsonNode(n, columns, '      ')).join(',\n');
    return { output: `{\n   "filesystems": [\n${body}\n   ]\n}`, exitCode: 0 };
  }
  if (pairs) {
    return { output: rows.map((r) => columns.map((c, i) => `${c}="${lookup(r)[i]}"`).join(' ')).join('\n'), exitCode: 0 };
  }
  if (raw) {
    const escape = (v: string): string => v.replace(/ /g, '\\x20');
    const lines = rows.map((r) => lookup(r).map(escape).join(' '));
    return { output: (noHeadings ? lines : [columns.join(' '), ...lines]).join('\n'), exitCode: 0 };
  }

  const flat = treeMode
    ? flatten(buildForest(rows)).map((entry) => ({ cells: lookup(entry.row), prefix: entry.prefix }))
    : rows.map((r) => ({ cells: lookup(r), prefix: '' }));
  const table = flat.map(({ cells, prefix }) => cells.map((cell, i) => (i === 0 ? `${prefix}${cell}` : cell)));
  const all = noHeadings ? table : [columns, ...table];
  const widths = columns.map((column, i) => Math.max(column.length, ...all.map((line) => line[i].length)));
  const lines = all.map((line) => line.map((cell, i) => (i === line.length - 1 ? cell : cell.padEnd(widths[i] + 1))).join('').trimEnd());
  return { output: lines.join('\n'), exitCode: 0 };
}
