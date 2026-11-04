import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, expandGlob, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'changes', letter: 'c', takesArgument: false },
  { name: 'dereference', letter: 'D', takesArgument: false },
  { name: 'from', letter: 'F', takesArgument: true },
  { name: 'no-dereference', letter: 'h', takesArgument: false },
  { name: 'no-preserve-root', letter: 'N', takesArgument: false },
  { name: 'preserve-root', letter: 'P', takesArgument: false },
  { name: 'quiet', letter: 'f', takesArgument: false },
  { name: 'silent', letter: 'f', takesArgument: false },
  { name: 'recursive', letter: 'R', takesArgument: false },
  { name: 'reference', letter: 'r', takesArgument: true },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'Z', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const NO_ID = 0xffffffff;

interface Spec {
  uid: number | null;
  gid: number | null;
  userName: string | null;
  groupName: string | null;
}

function parseId(ctx: ShellContext, text: string, kind: 'user' | 'group'): number | null {
  const named = kind === 'user' ? ctx.userMgr.resolveUid(text) : ctx.userMgr.resolveGid(text);
  if (named >= 0) return named;
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return value < NO_ID ? value : null;
  }
  return null;
}

function parseOwnerSpec(ctx: ShellContext, text: string, withUser: boolean): Spec | string {
  const empty: Spec = { uid: null, gid: null, userName: null, groupName: null };
  if (!withUser) {
    if (text === '') return empty;
    const gid = parseId(ctx, text, 'group');
    if (gid === null) return `invalid group: ${quoteLocale(text)}`;
    return { ...empty, gid, groupName: ctx.userMgr.gidToName(gid) };
  }
  let separator = text.indexOf(':');
  if (separator < 0 && /^[^.]+\.[^.]*$/.test(text) && parseId(ctx, text, 'user') === null) separator = text.indexOf('.');
  const userText = separator < 0 ? text : text.slice(0, separator);
  const groupText = separator < 0 ? null : text.slice(separator + 1);
  const spec: Spec = { ...empty };
  if (userText !== '') {
    const uid = parseId(ctx, userText, 'user');
    if (uid === null) return `invalid user: ${quoteLocale(text)}`;
    spec.uid = uid;
    spec.userName = ctx.userMgr.uidToName(uid);
  }
  if (groupText !== null) {
    if (groupText === '') {
      if (spec.uid !== null) {
        const entry = ctx.userMgr.getUserByUid(spec.uid);
        if (entry !== undefined) { spec.gid = entry.gid; spec.groupName = ctx.userMgr.gidToName(entry.gid); }
      }
    } else {
      const gid = parseId(ctx, groupText, 'group');
      if (gid === null) return `invalid group: ${quoteLocale(text)}`;
      spec.gid = gid;
      spec.groupName = ctx.userMgr.gidToName(gid);
    }
  }
  return spec;
}

function run(ctx: ShellContext, program: 'chown' | 'chgrp', args: readonly string[], onFile: (absolute: string) => void): CoreutilsRun {
  const isChown = program === 'chown';
  const streams = new Streams();
  let recursive = false;
  let verbose = false;
  let changes = false;
  let quiet = false;
  let noDereference = false;
  let preserveRoot = false;
  let follow: 'P' | 'H' | 'L' = 'P';
  let fromText: string | null = null;
  let reference: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'cfhHLPRv', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure(program, getoptDiagnostic(program, item));
    switch (item.letter) {
      case 'Z': return docsResult(program, 'help');
      case 'V': return docsResult(program, 'version');
      case 'c': changes = true; break;
      case 'v': verbose = true; break;
      case 'f': quiet = true; break;
      case 'h': noDereference = true; break;
      case 'D': noDereference = false; break;
      case 'R': recursive = true; break;
      case 'H': follow = 'H'; break;
      case 'L': follow = 'L'; break;
      case 'P': if (item.long === 'preserve-root') preserveRoot = true; else follow = 'P'; break;
      case 'N': preserveRoot = false; break;
      case 'F': fromText = item.argument ?? ''; break;
      case 'r': reference = item.argument ?? ''; break;
      default: break;
    }
  }
  const needed = reference === null ? 2 : 1;
  if (operands.length === 0 || (operands.length < needed)) {
    return usageFailure(program, operands.length === 0
      ? `${program}: missing operand`
      : `${program}: missing operand after ${quoteLocale(operands[operands.length - 1])}`);
  }
  const fail = (message: string): CoreutilsRun => {
    if (!quiet) streams.diagnostic(`${program}: ${message}`);
    streams.exitCode = 1;
    return streams.result();
  };
  const actor = actorOf(ctx);
  let spec: Spec;
  let files: string[];
  if (reference !== null) {
    const node = ctx.vfs.path(reference, ctx.cwd, actor).inode();
    if (node === null) return fail(`failed to get attributes of ${quoteLocale(reference)}: No such file or directory`);
    spec = {
      uid: isChown ? node.uid : null, gid: node.gid,
      userName: isChown ? ctx.userMgr.uidToName(node.uid) : null, groupName: ctx.userMgr.gidToName(node.gid),
    };
    files = operands;
  } else {
    const parsed = parseOwnerSpec(ctx, operands[0], isChown);
    if (typeof parsed === 'string') return fail(parsed);
    spec = parsed;
    files = operands.slice(1);
  }
  let from: Spec | null = null;
  if (fromText !== null && isChown) {
    const parsed = parseOwnerSpec(ctx, fromText, true);
    if (typeof parsed === 'string') return fail(parsed);
    from = parsed;
  }
  const describe = (uid: number, gid: number): string => {
    if (!isChown) return ctx.userMgr.gidToName(gid);
    const user = ctx.userMgr.uidToName(uid);
    return spec.gid === null ? user : `${user}:${ctx.userMgr.gidToName(gid)}`;
  };
  const noun = isChown ? 'ownership' : 'group';
  const verb = isChown ? 'changing ownership' : 'changing group';

  const visit = (typed: string, absolute: string, topLevel: boolean): void => {
    const link = ctx.vfs.lstat(absolute);
    if (link === null) {
      if (!quiet) streams.diagnostic(`${program}: cannot access ${quoteLocale(typed)}: No such file or directory`);
      streams.exitCode = 1;
      return;
    }
    const followLink = link.type === 'symlink' && (!noDereference) && (!recursive || follow === 'L' || (follow === 'H' && topLevel));
    const node = followLink ? ctx.vfs.resolveInode(absolute) : link;
    if (node === null) {
      if (!quiet) streams.diagnostic(`${program}: cannot dereference ${quoteLocale(typed)}: No such file or directory`);
      streams.exitCode = 1;
      return;
    }
    const target = followLink ? ctx.vfs.realpath(absolute, '/', false) ?? absolute : absolute;
    if (recursive && node.type === 'directory') {
      for (const entry of ctx.vfs.listDirectory(target) ?? []) {
        if (entry.name === '.' || entry.name === '..') continue;
        visit(`${typed.replace(/\/$/, '')}/${entry.name}`, `${target.replace(/\/$/, '')}/${entry.name}`, false);
      }
    }
    let eligible = true;
    if (from !== null) {
      if (from.uid !== null && from.uid !== node.uid) eligible = false;
      if (from.gid !== null && from.gid !== node.gid) eligible = false;
    }
    if (eligible) {
      const newUid = spec.uid ?? node.uid;
      const newGid = spec.gid ?? node.gid;
      const changed = newUid !== node.uid || newGid !== node.gid;
      if (changed && ctx.uid !== 0) {
        const mayChangeUid = newUid === node.uid;
        const mayChangeGid = newGid === node.gid || (node.uid === ctx.uid && (actor.gids ?? []).includes(newGid));
        if (!mayChangeUid || !mayChangeGid) {
          if (!quiet) streams.diagnostic(`${program}: ${verb} of ${quoteLocale(typed)}: Operation not permitted`);
          streams.exitCode = 1;
          eligible = false;
        }
      }
      if (eligible) {
        onFile(target);
        const before = describe(node.uid, node.gid);
        if (changed) ctx.vfs.chown(target, newUid, newGid === node.gid ? undefined : newGid, followLink || link.type !== 'symlink');
        if (changed && (verbose || changes)) {
          streams.stdout(`changed ${noun} of ${quoteLocale(typed)} from ${before} to ${describe(newUid, newGid)}\n`);
        } else if (!changed && verbose) {
          const unspecified = spec.uid === null && spec.gid === null;
          streams.stdout(unspecified ? `${noun} of ${quoteLocale(typed)} retained\n` : `${noun} of ${quoteLocale(typed)} retained as ${describe(newUid, newGid)}\n`);
        }
      }
    }
  };
  for (const operand of files) {
    for (const expanded of expandGlob(ctx, operand)) {
      const absolute = ctx.vfs.normalizePath(expanded, ctx.cwd);
      if (recursive && preserveRoot && absolute === '/') {
        streams.diagnostic(`${program}: it is dangerous to operate recursively on ${quoteLocale('/')}`);
        streams.diagnostic(`${program}: use --no-preserve-root to override this failsafe`);
        streams.exitCode = 1;
        return streams.result();
      }
      visit(expanded, absolute, true);
    }
  }
  return streams.result();
}

export const runChown = (ctx: ShellContext, args: readonly string[], onFile: (absolute: string) => void = () => undefined): CoreutilsRun => run(ctx, 'chown', args, onFile);
export const runChgrp = (ctx: ShellContext, args: readonly string[], onFile: (absolute: string) => void = () => undefined): CoreutilsRun => run(ctx, 'chgrp', args, onFile);
