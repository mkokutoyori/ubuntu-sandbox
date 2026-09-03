import type { CaptureFrame } from './CaptureFrame';
import { compileFilter } from './TcpdumpFilter';
import {
  parseInvocation,
  listInterfacesText,
  listLinkTypesText,
  type TcpdumpOptions,
} from './TcpdumpCli';
import { banner, footer, formatFrame } from './TcpdumpFormat';
import { serializeCaptureFile, deserializeCaptureFile } from './CaptureFileFormat';

export interface TcpdumpDeps {
  interfaceNames(): string[];
  interfaceExists(name: string): boolean;
  interfaceUp(name: string): boolean;
  openCapture(iface: string, sink: (frame: CaptureFrame) => void): () => void;
  now(): Date;
  delay(ms: number): Promise<void>;
  onCancelRequested(cb: () => void): () => void;
  runsDetached?(): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): boolean;
  dirWritable(path: string): boolean;
}

const CAPTURE_WINDOW_MS = 200;
const CAPTURE_DEADLINE_WITH_TARGET_MS = 3000;
const MAX_FILTER_TOKENS = 64;

export interface TcpdumpResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Real tcpdump writes its banner, per-packet lines, and summary footer to different fds; only the packet lines are stdout — piping through awk/grep never sees the rest. */
export async function runTcpdump(tokens: string[], deps: TcpdumpDeps): Promise<TcpdumpResult> {
  const invocation = parseInvocation(tokens);

  switch (invocation.kind) {
    case 'error':
      return { stdout: '', stderr: invocation.message, exitCode: 1 };
    case 'help':
      return { stdout: invocation.text, stderr: '', exitCode: 0 };
    case 'version':
      return { stdout: invocation.text, stderr: '', exitCode: 0 };
    case 'list-interfaces':
      return {
        stdout: listInterfacesText(deps.interfaceNames(), (name) => name === 'lo' || deps.interfaceUp(name)),
        stderr: '', exitCode: 0,
      };
    case 'list-link-types':
      return { stdout: listLinkTypesText(invocation.iface), stderr: '', exitCode: 0 };
    case 'capture':
      return runCapture(invocation.options, deps);
  }
}

async function runCapture(opt: TcpdumpOptions, deps: TcpdumpDeps): Promise<TcpdumpResult> {
  if (opt.readFile) return readCaptureFile(opt, deps);

  if (opt.filterTokens.length > MAX_FILTER_TOKENS) {
    return { stdout: '', stderr: 'tcpdump: error: too many arguments in filter expression', exitCode: 1 };
  }

  const filter = compileFilter(opt.filterTokens);
  if (filter.ok === false) return { stdout: '', stderr: filter.message, exitCode: 1 };

  if (opt.iface !== 'any' && opt.iface !== 'lo') {
    if (!deps.interfaceExists(opt.iface)) {
      return { stdout: '', stderr: `tcpdump: error: ${opt.iface}: No such device exists`, exitCode: 1 };
    }
    if (!deps.interfaceUp(opt.iface)) {
      return { stdout: '', stderr: `tcpdump: error: ${opt.iface} is down`, exitCode: 1 };
    }
  }

  if (opt.writeFile && !deps.dirWritable(opt.writeFile)) {
    return {
      stdout: '', exitCode: 1,
      stderr: `tcpdump: error: ${opt.writeFile}: Permission denied (cannot open for writing)`,
    };
  }

  const collected: CaptureFrame[] = [];
  const target = opt.count;
  const detached = deps.runsDetached?.() === true;

  if (target !== 0) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribeCapture: (() => void) | null = null;
      let unsubscribeCancel: (() => void) | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        unsubscribeCapture?.();
        unsubscribeCancel?.();
        resolve();
      };
      unsubscribeCapture = deps.openCapture(opt.iface, (frame) => {
        if (opt.direction !== 'inout' && frame.direction !== opt.direction) return;
        if (!filter.predicate(frame)) return;
        collected.push(frame);
        if (opt.writeFile) persistCapture(opt.writeFile, collected, deps);
        if (target !== null && collected.length >= target) finish();
      });
      unsubscribeCancel = deps.onCancelRequested(finish);
      if (settled) unsubscribeCapture();
      else if (detached && target === null) {
        if (opt.writeFile) persistCapture(opt.writeFile, collected, deps);
        resolve();
      } else {
        const deadline = target !== null ? CAPTURE_DEADLINE_WITH_TARGET_MS : CAPTURE_WINDOW_MS;
        deps.delay(deadline).then(finish);
      }
    });
  }

  const printed = target === null ? collected : collected.slice(0, target);

  if (opt.writeFile) {
    persistCapture(opt.writeFile, printed, deps);
    return {
      stdout: '',
      stderr: [...banner(opt), ...footer(printed.length, printed.length)].join('\n'),
      exitCode: 0,
    };
  }

  const stdoutLines: string[] = [];
  let prev: Date | null = null;
  for (const frame of printed) {
    stdoutLines.push(formatFrame(frame, opt, prev));
    prev = frame.at;
  }
  return {
    stdout: stdoutLines.join('\n'),
    stderr: [...banner(opt), ...footer(printed.length, printed.length)].join('\n'),
    exitCode: 0,
  };
}

function persistCapture(path: string, frames: CaptureFrame[], deps: TcpdumpDeps): void {
  deps.writeFile(path, serializeCaptureFile(frames));
}

function readCaptureFile(opt: TcpdumpOptions, deps: TcpdumpDeps): TcpdumpResult {
  const content = deps.readFile(opt.readFile!);
  if (content === null) {
    return { stdout: '', stderr: `tcpdump: error: ${opt.readFile}: No such file or directory`, exitCode: 1 };
  }
  const frames = deserializeCaptureFile(content);
  if (frames === null) {
    return {
      stdout: '', exitCode: 1,
      stderr: `tcpdump: error: ${opt.readFile}: unknown file format (bad dump file)`,
    };
  }
  const filter = compileFilter(opt.filterTokens);
  const predicate = filter.ok ? filter.predicate : () => true;
  const stdoutLines: string[] = [];
  let prev: Date | null = null;
  let printed = 0;
  for (const frame of frames) {
    if (opt.direction !== 'inout' && frame.direction !== opt.direction) continue;
    if (!predicate(frame)) continue;
    stdoutLines.push(formatFrame(frame, opt, prev));
    prev = frame.at;
    printed++;
    if (opt.count !== null && printed >= opt.count) break;
  }
  const readingLine = `reading from file ${opt.readFile}, link-type ${opt.linkType} (Ethernet), snapshot length ${opt.snaplen}`;
  return {
    stdout: stdoutLines.join('\n'),
    stderr: [readingLine, ...footer(printed, printed)].join('\n'),
    exitCode: 0,
  };
}
