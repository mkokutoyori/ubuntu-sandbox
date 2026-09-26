import type { CaptureFrame } from './CaptureFrame';
import { compileFilter } from './TcpdumpFilter';
import {
  parseInvocation,
  listInterfacesText,
  expandFilterTokens,
  type TcpdumpOptions,
} from './TcpdumpCli';
import {
  TcpdumpRenderState, banner, footer, formatFrame, linkTypeDescription, type CookedInterfaces,
} from './TcpdumpFormat';
import {
  deserializeCaptureFile, type CaptureFileHeader, type CapturedInterface,
} from './CaptureFileFormat';
import { CaptureFileWriter } from './CaptureFileWriter';
import { CaptureNamer, filterNamesFor, type CaptureNames } from './TcpdumpNames';

export interface TcpdumpDeps {
  interfaceNames(): string[];
  interfaceExists(name: string): boolean;
  interfaceUp(name: string): boolean;
  interfaceCarrier?(name: string): boolean;
  interfaceMac?(name: string): string | null;
  interfaceNetwork?(name: string): { address: string; mask: string } | null;
  openCapture(iface: string, sink: (frame: CaptureFrame) => void): () => void;
  now(): Date;
  delay(ms: number): Promise<void>;
  onCancelRequested(cb: () => void): () => void;
  runsDetached?(): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, content: string, asUser?: string): boolean;
  dirWritable(path: string, asUser?: string): boolean;
  userExists?(name: string): boolean;
  names?: CaptureNames;
  stream?: { line(text: string): void };
}

const CAPTURE_WINDOW_MS = 200;
const CAPTURE_DEADLINE_WITH_TARGET_MS = 3000;
const PRINTED_LINK_TYPES = new Set(['EN10MB', 'LINUX_SLL', 'LINUX_SLL2']);

export interface TranscriptEntry {
  fd: 1 | 2;
  text: string;
}

export interface TcpdumpResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  transcript: TranscriptEntry[];
}

class Transcript {
  readonly entries: TranscriptEntry[] = [];

  constructor(private readonly stream?: { line(text: string): void }) {}

  out(text: string): void {
    this.push(1, text);
  }

  err(text: string): void {
    this.push(2, text);
  }

  private push(fd: 1 | 2, text: string): void {
    if (this.stream) {
      for (const line of text.split('\n')) this.stream.line(line);
      return;
    }
    this.entries.push({ fd, text });
  }

  result(exitCode: number): TcpdumpResult {
    const joined = (fd: 1 | 2) => this.entries.filter((e) => e.fd === fd).map((e) => e.text).join('\n');
    return { stdout: joined(1), stderr: joined(2), exitCode, transcript: this.entries };
  }
}

export function interleaveTcpdumpStreams(result: TcpdumpResult): string {
  return result.transcript.map((e) => e.text).filter((text) => text.length > 0).join('\n');
}

export async function runTcpdump(tokens: string[], deps: TcpdumpDeps): Promise<TcpdumpResult> {
  const invocation = parseInvocation(tokens);
  const transcript = new Transcript(deps.stream);

  switch (invocation.kind) {
    case 'error':
      transcript.err(invocation.message);
      return transcript.result(1);
    case 'help':
    case 'version':
      transcript.out(invocation.text);
      return transcript.result(0);
    case 'list-interfaces':
      transcript.out(listInterfacesText(deps.interfaceNames().map((name) => ({
        name,
        up: name === 'lo' || deps.interfaceUp(name),
        carrier: name === 'lo' || (deps.interfaceCarrier?.(name) ?? deps.interfaceUp(name)),
      }))));
      return transcript.result(0);
    case 'list-link-types':
      return listLinkTypes(invocation.iface, deps, transcript);
    case 'capture':
      for (const warning of invocation.options.warnings) transcript.err(warning);
      return runCapture(invocation.options, deps, transcript);
  }
}

function linkTypesOf(iface: string): string[] {
  if (iface === 'any') return ['LINUX_SLL2', 'LINUX_SLL'];
  if (iface === 'lo') return ['EN10MB'];
  return ['EN10MB', 'DOCSIS'];
}

function listLinkTypes(iface: string, deps: TcpdumpDeps, transcript: Transcript): TcpdumpResult {
  const physical = iface !== 'any' && iface !== 'lo';
  if (physical && !deps.interfaceExists(iface)) {
    transcript.err(noSuchDevice(iface));
    return transcript.result(1);
  }
  const lines = [`Data link types for ${iface} (use option -y to set):`];
  for (const type of linkTypesOf(iface)) lines.push(`  ${type} (${linkTypeDescription(type)})`);
  transcript.err(lines.join('\n'));
  return transcript.result(0);
}

function noSuchDevice(iface: string): string {
  return `tcpdump: ${iface}: No such device exists\n(SIOCGIFHWADDR: No such device)`;
}

function interfaceTable(deps: TcpdumpDeps): CapturedInterface[] {
  return deps.interfaceNames().map((name, i) => ({
    name, index: i + 1, mac: name === 'lo' ? '00:00:00:00:00:00' : deps.interfaceMac?.(name) ?? null,
  }));
}

function cookedFor(linkType: string, interfaces: readonly CapturedInterface[]): CookedInterfaces | null {
  if (linkType !== 'LINUX_SLL' && linkType !== 'LINUX_SLL2') return null;
  const byName = new Map(interfaces.map((i) => [i.name, i]));
  return {
    version: linkType === 'LINUX_SLL' ? 1 : 2,
    index: (name) => byName.get(name)?.index ?? 0,
    mac: (name) => byName.get(name)?.mac ?? null,
  };
}

function ipv4Number(text: string): number {
  return text.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function localNetworkOf(
  opt: TcpdumpOptions, deps: TcpdumpDeps, transcript: Transcript,
): ((ip: string) => boolean) | undefined {
  if (!opt.foreignNumeric) return undefined;
  const network = deps.interfaceNetwork?.(opt.iface) ?? null;
  if (network === null) {
    transcript.err(`tcpdump: WARNING: foreign (-f) flag used but: ${opt.iface}: no IPv4 address assigned`);
    return undefined;
  }
  const mask = ipv4Number(network.mask);
  const local = (ipv4Number(network.address) & mask) >>> 0;
  return (ip) => !ip.includes(':') && ((ipv4Number(ip) & mask) >>> 0) === local;
}

function renderStateFor(
  opt: TcpdumpOptions, deps: TcpdumpDeps, linkType: string, interfaces: readonly CapturedInterface[],
  isLocal?: (ip: string) => boolean,
): { state: TcpdumpRenderState; namer: CaptureNamer | null } {
  const namer = opt.numeric || deps.names === undefined
    ? null
    : new CaptureNamer(deps.names, { stripDomain: opt.stripDomain, isLocal });
  return { state: new TcpdumpRenderState(namer, cookedFor(linkType, interfaces)), namer };
}

function filterTokensOf(opt: TcpdumpOptions, deps: TcpdumpDeps): string[] | string {
  if (opt.filterFile === null) return opt.filterTokens;
  const content = deps.readFile(opt.filterFile);
  if (content === null) return `tcpdump: can't open ${opt.filterFile}: No such file or directory`;
  const uncommented = content.split('\n').map((line) => line.replace(/#.*$/, '')).join(' ');
  return expandFilterTokens([uncommented]);
}

async function compileCaptureFilter(
  opt: TcpdumpOptions, deps: TcpdumpDeps,
): Promise<ReturnType<typeof compileFilter>> {
  const tokens = filterTokensOf(opt, deps);
  if (typeof tokens === 'string') return { ok: false, message: tokens };
  const names = await filterNamesFor(deps.names, (probe) => compileFilter(tokens, probe));
  return compileFilter(tokens, names);
}

function activationErrorOf(opt: TcpdumpOptions, deps: TcpdumpDeps): string | null {
  const physical = opt.iface !== 'any' && opt.iface !== 'lo';
  if (physical && !deps.interfaceExists(opt.iface)) return noSuchDevice(opt.iface);
  if (opt.monitorMode) return `tcpdump: ${opt.iface}: That device doesn't support monitor mode`;
  if (physical && !deps.interfaceUp(opt.iface)) return `tcpdump: ${opt.iface}: That device is not up`;
  return null;
}

function reachesHost(frame: CaptureFrame, ownMac: string | null): boolean {
  if (frame.direction === 'out' || ownMac === null) return true;
  const dst = frame.dstMac.toLowerCase();
  return dst === ownMac.toLowerCase() || (parseInt(dst.slice(0, 2), 16) & 0x01) === 1;
}

async function runCapture(
  opt: TcpdumpOptions, deps: TcpdumpDeps, transcript: Transcript,
): Promise<TcpdumpResult> {
  if (opt.fileListFile !== null) return readFileList(opt, deps, transcript);
  if (opt.readFile !== null) return readCaptureFiles(opt, deps, transcript, [opt.readFile]);

  const activationError = activationErrorOf(opt, deps);
  if (activationError !== null) { transcript.err(activationError); return transcript.result(1); }

  const supported = linkTypesOf(opt.iface);
  const linkType = opt.requestedLinkType ?? supported[0];
  if (!supported.includes(linkType)) {
    transcript.err(`tcpdump: ${linkType} is not one of the DLTs supported by this device`);
    return transcript.result(1);
  }
  if (!PRINTED_LINK_TYPES.has(linkType)) {
    transcript.err(`tcpdump: ${linkType}: this simulator has no ${linkTypeDescription(linkType)} link-layer printer`);
    return transcript.result(1);
  }
  if (opt.requestedLinkType !== null) transcript.err(`tcpdump: data link type ${linkType}`);
  const effective: TcpdumpOptions = { ...opt, linkType };

  const filter = await compileCaptureFilter(effective, deps);
  if (filter.ok === false) { transcript.err(filter.message); return transcript.result(1); }

  if (opt.dropUser !== null) {
    if (deps.userExists?.(opt.dropUser) !== true) {
      transcript.err(`tcpdump: Couldn't find user '${opt.dropUser.slice(0, 32)}'`);
      return transcript.result(1);
    }
    transcript.err(`dropped privs to ${opt.dropUser}`);
  }
  const writerUser = opt.dropUser ?? undefined;

  const interfaces = interfaceTable(deps);
  const fileHeader: CaptureFileHeader = { linkType, snaplen: opt.snaplen, interfaces };
  const writer = opt.writeFile === null ? null : new CaptureFileWriter(
    opt.writeFile,
    { sizeLimitMegabytes: opt.fileSizeLimit, rotateSeconds: opt.rotateSeconds, fileCount: opt.fileCount },
    fileHeader,
    (path, content) => deps.writeFile(path, content, writerUser),
    () => deps.now(),
  );
  if (writer !== null && (!deps.dirWritable(writer.fileName, writerUser) || !writer.open())) {
    transcript.err(`tcpdump: ${writer.fileName}: Permission denied`);
    return transcript.result(1);
  }

  const printsPackets = !opt.countOnly && (writer === null || opt.printWhileWriting);
  const ownMac = opt.noPromiscuous && opt.iface !== 'any' ? deps.interfaceMac?.(opt.iface) ?? null : null;
  const isLocal = localNetworkOf(opt, deps, transcript);
  const { state, namer } = renderStateFor(effective, deps, linkType, interfaces, isLocal);
  for (const line of banner(effective)) transcript.err(line);

  const collected: CaptureFrame[] = [];
  let rendering: Promise<void> = Promise.resolve();
  let limitReached = false;
  const target = opt.count;
  const detached = deps.runsDetached?.() === true;
  const streaming = deps.stream !== undefined;

  await new Promise<void>((resolve) => {
    let settled = false;
    let unsubscribeCapture: (() => void) | null = null;
    let unsubscribeCancel: (() => void) | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribeCapture?.();
      unsubscribeCancel?.();
      rendering.then(resolve);
    };
    unsubscribeCapture = deps.openCapture(opt.iface, (frame) => {
      if (settled) return;
      if (opt.direction !== 'inout' && frame.direction !== opt.direction) return;
      if (!reachesHost(frame, ownMac)) return;
      if (!filter.predicate(frame)) return;
      if (writer !== null && writer.add(frame) === 'limit-reached') {
        limitReached = true;
        finish();
        return;
      }
      collected.push(frame);
      if (printsPackets) {
        rendering = rendering.then(async () => {
          await namer?.prepare(frame);
          transcript.out(formatFrame(frame, effective, state));
        });
      }
      if (target !== null && collected.length >= target) finish();
    });
    unsubscribeCancel = deps.onCancelRequested(finish);
    if (settled) {
      unsubscribeCapture();
    } else if (streaming) {
      return;
    } else if (detached && target === null) {
      resolve();
    } else {
      const deadline = target !== null ? CAPTURE_DEADLINE_WITH_TARGET_MS : CAPTURE_WINDOW_MS;
      deps.delay(deadline).then(finish);
    }
  });

  if (limitReached) transcript.err(`Maximum file limit reached: ${opt.fileCount ?? 0}`);
  for (const line of footer(collected.length, collected.length)) transcript.err(line);
  return transcript.result(0);
}

function readFileList(opt: TcpdumpOptions, deps: TcpdumpDeps, transcript: Transcript): Promise<TcpdumpResult> {
  const list = deps.readFile(opt.fileListFile!);
  if (list === null) {
    transcript.err(`tcpdump: Unable to open file list ${opt.fileListFile}: No such file or directory`);
    return Promise.resolve(transcript.result(1));
  }
  const files = list.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return readCaptureFiles(opt, deps, transcript, files);
}

async function readCaptureFiles(
  opt: TcpdumpOptions, deps: TcpdumpDeps, transcript: Transcript, files: readonly string[],
): Promise<TcpdumpResult> {
  let printed = 0;
  for (const path of files) {
    const content = deps.readFile(path);
    if (content === null) {
      transcript.err(`tcpdump: ${path}: No such file or directory`);
      return transcript.result(1);
    }
    const file = deserializeCaptureFile(content);
    if (file === null) {
      transcript.err('tcpdump: unknown file format');
      return transcript.result(1);
    }
    const { linkType, snaplen, interfaces } = file.header;
    const effective: TcpdumpOptions = { ...opt, linkType, snaplen };
    const filter = await compileCaptureFilter(effective, deps);
    if (filter.ok === false) { transcript.err(filter.message); return transcript.result(1); }
    transcript.err(`reading from file ${path}, link-type ${linkType} (${linkTypeDescription(linkType)}), snapshot length ${snaplen}`);
    const { state, namer } = renderStateFor(effective, deps, linkType, interfaces);
    for (const frame of file.frames) {
      if (opt.count !== null && printed >= opt.count) break;
      if (opt.direction !== 'inout' && frame.direction !== opt.direction) continue;
      if (!filter.predicate(frame)) continue;
      printed++;
      if (opt.countOnly) continue;
      await namer?.prepare(frame);
      transcript.out(formatFrame(frame, effective, state));
    }
  }
  if (opt.countOnly) transcript.out(`${printed} packet${printed === 1 ? '' : 's'}`);
  return transcript.result(0);
}
