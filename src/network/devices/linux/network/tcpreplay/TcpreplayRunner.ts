import { decodePcap } from '@/network/capture/pcap/PcapFile';
import { captureDeviceOrder, type CaptureDevice } from '../tcpdump/TcpdumpCli';
import { fatalText, warningText } from './TcpreplayDiagnostics';
import {
  ReplayEngine, Sender, type OpenOutcome, type Packet, type PacketSource, type ReplayHost, type ReplayInput,
} from './TcpreplayEngine';
import { ReplayFatal, datalinkOfLinkType } from './TcpreplayLink';
import { parseTcpreplayArguments, type ParsedOptions } from './TcpreplayOptions';
import { resolveSettings } from './TcpreplaySettings';

export interface InterfaceFacts {
  readonly up: boolean;
  readonly loopback: boolean;
}

export type PathFacts =
  | { readonly kind: 'file' | 'directory' | 'other' }
  | { readonly error: string };

export interface TcpreplayDeps {
  readonly userIsRoot: boolean;
  readonly capturePermitted: boolean;
  processId(): number;
  devices(): CaptureDevice[];
  interfaceFacts(name: string): InterfaceFacts | null;
  transmit(device: string, frame: Uint8Array): number | null;
  nowMicros(): number;
  sleepMicros(micros: number): void;
  formatTime(micros: number): string;
  stat(path: string): PathFacts;
  readFile(path: string): Uint8Array | { error: string };
  writeFile(path: string, content: string): void;
  savedAtText(): string;
  walk(directory: string): string[];
  standardInput(): { bytes: Uint8Array; text: string } | null;
  decode(capture: Uint8Array, argv: string[]): Promise<{ stdout: string; stderr: string; chunks: ReadonlyArray<{ fd: 1 | 2; text: string }> }>;
  yieldControl(): Promise<void>;
  onCancelRequested(listener: () => void): () => void;
  runsSupervised(): boolean;
}

export interface TcpreplayChunk {
  readonly fd: 1 | 2;
  readonly text: string;
}

export interface TcpreplayResult {
  readonly chunks: readonly TcpreplayChunk[];
  readonly exitCode: number;
}

const MAX_FILES = 1024;
const UNSUPERVISED_WINDOW_MS = 200;
const CACHE_MAGIC = [0x74, 0x63, 0x70, 0x70, 0x72, 0x65, 0x70, 0x00];
const CACHE_HEADER_BYTES = 24;
const CACHE_VERSION = 4;

function sourceOf(bytes: Uint8Array): OpenOutcome {
  const read = decodePcap(bytes);
  if (read.kind === 'unreadable') return { kind: 'error', message: read.message };
  const header = read.header;
  const records = read.records;
  let position = 0;
  const source: PacketSource = {
    datalink: datalinkOfLinkType(header.linkType),
    snapshot: read.snapshot,
    next(): Packet | null {
      const record = records[position++];
      if (record === undefined) return null;
      const micros = header.nanosecond ? Math.floor(record.subsecond / 1000) : record.subsecond;
      return {
        header: { seconds: record.seconds, micros, caplen: record.capturedLength, length: record.originalLength },
        data: record.data,
      };
    },
  };
  return { kind: 'ok', source };
}

function strtoul(text: string): number {
  return Number.parseInt(text, 10);
}

function decodeTokens(decodeArguments: string | null): string[] {
  const options = ((decodeArguments ?? '') + ' -n -l -r -').slice(0, 255);
  const tokens = options.split(/[ -]+/).filter((token) => token !== '');
  return [...tokens.map((token) => `-${token}`), '-'];
}

class Output {
  readonly chunks: TcpreplayChunk[] = [];
  emit(fd: 1 | 2, text: string): void {
    if (text !== '') this.chunks.push({ fd, text });
  }
}

export async function runTcpreplay(argv: string[], deps: TcpreplayDeps): Promise<TcpreplayResult> {
  const output = new Output();
  const emit = (fd: 1 | 2, text: string) => output.emit(fd, text);
  const finish = (exitCode: number): TcpreplayResult => ({ chunks: output.chunks, exitCode });
  const devices = deps.devices();
  const listing = captureDeviceOrder(devices);

  if (!deps.userIsRoot) {
    emit(2, warningText('interface.c', 'get_interface_list', 80, 'May need to run as root to get access to all network interfaces.'));
  }

  const parsed = parseTcpreplayArguments(argv, {
    processId: () => deps.processId(),
    emit,
    readConfiguration: (path) => {
      const content = deps.readFile(path);
      return content instanceof Uint8Array ? { text: String.fromCharCode(...content) } : content;
    },
    writeConfiguration: (path, content) => deps.writeFile(path, content),
    saveHeaderDate: () => deps.savedAtText(),
  });
  if (parsed.kind === 'exit') return finish(parsed.exitCode);
  if (parsed.kind === 'list-interfaces') {
    emit(1, 'Available network interfaces:\n');
    for (const device of listing) if (!device.loopback) emit(1, `${device.name}\n`);
    return finish(0);
  }

  const options: ParsedOptions = parsed.options;
  const operands = parsed.operands;
  const debugLevel = options.get('dbug')?.value ?? 0;

  try {
    const lines = (deps.standardInput()?.text ?? '').split('\n');
    let nextLine = 0;
    const host: ReplayHost = {
      nowMicros: () => deps.nowMicros(),
      sleepMicros: (micros) => deps.sleepMicros(micros),
      transmit: (device, frame) => deps.transmit(device, frame),
      formatTime: (micros) => deps.formatTime(micros),
      emit,
      readInputLine: () => (nextLine < lines.length && !(nextLine === lines.length - 1 && lines[nextLine] === '') ? `${lines[nextLine++]}\n` : null),
      yieldControl: () => deps.yieldControl(),
      decode: async (capture, decodeArguments) => {
        const result = await deps.decode(capture, decodeTokens(decodeArguments));
        for (const chunk of result.chunks) emit(chunk.fd, chunk.text);
      },
    };

    const alias = (name: string): string | null => {
      for (let index = 0; index < listing.length; index++) {
        if (name === `%${index}` || name === listing[index].name) return listing[index].name;
      }
      return null;
    };
    const open = (name: string, direction: 'primary' | 'secondary'): Sender => {
      if (debugLevel >= 1) emit(2, `DEBUG1 in sendpacket.c:sendpacket_open_pf() line 902: sendpacket: using PF_PACKET\n`);
      const refusal = (message: string): ReplayFatal => new ReplayFatal(fatalText('sendpacket.c', 'sendpacket_open', 551, `failed to open device ${name}: ${message}`));
      if (!deps.capturePermitted) throw refusal('socket: Operation not permitted');
      const facts = deps.interfaceFacts(name);
      if (facts === null) throw refusal('ioctl: No such device');
      if (!facts.up) throw refusal(`error opening ${name}: Network is down`);
      if (facts.loopback) {
        emit(2, warningText('sendpacket.c', 'sendpacket_open_pf', 953,
          `Unsupported physical layer type 0x0304 on ${name}.  Maybe it works, maybe it won't.  See tickets #123/318`));
      }
      return new Sender(name, direction, host);
    };

    const outcome = resolveSettings(options, operands.length, { alias, open });
    if (outcome.kind === 'failed') {
      emit(2, outcome.text);
      return finish(255);
    }
    for (const warning of outcome.warnings) emit(2, warning);

    let routing: { packets: number; data: Uint8Array } | null = null;
    if (outcome.settings.cachefile !== null) routing = readCache(outcome.settings.cachefile, deps);

    if (outcome.settings.preload && !outcome.settings.quiet) emit(2, 'File Cache is enabled\n');

    const paths: string[] = [];
    for (const operand of operands) {
      if (operand === '-') {
        paths.push(operand);
        continue;
      }
      const facts = deps.stat(operand);
      if ('error' in facts) {
        throw new ReplayFatal(fatalText('tcpreplay.c', 'main', 118, `Unable to retrieve information from file ${operand}: ${facts.error}`));
      }
      if (facts.kind === 'directory') paths.push(...deps.walk(operand));
      else paths.push(operand);
    }
    const inputs: ReplayInput[] = paths.slice(0, MAX_FILES).map((path) => ({
      path,
      open: (): OpenOutcome => {
        const bytes = path === '-' ? deps.standardInput()?.bytes ?? new Uint8Array(0) : deps.readFile(path);
        if (!(bytes instanceof Uint8Array)) return { kind: 'error', message: `${path}: ${bytes.error}` };
        return sourceOf(bytes);
      },
    }));

    const engine = new ReplayEngine(outcome.settings, host, outcome.primary, outcome.secondary, inputs, routing);
    const stopListening = deps.onCancelRequested(() => engine.interrupt());
    const watchdog = outcome.settings.loop === 0 && !deps.runsSupervised() ? setTimeout(() => engine.interrupt(), UNSUPERVISED_WINDOW_MS) : null;
    try {
      if (outcome.settings.preload) engine.preloadAll();
      const rcode = await engine.replay();
      if (rcode < 0) {
        emit(2, `\nFailed: ${engine.error}\n\n`);
        return finish(255);
      }
    } finally {
      stopListening();
      if (watchdog !== null) clearTimeout(watchdog);
    }

    if (engine.stats.bytesSent > 0) {
      engine.printPacketStatistics();
      if (outcome.settings.flowStats) emit(1, engine.flowStatisticsText());
      emit(1, outcome.primary.statisticsText());
      if (outcome.secondary !== null) emit(1, outcome.secondary.statisticsText());
    }
    return finish(0);
  } catch (stop) {
    if (stop instanceof ReplayFatal) {
      emit(2, stop.text);
      return finish(255);
    }
    throw stop;
  }
}

function readCache(path: string, deps: TcpreplayDeps): { packets: number; data: Uint8Array } {
  const fatal = (line: number, message: string): ReplayFatal => new ReplayFatal(fatalText('cache.c', 'read_cache', line, message));
  const content = deps.readFile(path);
  if (!(content instanceof Uint8Array)) throw fatal(75, `unable to open ${path}:${content.error}`);
  if (content.length < CACHE_HEADER_BYTES) throw fatal(82, `Cache file ${path} doesn't contain a full header`);
  if (!CACHE_MAGIC.every((value, index) => content[index] === value)) throw fatal(86, `Unable to process ${path}: not a tcpprep cache file`);
  const version = strtoul(String.fromCharCode(...content.subarray(8, 12)).replace(/\0.*$/, ''));
  if (version !== CACHE_VERSION) throw fatal(90, `Unable to process ${path}: cache file version mismatch`);
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const packets = Number(view.getBigUint64(12));
  const perByte = view.getUint16(20);
  const commentLength = view.getUint16(22);
  if (commentLength > 65534) throw fatal(95, `Unable to process ${path}: invalid comment length ${commentLength}`);
  const afterComment = CACHE_HEADER_BYTES + commentLength;
  const readComment = Math.max(0, Math.min(commentLength, content.length - CACHE_HEADER_BYTES));
  if (readComment !== commentLength) throw fatal(105, `Invalid comment read: expected=${commentLength} actual=${readComment} bytes`);
  const size = Math.floor(packets / perByte) + (packets % perByte !== 0 ? 1 : 0);
  const data = content.subarray(afterComment, afterComment + size);
  if (data.length !== size) throw fatal(126, `Cache data length (${data.length} bytes) doesn't match cache header (${size} bytes)`);
  return { packets, data };
}
