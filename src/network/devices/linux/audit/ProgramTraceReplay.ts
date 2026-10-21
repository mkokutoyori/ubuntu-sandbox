export type TracedCall = readonly [name: string, args: readonly string[], ret: number | null, errno: string | null];

export interface ProgramTrace {
  readonly prologue: readonly TracedCall[];
  readonly operandBlock?: readonly TracedCall[];
  readonly epilogue?: readonly TracedCall[];
  readonly singleOperand?: boolean;
  readonly operandKind?: 'file' | 'directory';
}

export interface ReplayWorld {
  readContent(path: string): string | null;
  listEntries(path: string): readonly string[] | null;
  readonly stdoutLength: number;
}

export interface ReplayedSyscall {
  readonly syscall: string;
  readonly path?: string;
  readonly args: readonly [string, string, string, string];
  readonly exit: number;
}

const PATH_ARGUMENT: Readonly<Record<string, number>> = {
  openat: 1, access: 0, statx: 1, newfstatat: 1, statfs: 0, readlink: 0, readlinkat: 1,
};

const ERRNO_NUMBERS: Readonly<Record<string, number>> = {
  EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTTY: 25,
  ENOSYS: 38, EAFNOSUPPORT: 97, ECONNREFUSED: 111,
};

const DIRENT_HEADER = 19;
const FAKE_POINTER_BASE = 0x7f0000000000;
const OPERAND_TOKEN = /^\$op(\d+)$/;

function hashOf(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

function pointerHex(seed: string): string {
  return (FAKE_POINTER_BASE + ((hashOf(seed) & 0x0fffffff) << 4)).toString(16);
}

function numberHex(value: string): string | null {
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    return n < 0 ? (n >>> 0).toString(16) : n.toString(16);
  }
  if (/^0x[0-9a-f]+$/i.test(value)) return value.slice(2).toLowerCase();
  if (value === 'NULL') return '0';
  return null;
}

function unquote(text: string): string {
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function alignedDirent(name: string): number {
  return Math.ceil((DIRENT_HEADER + name.length + 1) / 8) * 8;
}

function substituteOperands(call: TracedCall, operands: readonly string[]): TracedCall {
  const args = call[1].map((arg) => {
    const match = OPERAND_TOKEN.exec(arg);
    return match === null ? arg : `"${operands[Number(match[1])] ?? ''}"`;
  });
  return [call[0], args, call[2], call[3]];
}

export function expandTrace(trace: ProgramTrace, operands: readonly string[]): TracedCall[] {
  if (trace.singleOperand) {
    if (operands.length !== 1) return [];
    return trace.prologue.map((call) => substituteOperands(call, operands));
  }
  const calls: TracedCall[] = [...trace.prologue];
  for (const operand of operands) {
    for (const call of trace.operandBlock ?? []) calls.push(substituteOperands(call, [operand]));
  }
  calls.push(...(trace.epilogue ?? []));
  return calls;
}

export function replayProgram(trace: ProgramTrace, operands: readonly string[], world: ReplayWorld): ReplayedSyscall[] {
  const descriptors = new Map<number, { path: string; offset: number; listed: boolean }>();
  const seekEnds = new Map<number, { recorded: number; actual: number }>();
  const replayed: ReplayedSyscall[] = [];
  const calls = expandTrace(trace, operands);
  let lastRead = -1;
  for (let index = 0; index < calls.length; index++) {
    const [name, rawArgs, recorded, errno] = calls[index];
    const pathIndex = PATH_ARGUMENT[name];
    const path = pathIndex === undefined ? undefined : unquote(rawArgs[pathIndex] ?? '');
    const numeric: string[] = rawArgs.map((arg, index) => numberHex(arg) ?? pointerHex(`${name}#${index}#${path ?? arg}`));
    let exit = errno === null ? (recorded ?? 0) : -(ERRNO_NUMBERS[errno] ?? 1);
    const fd = Number(rawArgs[0]);
    if (name === 'openat' && path !== undefined && exit >= 0) descriptors.set(exit, { path, offset: 0, listed: false });
    else if (name === 'close') descriptors.delete(fd);
    else if (name === 'lseek' && rawArgs[2] === '0x2') {
      const open = descriptors.get(fd);
      const content = open === undefined ? null : world.readContent(open.path);
      if (content !== null) {
        seekEnds.set(fd, { recorded: exit, actual: content.length });
        exit = content.length;
      }
    } else if (name === 'read' && exit > 0) {
      const open = descriptors.get(fd);
      const content = open === undefined ? null : world.readContent(open.path);
      if (open !== undefined && content !== null) {
        const seekEnd = seekEnds.get(fd);
        const count = seekEnd !== undefined && Number(rawArgs[2]) === seekEnd.recorded ? seekEnd.actual : Number(rawArgs[2]);
        numeric[2] = count.toString(16);
        exit = Math.max(0, Math.min(content.length - open.offset, count));
        open.offset += exit;
        lastRead = exit;
        if (open.offset < content.length) {
          const followedByWrite = calls[index + 1]?.[0] === 'write' && calls[index + 1][1][0] === '1';
          const repeat: TracedCall[] = followedByWrite ? [calls[index], calls[index + 1]] : [calls[index]];
          calls.splice(index + 1 + (followedByWrite ? 1 : 0), 0, ...repeat);
        }
      }
    } else if (name === 'write' && fd === 1 && exit > 0) {
      const followsRead = calls[index - 1]?.[0] === 'read' && lastRead >= 0;
      exit = followsRead ? lastRead : world.stdoutLength;
      numeric[2] = exit.toString(16);
      if (exit === 0) continue;
    } else if (name === 'getdents64' && exit > 0) {
      const open = descriptors.get(fd);
      const entries = open === undefined ? null : world.listEntries(open.path);
      if (open !== undefined && entries !== null && !open.listed) {
        exit = ['.', '..', ...entries].reduce((sum, entry) => sum + alignedDirent(entry), 0);
        open.listed = true;
      }
    }
    replayed.push({
      syscall: name,
      ...(path === undefined ? {} : { path }),
      args: [numeric[0] ?? '0', numeric[1] ?? '0', numeric[2] ?? '0', numeric[3] ?? '0'],
      exit,
    });
  }
  return replayed;
}
