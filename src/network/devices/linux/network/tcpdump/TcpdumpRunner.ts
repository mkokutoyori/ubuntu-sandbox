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
  readFile(path: string): string | null;
  writeFile(path: string, content: string): boolean;
  dirWritable(path: string): boolean;
}

const CAPTURE_WINDOW_MS = 200;
const CAPTURE_DEADLINE_WITH_TARGET_MS = 3000;
const MAX_FILTER_TOKENS = 64;

export async function runTcpdump(tokens: string[], deps: TcpdumpDeps): Promise<string> {
  const invocation = parseInvocation(tokens);

  switch (invocation.kind) {
    case 'error':
      return invocation.message;
    case 'help':
      return invocation.text;
    case 'version':
      return invocation.text;
    case 'list-interfaces':
      return listInterfacesText(deps.interfaceNames(), (name) => name === 'lo' || deps.interfaceUp(name));
    case 'list-link-types':
      return listLinkTypesText(invocation.iface);
    case 'capture':
      return runCapture(invocation.options, deps);
  }
}

async function runCapture(opt: TcpdumpOptions, deps: TcpdumpDeps): Promise<string> {
  if (opt.readFile) return readCaptureFile(opt, deps);

  if (opt.filterTokens.length > MAX_FILTER_TOKENS) {
    return 'tcpdump: error: too many arguments in filter expression';
  }

  const filter = compileFilter(opt.filterTokens);
  if (filter.ok === false) return filter.message;

  if (opt.iface !== 'any' && opt.iface !== 'lo') {
    if (!deps.interfaceExists(opt.iface)) {
      return `tcpdump: error: ${opt.iface}: No such device exists`;
    }
    if (!deps.interfaceUp(opt.iface)) {
      return `tcpdump: error: ${opt.iface} is down`;
    }
  }

  if (opt.writeFile && !deps.dirWritable(opt.writeFile)) {
    return `tcpdump: error: ${opt.writeFile}: Permission denied (cannot open for writing)`;
  }

  const collected: CaptureFrame[] = [];
  const target = opt.count;

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
        if (target !== null && collected.length >= target) finish();
      });
      unsubscribeCancel = deps.onCancelRequested(finish);
      if (settled) unsubscribeCapture();
      else {
        const deadline = target !== null ? CAPTURE_DEADLINE_WITH_TARGET_MS : CAPTURE_WINDOW_MS;
        deps.delay(deadline).then(finish);
      }
    });
  }

  const printed = target === null ? collected : collected.slice(0, target);

  if (opt.writeFile) {
    persistCapture(opt.writeFile, printed, deps);
    return [...banner(opt), ...footer(printed.length, printed.length)].join('\n');
  }

  const lines: string[] = [...banner(opt)];
  let prev: Date | null = null;
  for (const frame of printed) {
    lines.push(formatFrame(frame, opt, prev));
    prev = frame.at;
  }
  lines.push(...footer(printed.length, printed.length));
  return lines.join('\n');
}

function persistCapture(path: string, frames: CaptureFrame[], deps: TcpdumpDeps): void {
  deps.writeFile(path, serializeCaptureFile(frames));
}

function readCaptureFile(opt: TcpdumpOptions, deps: TcpdumpDeps): string {
  const content = deps.readFile(opt.readFile!);
  if (content === null) {
    return `tcpdump: error: ${opt.readFile}: No such file or directory`;
  }
  const frames = deserializeCaptureFile(content);
  if (frames === null) {
    return `tcpdump: error: ${opt.readFile}: unknown file format (bad dump file)`;
  }
  const filter = compileFilter(opt.filterTokens);
  const predicate = filter.ok ? filter.predicate : () => true;
  const lines: string[] = [
    `reading from file ${opt.readFile}, link-type ${opt.linkType} (Ethernet), snapshot length ${opt.snaplen}`,
  ];
  let prev: Date | null = null;
  let printed = 0;
  for (const frame of frames) {
    if (opt.direction !== 'inout' && frame.direction !== opt.direction) continue;
    if (!predicate(frame)) continue;
    lines.push(formatFrame(frame, opt, prev));
    prev = frame.at;
    printed++;
    if (opt.count !== null && printed >= opt.count) break;
  }
  return lines.join('\n');
}
