import type { ProcessInfo } from './LinuxProcessManager';
import type { ProcessCmdContext, KillResult } from './LinuxProcessCommands';

const VERSION = [
  'pstree (PSmisc) 23.7',
  'Copyright (C) 1993-2024 Werner Almesberger and Craig Small',
  '',
  'PSmisc comes with ABSOLUTELY NO WARRANTY.',
  'This is free software, and you are welcome to redistribute it under',
  'the terms of the GNU General Public License.',
  'For more information about these matters, see the files named COPYING.',
].join('\n');

const USAGE = [
  'Usage: pstree [-acglpsStTuZ] [ -h | -H PID ] [ -n | -N type ]',
  '              [ -A | -G | -U ] [ PID | USER ]',
  '   or: pstree -V',
].join('\n');

interface Style {
  readonly branch: string;
  readonly middle: string;
  readonly last: string;
  readonly chain: string;
  readonly bar: string;
}

const ASCII: Style = { branch: '-+-', middle: '|-', last: '`-', chain: '---', bar: '|' };
const UNICODE: Style = { branch: '─┬─', middle: '├─', last: '└─', chain: '───', bar: '│' };

interface Options {
  args: boolean;
  compact: boolean;
  numeric: boolean;
  pids: boolean;
  pgids: boolean;
  uids: boolean;
  parents: boolean;
  style: Style;
  rootPid: number | null;
  rootUser: string | null;
}

interface TreeNode {
  readonly process: ProcessInfo;
  children: TreeNode[];
}

function parse(argv: readonly string[], utf8: boolean): Options | { stop: KillResult } {
  const options: Options = {
    args: false, compact: true, numeric: false, pids: false, pgids: false, uids: false, parents: false,
    style: utf8 ? UNICODE : ASCII, rootPid: null, rootUser: null,
  };
  for (const token of argv) {
    if (token.startsWith('-') && token.length > 1) {
      for (const letter of token.slice(1)) {
        switch (letter) {
          case 'a': options.args = true; options.compact = false; break;
          case 'A': options.style = ASCII; break;
          case 'U': options.style = UNICODE; break;
          case 'c': options.compact = false; break;
          case 'n': options.numeric = true; break;
          case 'p': options.pids = true; break;
          case 'g': options.pgids = true; break;
          case 'u': options.uids = true; break;
          case 's': options.parents = true; break;
          case 'l': case 'h': case 'S': case 't': case 'T': case 'G': break;
          case 'V': return { stop: { output: VERSION, exitCode: 0 } };
          default:
            return { stop: { output: '', stderr: `pstree: invalid option -- '${letter}'\n${USAGE}\n`, exitCode: 1 } };
        }
      }
    } else if (/^\d+$/.test(token)) options.rootPid = Number(token);
    else options.rootUser = token;
  }
  return options;
}

function nameOf(process: ProcessInfo): string {
  return process.comm.replace(/^\[(.*)\]$/, '$1');
}

function label(node: TreeNode, options: Options, parentUid: number | null, userOf: (uid: number) => string): string {
  const process = node.process;
  let text = nameOf(process);
  if (options.args) {
    const rest = process.command.split(' ').slice(1).join(' ');
    const identity = options.pids ? `,${process.pid}` : options.pgids ? `,${process.pgid}` : '';
    text = `${text}${identity}${rest === '' ? '' : ` ${rest}`}`;
  } else if (options.pids) text = `${text}(${process.pid})`;
  else if (options.pgids) text = `${text}(${process.pgid})`;
  if (options.uids && parentUid !== null && process.uid !== parentUid) text += `(${userOf(process.uid)})`;
  return text;
}

function sameShape(a: TreeNode, b: TreeNode, options: Options): boolean {
  if (nameOf(a.process) !== nameOf(b.process) || a.children.length !== b.children.length) return false;
  if (options.uids && a.process.uid !== b.process.uid) return false;
  return a.children.every((child, index) => sameShape(child, b.children[index], options));
}

function renderHorizontal(
  node: TreeNode, options: Options, parentUid: number | null, userOf: (uid: number) => string,
): string[] {
  const text = label(node, options, parentUid, userOf);
  const groups: Array<{ node: TreeNode; count: number }> = [];
  for (const child of node.children) {
    const previous = groups[groups.length - 1];
    if (options.compact && !options.pids && !options.pgids && previous !== undefined && sameShape(previous.node, child, options)) previous.count++;
    else groups.push({ node: child, count: 1 });
  }
  const blocks = groups.map((group) => {
    const lines = renderHorizontal(group.node, options, node.process.uid, userOf);
    if (group.count === 1) return lines;
    const opener = `${group.count}*[`;
    return lines.map((line, index) => (index === 0 ? opener : ' '.repeat(opener.length)) + line)
      .map((line, index, all) => (index === all.length - 1 ? `${line}]` : line));
  });
  const style = options.style;
  if (blocks.length === 0) return [text];
  if (blocks.length === 1) {
    return blocks[0].map((line, index) => (index === 0 ? `${text}${style.chain}${line}` : ' '.repeat(text.length + style.chain.length) + line));
  }
  const out: string[] = [];
  blocks.forEach((block, position) => {
    const isLast = position === blocks.length - 1;
    block.forEach((line, index) => {
      if (position === 0 && index === 0) out.push(`${text}${style.branch}${line}`);
      else if (index === 0) out.push(`${' '.repeat(text.length + 1)}${isLast ? style.last : style.middle}${line}`);
      else out.push(`${' '.repeat(text.length + 1)}${isLast ? ' ' : style.bar} ${line}`);
    });
  });
  return out;
}

function renderVertical(
  node: TreeNode, options: Options, parentUid: number | null, userOf: (uid: number) => string,
  prefix: string, lines: string[],
): void {
  node.children.forEach((child, index) => {
    const isLast = index === node.children.length - 1;
    lines.push(`${prefix}${isLast ? options.style.last : options.style.middle}${label(child, options, node.process.uid, userOf)}`);
    renderVertical(child, options, node.process.uid, userOf, `${prefix}${isLast ? ' ' : options.style.bar}   `, lines);
  });
}

export function runPstree(argv: readonly string[], ctx: ProcessCmdContext): KillResult {
  const parsed = parse(argv, ctx.utf8Locale === true);
  if ('stop' in parsed) return parsed.stop;
  const options = parsed;
  const all = ctx.pm.list();
  const byPid = new Map<number, TreeNode>(all.map((process) => [process.pid, { process, children: [] }]));
  for (const node of byPid.values()) byPid.get(node.process.ppid)?.children.push(node);
  const order = (a: TreeNode, b: TreeNode): number => (options.numeric
    ? a.process.pid - b.process.pid
    : nameOf(a.process).localeCompare(nameOf(b.process), 'en') || a.process.pid - b.process.pid);
  for (const node of byPid.values()) node.children.sort(order);
  const userOf = (uid: number): string => all.find((process) => process.uid === uid)?.user ?? String(uid);

  let roots: TreeNode[];
  if (options.rootUser !== null) {
    const uid = ctx.userUid?.(options.rootUser) ?? -1;
    if (uid < 0) return { output: `No such user name: ${options.rootUser}`, exitCode: 1 };
    roots = [...byPid.values()].filter((node) => node.process.uid === uid && byPid.get(node.process.ppid)?.process.uid !== uid);
    roots.sort(order);
  } else {
    const rootPid = options.rootPid ?? 1;
    const root = byPid.get(rootPid);
    if (root === undefined) return { output: '', exitCode: 0 };
    roots = [root];
  }

  if (options.parents && options.rootPid !== null) {
    const chain: TreeNode[] = [];
    for (let at = byPid.get(options.rootPid); at !== undefined; at = byPid.get(at.process.ppid)) {
      chain.unshift(at);
      if (at.process.ppid === 0) break;
    }
    const names = chain.map((node) => label(node, options, null, userOf));
    return { output: names.join(options.style.chain), exitCode: 0 };
  }

  const lines: string[] = [];
  for (const root of roots) {
    if (options.args) {
      lines.push(label(root, options, null, userOf));
      renderVertical(root, options, root.process.uid, userOf, '  ', lines);
    } else lines.push(...renderHorizontal(root, options, null, userOf));
  }
  return { output: lines.join('\n'), exitCode: 0 };
}
