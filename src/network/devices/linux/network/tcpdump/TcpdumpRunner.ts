import type { CaptureFrame } from './CaptureFrame';
import { compileFilter } from './TcpdumpFilter';
import {
  parseInvocation,
  listInterfacesText,
  listLinkTypesText,
  type TcpdumpOptions,
} from './TcpdumpCli';
import { banner, footer, formatFrame } from './TcpdumpFormat';

export interface TcpdumpDeps {
  interfaceNames(): string[];
  interfaceExists(name: string): boolean;
  interfaceUp(name: string): boolean;
  openCapture(iface: string, sink: (frame: CaptureFrame) => void): () => void;
  now(): Date;
  delay(ms: number): Promise<void>;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): boolean;
  dirWritable(path: string): boolean;
}

const CAPTURE_WINDOW_MS = 200;
const PCAP_MAGIC = 'TCPDUMPSIM1';
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
      return listInterfacesText(deps.interfaceNames());
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
      const finish = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve();
      };
      const unsubscribe = deps.openCapture(opt.iface, (frame) => {
        if (!filter.predicate(frame)) return;
        collected.push(frame);
        if (target !== null && collected.length >= target) finish();
      });
      deps.delay(CAPTURE_WINDOW_MS).then(finish);
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
  const payload = JSON.stringify(frames);
  deps.writeFile(path, `${PCAP_MAGIC}\n${payload}`);
}

function readCaptureFile(opt: TcpdumpOptions, deps: TcpdumpDeps): string {
  const content = deps.readFile(opt.readFile!);
  if (content === null) {
    return `tcpdump: error: ${opt.readFile}: No such file or directory`;
  }
  const newline = content.indexOf('\n');
  const magic = newline >= 0 ? content.slice(0, newline) : content;
  if (magic.trim() !== PCAP_MAGIC) {
    return `tcpdump: error: ${opt.readFile}: unknown file format (bad dump file)`;
  }
  let frames: CaptureFrame[];
  try {
    frames = (JSON.parse(content.slice(newline + 1)) as CaptureFrame[]).map((f) => ({
      ...f,
      at: new Date(f.at),
    }));
  } catch {
    return `tcpdump: error: ${opt.readFile}: bad dump file format`;
  }
  const filter = compileFilter(opt.filterTokens);
  const predicate = filter.ok ? filter.predicate : () => true;
  const lines: string[] = [
    `reading from file ${opt.readFile}, link-type ${opt.linkType} (Ethernet), snapshot length ${opt.snaplen}`,
  ];
  let prev: Date | null = null;
  for (const frame of frames) {
    if (!predicate(frame)) continue;
    lines.push(formatFrame(frame, opt, prev));
    prev = frame.at;
  }
  return lines.join('\n');
}
