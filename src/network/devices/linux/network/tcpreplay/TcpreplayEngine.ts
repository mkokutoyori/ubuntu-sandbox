import { encodePcap } from '@/network/capture/pcap/PcapFile';
import { debugText, fatalText, warningText } from './TcpreplayDiagnostics';
import { FlowTable, uniqueAddressEdit, type FlowEntryType } from './TcpreplayFlows';
import { ReplayFatal, linkTypeOfDatalink } from './TcpreplayLink';
import type { ReplaySettings } from './TcpreplaySettings';

export interface PacketHeader {
  readonly seconds: number;
  readonly micros: number;
  caplen: number;
  readonly length: number;
}

export interface Packet {
  readonly header: PacketHeader;
  data: Uint8Array;
}

export interface PacketSource {
  readonly datalink: number;
  readonly snapshot: number;
  next(): Packet | null;
}

export type OpenOutcome =
  | { readonly kind: 'ok'; readonly source: PacketSource }
  | { readonly kind: 'error'; readonly message: string };

export interface ReplayInput {
  readonly path: string;
  open(): OpenOutcome;
}

export interface ReplayHost {
  nowMicros(): number;
  sleepMicros(micros: number): void;
  transmit(device: string, frame: Uint8Array): number | null;
  formatTime(micros: number): string;
  emit(fd: 1 | 2, text: string): void;
  readInputLine(): string | null;
  yieldControl(): Promise<void>;
  decode(capture: Uint8Array, decodeArguments: string | null): Promise<void>;
}

export interface CacheRouting {
  readonly packets: number;
  readonly data: Uint8Array;
}

export const ERRNO_TEXT: Readonly<Record<number, string>> = {
  1: 'Operation not permitted',
  5: 'Input/output error',
  22: 'Invalid argument',
  90: 'Message too long',
};

const MAX_SNAPLEN = 262144;
const COUNTER_OVERFLOW_RISK = (1n << 44n) - 1n;
const CACHE_PACKETS_PER_BYTE = 4;
const CACHE_BITS_PER_PACKET = 2;

type Direction = 'primary' | 'secondary';

export class Sender {
  sent = 0;
  failed = 0;
  truncated = 0;
  retriedNoBuffers = 0;
  retriedAgain = 0;
  flows = 0;
  flowsUnique = 0;
  flowsExpired = 0;
  flowPackets = 0;
  nonFlowPackets = 0;
  invalidFlowPackets = 0;
  lastError = '';

  constructor(readonly device: string, readonly direction: Direction, private readonly host: ReplayHost) {}

  send(bytes: Uint8Array): number {
    if (bytes.length === 0) return -1;
    const errno = this.host.transmit(this.device, bytes);
    if (errno !== null) {
      this.lastError = `Error with PF_PACKET send() [${this.sent + this.failed + 1}]: ${ERRNO_TEXT[errno] ?? 'Unknown error'} (errno = ${errno})`;
      this.failed++;
      return -1;
    }
    this.sent++;
    return bytes.length;
  }

  statisticsText(): string {
    let text = `Statistics for network device: ${this.device}\n`
      + `\tSuccessful packets:        ${this.sent}\n`
      + `\tFailed packets:            ${this.failed}\n`
      + `\tTruncated packets:         ${this.truncated}\n`
      + `\tRetried packets (ENOBUFS): ${this.retriedNoBuffers}\n`
      + `\tRetried packets (EAGAIN):  ${this.retriedAgain}\n`;
    if (this.flowPackets > 0) {
      text += `\tFlows total:               ${this.flows}\n`
        + `\tFlows unique:              ${this.flowsExpired}\n`
        + `\tFlows expired:             ${this.flowsExpired}\n`
        + `\tFlow packets:              ${this.flowPackets}\n`
        + `\tNon-flow packets:          ${this.nonFlowPackets}\n`
        + `\tInvalid flow packets:      ${this.invalidFlowPackets}\n`;
    }
    return text;
  }
}

interface Statistics {
  startTime: number;
  timeDelta: number;
  endTime: number;
  packetTimestampDelta: number;
  lastPrint: number;
  packetsSent: number;
  bytesSent: number;
  failed: number;
  flows: number;
  flowsUnique: number;
  flowsExpired: number;
  flowPackets: number;
  nonFlowPackets: number;
  invalidFlowPackets: number;
}

interface FileCache {
  cached: boolean;
  packets: Packet[];
  datalink: number;
  snapshot: number;
}

function freshStatistics(): Statistics {
  return {
    startTime: 0, timeDelta: 0, endTime: 0, packetTimestampDelta: 0, lastPrint: 0, packetsSent: 0, bytesSent: 0, failed: 0,
    flows: 0, flowsUnique: 0, flowsExpired: 0, flowPackets: 0, nonFlowPackets: 0, invalidFlowPackets: 0,
  };
}

function paddedTo(data: Uint8Array, length: number): Uint8Array {
  if (data.length >= length) return data.subarray(0, length);
  const padded = new Uint8Array(length);
  padded.set(data);
  return padded;
}

class TcpdumpFeed {
  private readonly records: Array<{ seconds: number; subsecond: number; originalLength: number; data: Uint8Array }> = [];

  constructor(private readonly datalink: number, private readonly snapshot: number) {}

  add(packet: Packet): void {
    this.records.push({
      seconds: packet.header.seconds >>> 0,
      subsecond: packet.header.seconds >>> 0,
      originalLength: packet.header.length,
      data: packet.data.slice(0, packet.header.caplen),
    });
  }

  bytes(): Uint8Array {
    return encodePcap({ linkType: linkTypeOfDatalink(this.datalink), snaplen: this.snapshot, nanosecond: false }, this.records);
  }
}

export class ReplayEngine {
  readonly stats: Statistics = freshStatistics();
  readonly flowTable = new FlowTable();
  iteration = 0;
  uniqueIteration = 0;
  lastUniqueIteration = 0;
  aborted = false;
  private firstTime = true;
  private napNanos = 0;
  private skipPackets = 0;
  private errorText = '';
  private loopsLeft: number;
  private readonly caches: FileCache[] = [];
  private stdoutClosed = false;

  constructor(
    private readonly settings: ReplaySettings,
    private readonly host: ReplayHost,
    private readonly primary: Sender,
    private readonly secondary: Sender | null,
    private readonly inputs: readonly ReplayInput[],
    private readonly routing: CacheRouting | null,
  ) {
    this.loopsLeft = settings.loop;
    for (let i = 0; i < inputs.length; i++) this.caches.push({ cached: false, packets: [], datalink: 0, snapshot: 0 });
  }

  get error(): string {
    return this.errorText;
  }

  private out(text: string): void {
    if (!this.stdoutClosed) this.host.emit(1, text);
  }

  private err(text: string): void {
    this.host.emit(2, text);
  }

  private debug(level: number, file: string, fn: string, line: number, message: string): void {
    if (this.settings.debug >= level) this.err(debugText(level, file, fn, line, message));
  }

  private setError(file: string, fn: string, line: number, message: string): void {
    this.errorText = `From ${file}:${fn}() line ${line}:\n${message}`;
  }

  interrupt(): void {
    this.err(' User interrupt...\n');
    this.aborted = true;
    this.out('sendpacket_abort\n');
  }

  preloadAll(): void {
    this.inputs.forEach((_, index) => this.preloadFile(index));
  }

  private preloadFile(index: number): void {
    const input = this.inputs[index];
    if (input.path === '-') this.stdoutClosed = true;
    const opened = input.open();
    if (opened.kind === 'error') {
      throw new ReplayFatal(fatalText('send_packets.c', 'preload_pcap_file', 300, `Error opening pcap file: ${opened.message}`));
    }
    const source = opened.source;
    const cache = this.caches[index];
    for (;;) {
      const packet = this.nextFromSource(source, 886);
      if (packet === null) break;
      cache.packets.push({ header: { ...packet.header }, data: packet.data.slice() });
      if (this.settings.flowStats) this.updateFlowStats(null, packet, source.datalink);
    }
    cache.cached = true;
    cache.datalink = source.datalink;
    cache.snapshot = source.snapshot;
  }

  async replay(): Promise<number> {
    const stats = this.stats;
    stats.startTime = 0;
    stats.timeDelta = 0;
    stats.endTime = 0;
    stats.packetTimestampDelta = 0;
    stats.lastPrint = 0;
    const settings = this.settings;
    const totalLoops = settings.loop;
    let loop = 0;
    if (settings.loop > 0) {
      while (this.loopsLeft-- > 0 && !this.aborted) {
        ++loop;
        if (settings.stats === 0) this.out(this.loopBanner(loop, totalLoops));
        const rcode = await this.replayIndex();
        if (rcode < 0) return rcode;
        if (this.loopsLeft > 0) {
          if (!this.aborted && settings.loopDelayMs > 0) {
            this.host.sleepMicros(settings.loopDelayMs * 1000);
            stats.endTime = this.host.nowMicros();
          }
          if (settings.stats === 0) this.printPacketStatistics();
        }
      }
    } else {
      while (!this.aborted) {
        ++loop;
        if (settings.stats === 0) this.out(this.loopBanner(loop, 0));
        const rcode = await this.replayIndex();
        if (rcode < 0) return rcode;
        if (!this.aborted && settings.loopDelayMs > 0) {
          this.host.sleepMicros(settings.loopDelayMs * 1000);
          stats.endTime = this.host.nowMicros();
        }
        if (settings.stats === 0 && !this.aborted) this.printPacketStatistics();
        await this.host.yieldControl();
      }
    }
    if (settings.stats >= 0) this.out(`Test complete: ${this.host.formatTime(stats.endTime)}\n`);
    return 0;
  }

  private loopBanner(loop: number, total: number): string {
    const unique = this.uniqueIteration !== 0 && loop !== this.uniqueIteration ? ` (${this.uniqueIteration} unique)` : '';
    return total > 0 ? `Loop ${loop} of ${total}${unique}...\n` : `Loop ${loop}${unique}...\n`;
  }

  private async replayIndex(): Promise<number> {
    let rcode = 0;
    if (!this.settings.dualfile) {
      for (let index = 0; index < this.inputs.length && !this.aborted; index++) rcode = await this.replayFile(index);
    } else {
      for (let index = 0; index < this.inputs.length && !this.aborted; index += 2) rcode = await this.replayTwoFiles(index, index + 1);
    }
    return rcode < 0 ? -1 : rcode;
  }

  private snaplenWarning(path: string, snapshot: number): void {
    if (snapshot < 65535) {
      this.err(warningText('replay.c', 'replay_file', 129,
        `${path} was captured using a snaplen of ${snapshot} bytes.  This may mean you have truncated packets.`));
    }
  }

  private async replayFile(index: number): Promise<number> {
    const input = this.inputs[index];
    const cache = this.caches[index];
    let source: PacketSource | null = null;
    if (!this.settings.preload || !cache.cached) {
      const opened = input.open();
      if (opened.kind === 'error') {
        this.setError('replay.c', 'replay_file', this.settings.preload ? 137 : 121, `Error opening pcap file: ${opened.message}`);
        return -1;
      }
      source = opened.source;
      cache.datalink = source.datalink;
      if (!this.settings.preload) this.snaplenWarning(input.path, source.snapshot);
    }
    let feed: TcpdumpFeed | null = null;
    if (this.settings.verbose) {
      if (source === null) {
        const opened = input.open();
        if (opened.kind === 'error') {
          this.setError('replay.c', 'replay_file', 149, `Error opening pcap file: ${opened.message}`);
          return -1;
        }
        source = opened.source;
      }
      cache.datalink = source.datalink;
      feed = new TcpdumpFeed(source.datalink, source.snapshot);
    }
    this.sendPackets(source, index, feed);
    if (feed !== null) await this.host.decode(feed.bytes(), this.settings.decodeArguments);
    return 0;
  }

  private async replayTwoFiles(first: number, second: number): Promise<number> {
    const inputs = [this.inputs[first], this.inputs[second]];
    if (inputs.some((input) => input.path === '-')) {
      this.setError('replay.c', 'replay_two_files', 211, "Invalid use of STDIN '-' in dual file mode");
      return -1;
    }
    const opened: Array<PacketSource | null> = [null, null];
    const indexes = [first, second];
    for (let n = 0; n < 2; n++) {
      const cache = this.caches[indexes[n]];
      if (!this.settings.preload || !cache.cached) {
        const result = inputs[n].open();
        if (result.kind === 'error') {
          this.setError('replay.c', 'replay_two_files', this.settings.preload ? (n === 0 ? 230 : 237) : (n === 0 ? 218 : 223), `Error opening pcap file: ${result.message}`);
          return -1;
        }
        opened[n] = result.source;
        cache.datalink = result.source.datalink;
      }
    }
    let rcode = 0;
    if (opened[0] !== null) {
      for (let n = 0; n < 2; n++) {
        const source = opened[n];
        if (source !== null && source.snapshot < 65535) {
          rcode = -2;
        }
      }
    }
    let feed: TcpdumpFeed | null = null;
    if (this.settings.verbose) {
      const source = opened[0];
      if (source === null) {
        const result = inputs[0].open();
        if (result.kind === 'error') {
          this.setError('replay.c', 'replay_two_files', 297, `Error opening pcap file: ${result.message}`);
          return -1;
        }
        opened[0] = result.source;
      }
      feed = new TcpdumpFeed(opened[0]!.datalink, opened[0]!.snapshot);
    }
    this.sendDualPackets(opened[0], first, opened[1], second, feed);
    if (feed !== null) await this.host.decode(feed.bytes(), this.settings.decodeArguments);
    return rcode;
  }

  private nextFromSource(source: PacketSource, line: number): Packet | null {
    const packet = source.next();
    if (packet === null) {
      this.debug(1, 'utils.c', 'our_safe_pcap_next', 154, 'No data found in packet');
      return null;
    }
    const header = packet.header;
    const where = `send_packets.c:get_next_packet() line ${line}`;
    if (header.length > MAX_SNAPLEN) {
      throw new ReplayFatal(`safe_pcap_next ERROR: Invalid packet length in ${where}: ${header.length} is greater than maximum ${MAX_SNAPLEN}\n`);
    }
    if (header.length === 0 || header.caplen === 0) {
      throw new ReplayFatal(`safe_pcap_next ERROR: Invalid packet length in ${where}: packet length=${header.length} capture length=${header.caplen}\n`);
    }
    if (header.length < header.caplen) {
      this.debug(1, 'utils.c', 'our_safe_pcap_next', 149, `Correcting invalid packet capture length ${header.caplen}: packet length=${header.length}`);
      header.caplen = header.length;
    }
    return packet;
  }

  private nextPacket(source: PacketSource | null, index: number, cursor: { at: number }): Packet | null {
    const cache = this.caches[index];
    if (this.settings.preload && cache.cached) {
      const packet = cache.packets[cursor.at] ?? null;
      if (packet !== null) cursor.at++;
      return packet;
    }
    if (source === null) return null;
    const packet = this.nextFromSource(source, 916);
    if (packet === null) return null;
    return { header: { ...packet.header }, data: packet.data.slice() };
  }

  private updateFlowStats(sender: Sender | null, packet: Packet, datalink: number): void {
    const result: FlowEntryType = this.flowTable.decode(
      packet.data.subarray(0, packet.header.caplen), packet.header.seconds, datalink, this.settings.flowExpiry,
      (text) => this.err(text));
    const stats = this.stats;
    switch (result) {
      case 'new':
        stats.flows++; stats.flowsUnique++; stats.flowPackets++;
        if (sender !== null) { sender.flows++; sender.flowsUnique++; sender.flowPackets++; }
        break;
      case 'existing':
        stats.flowPackets++;
        if (sender !== null) sender.flowPackets++;
        break;
      case 'expired':
        stats.flowsExpired++; stats.flows++; stats.flowPackets++;
        if (sender !== null) { sender.flowsExpired++; sender.flows++; sender.flowPackets++; }
        break;
      case 'non-ip':
        stats.nonFlowPackets++;
        if (sender !== null) sender.nonFlowPackets++;
        break;
      case 'invalid':
        stats.invalidFlowPackets++;
        if (sender !== null) sender.invalidFlowPackets++;
        break;
    }
  }

  private routeByCache(packetNumber: number): Sender | null {
    const routing = this.routing;
    if (routing === null) return this.primary;
    if (packetNumber > routing.packets) {
      this.setError('send_packets.c', 'cache_mode', 859, 'Exceeded number of packets in cache file.');
      return null;
    }
    const index = Math.floor((packetNumber - 1) / CACHE_PACKETS_PER_BYTE);
    let bit = ((packetNumber - 1) % CACHE_PACKETS_PER_BYTE) * CACHE_BITS_PER_PACKET + 1;
    const byte = routing.data[index];
    if ((byte & (1 << bit)) === 0) return null;
    bit--;
    return (byte & (1 << bit)) !== 0 ? this.primary : this.secondary;
  }

  private incrementIteration(): void {
    this.lastUniqueIteration = this.uniqueIteration;
    this.iteration++;
    if (this.settings.uniqueIp) {
      this.uniqueIteration = Math.floor((this.iteration * 1000) / Math.trunc(this.settings.uniqueLoops * 1000)) + 1;
    }
  }

  private isTopSpeed(): boolean {
    return this.settings.speedMode === 'topspeed' || (this.settings.speedMode === 'mbpsrate' && this.settings.speed === 0);
  }

  private sendPackets(source: PacketSource | null, index: number, feed: TcpdumpFeed | null): void {
    const settings = this.settings;
    const stats = this.stats;
    const cache = this.caches[index];
    const preload = cache.cached;
    const cursor = { at: 0 };
    const datalink = preload ? cache.datalink : source!.datalink;
    const topSpeed = this.isTopSpeed();
    let nowIsNow = true;
    let now = this.host.nowMicros();
    if (stats.startTime === 0) {
      stats.startTime = now;
      if (settings.stats >= 0) this.out(`Test start: ${this.host.formatTime(stats.startTime)} ...\n`);
    }
    this.skipPackets = 0;
    let lastPacketTimestamp = 0;
    const endUs = settings.limitTimeSeconds !== null && settings.limitTimeSeconds > 0 ? stats.startTime + settings.limitTimeSeconds * 1000000 : 0;
    const limitSend = settings.limitSend;
    let packetNumber = 0;
    let skipLength = 0;
    let sender = this.primary;

    for (;;) {
      if (this.aborted) break;
      const packet = this.nextPacket(source, index, cursor);
      if (packet === null) break;
      nowIsNow = false;
      packetNumber++;
      let packetLength = settings.useActualLength ? packet.header.length : packet.header.caplen;

      if (this.secondary !== null) {
        const routed = this.routeByCache(packetNumber);
        if (routed === null) continue;
        sender = routed;
      }

      if (settings.uniqueIp && this.uniqueIteration !== 0 && this.uniqueIteration > this.lastUniqueIteration) {
        if (!uniqueAddressEdit(packet.data, this.uniqueIteration - 1, preload, datalink)) {
          stats.failed++;
          continue;
        }
      }

      if (settings.flowStats && !preload) this.updateFlowStats(this.routing !== null && this.routing.packets > 0 ? sender : null, packet, datalink);

      if (skipLength !== 0 && packetLength < skipLength) {
        skipLength -= packetLength;
      } else if (this.skipPackets !== 0) {
        --this.skipPackets;
      } else {
        skipLength = 0;
        this.skipPackets = 0;
        if (settings.speedMode === 'multiplier') {
          const timestamp = packet.header.seconds * 1000000 + packet.header.micros;
          if (lastPacketTimestamp === 0) lastPacketTimestamp = timestamp;
          else if (timestamp > lastPacketTimestamp) {
            stats.packetTimestampDelta += timestamp - lastPacketTimestamp;
            lastPacketTimestamp = timestamp;
          }
        }
        if (!topSpeed) {
          nowIsNow = true;
          now = this.host.nowMicros();
        }
        skipLength = this.calcSleepTime(packetLength, sender, packetNumber, skipLength);
        if (stats.timeDelta < stats.packetTimestampDelta) stats.timeDelta = stats.packetTimestampDelta;
        if (!topSpeed) now = this.sleepNap(now);
      }

      if (feed !== null) feed.add(packet);

      const wire = paddedTo(packet.data, packetLength);
      if (sender.send(wire) < packetLength) {
        this.err(warningText('send_packets.c', 'send_packets', 503, `Unable to send packet: ${sender.lastError}`));
        continue;
      }
      packetLength = wire.length;
      stats.endTime = now;
      stats.packetsSent++;
      stats.bytesSent += packetLength;

      if (settings.stats > 0) {
        if (stats.lastPrint === 0) stats.lastPrint = now;
        else if (Math.trunc((now - stats.lastPrint) / 1000000) >= settings.stats) {
          stats.endTime = now;
          this.printPacketStatistics();
          stats.lastPrint = now;
        }
      }

      if ((endUs > 0 && now > endUs) || (limitSend !== null && limitSend > 0 && stats.packetsSent >= limitSend)) this.aborted = true;
    }

    if (!nowIsNow) now = this.host.nowMicros();
    stats.endTime = now;
    this.incrementIteration();
  }

  private sendDualPackets(
    firstSource: PacketSource | null, firstIndex: number, secondSource: PacketSource | null, secondIndex: number, feed: TcpdumpFeed | null,
  ): void {
    const settings = this.settings;
    const stats = this.stats;
    const secondary = this.secondary!;
    const topSpeed = this.isTopSpeed();
    const cursors = [{ at: 0 }, { at: 0 }];
    let nowIsNow = true;
    let now = this.host.nowMicros();
    if (stats.startTime === 0) {
      stats.startTime = now;
      if (settings.stats >= 0) this.out(`Dual test start: ${this.host.formatTime(stats.startTime)} ...\n`);
    }
    this.skipPackets = 0;
    let lastPacketTimestamp = 0;
    const endUs = settings.limitTimeSeconds !== null && settings.limitTimeSeconds > 0 ? stats.startTime + settings.limitTimeSeconds * 1000000 : 0;
    const limitSend = settings.limitSend;
    let packetNumber = 0;
    let skipLength = 0;
    let first = this.nextPacket(firstSource, firstIndex, cursors[0]);
    let second = this.nextPacket(secondSource, secondIndex, cursors[1]);

    while (!this.aborted && !(first === null && second === null)) {
      nowIsNow = false;
      packetNumber++;
      const timestampOf = (packet: Packet) => packet.header.seconds * 1000000 + packet.header.micros;
      const useSecond = first === null || (second !== null && timestampOf(first) > timestampOf(second));
      const sender = useSecond ? secondary : this.primary;
      const index = useSecond ? secondIndex : firstIndex;
      const packet = (useSecond ? second : first)!;
      const cache = this.caches[index];
      const datalink = cache.cached ? cache.datalink : (useSecond ? secondSource : firstSource)!.datalink;
      let packetLength = settings.useActualLength ? packet.header.length : packet.header.caplen;
      const advance = (): void => {
        if (useSecond) second = this.nextPacket(secondSource, secondIndex, cursors[1]);
        else first = this.nextPacket(firstSource, firstIndex, cursors[0]);
      };

      if (settings.uniqueIp && this.uniqueIteration !== 0 && this.uniqueIteration > this.lastUniqueIteration) {
        if (!uniqueAddressEdit(packet.data, this.uniqueIteration - 1, cache.cached, datalink)) {
          stats.failed++;
          advance();
          continue;
        }
      }

      if (settings.flowStats && !cache.cached) this.updateFlowStats(sender, packet, datalink);

      if (skipLength !== 0 && packetLength < skipLength) {
        skipLength -= packetLength;
      } else if (this.skipPackets !== 0) {
        --this.skipPackets;
      } else {
        skipLength = 0;
        this.skipPackets = 0;
        if (settings.speedMode === 'multiplier') {
          const timestamp = timestampOf(packet);
          if (lastPacketTimestamp === 0) lastPacketTimestamp = timestamp;
          else if (timestamp > lastPacketTimestamp) {
            stats.packetTimestampDelta += timestamp - lastPacketTimestamp;
            lastPacketTimestamp = timestamp;
          }
        }
        if (!topSpeed) {
          nowIsNow = true;
          now = this.host.nowMicros();
        }
        skipLength = this.calcSleepTime(packetLength, sender, packetNumber, skipLength);
        if (stats.timeDelta < stats.packetTimestampDelta) stats.timeDelta = stats.packetTimestampDelta;
        if (!topSpeed) now = this.sleepNap(now);
      }

      if (feed !== null && !useSecond) feed.add(packet);

      const wire = paddedTo(packet.data, packetLength);
      if (sender.send(wire) < packetLength) {
        this.err(warningText('send_packets.c', 'send_dual_packets', 768, `Unable to send packet: ${sender.lastError}`));
        advance();
        continue;
      }
      packetLength = wire.length;
      stats.endTime = now;
      stats.packetsSent++;
      stats.bytesSent += packetLength;

      if (settings.stats > 0) {
        if (stats.lastPrint === 0) stats.lastPrint = now;
        else if (Math.trunc((now - stats.lastPrint) / 1000000) >= settings.stats) {
          stats.endTime = now;
          this.printPacketStatistics();
          stats.lastPrint = now;
        }
      }

      advance();

      if ((endUs > 0 && now > endUs) || (limitSend !== null && limitSend > 0 && stats.packetsSent >= limitSend)) this.aborted = true;
    }

    if (!nowIsNow) now = this.host.nowMicros();
    stats.endTime = now;
    this.incrementIteration();
  }

  private calcSleepTime(length: number, sender: Sender, counter: number, skipLength: number): number {
    const settings = this.settings;
    const stats = this.stats;
    this.napNanos = 0;
    if (settings.speedMode === 'packetrate' && settings.ppsMulti !== 0) this.skipPackets = settings.ppsMulti - 1;
    if (this.firstTime) {
      this.firstTime = false;
      return skipLength;
    }
    switch (settings.speedMode) {
      case 'multiplier':
        if (stats.packetTimestampDelta > stats.timeDelta) {
          this.napNanos = (stats.packetTimestampDelta - stats.timeDelta) * 1000;
          const divisor = settings.multiplier;
          if (divisor !== 0 && divisor !== 1) this.napNanos = Math.trunc(this.napNanos / divisor);
        }
        break;
      case 'mbpsrate': {
        const nowUs = stats.endTime;
        if (nowUs !== 0) {
          const bps = BigInt(settings.speed);
          const bitsSent = BigInt(stats.bytesSent + length) * 8n;
          const transmittedUs = BigInt(nowUs - stats.startTime);
          const nextUs = bitsSent > COUNTER_OVERFLOW_RISK && bps > 500000n ? (bitsSent * 1000n) / bps * 1000n : (bitsSent * 1000000n) / bps;
          if (nextUs > transmittedUs) this.napNanos = Number((nextUs - transmittedUs) * 1000n);
          else if (transmittedUs > nextUs) skipLength = Number(((transmittedUs - nextUs) * bps) / 8000000n);
        }
        break;
      }
      case 'packetrate': {
        const nowUs = stats.endTime;
        if (nowUs !== 0) {
          const pph = BigInt(settings.speed);
          const sent = BigInt(stats.packetsSent);
          const transmittedUs = BigInt(nowUs - stats.startTime);
          const nextUs = sent < COUNTER_OVERFLOW_RISK ? (sent * 1000000n) * 3600n / pph : ((sent * 1000000n) / pph) * 3600n;
          if (nextUs > transmittedUs) this.napNanos = Number((nextUs - transmittedUs) * 1000n);
          else this.skipPackets = settings.ppsMulti;
        }
        break;
      }
      case 'oneatatime':
        if (this.skipPackets === 0) this.skipPackets = this.userCount(sender, counter);
        this.out(`Sending packet ${counter} out: ${sender.device}\n`);
        this.skipPackets--;
        break;
      case 'topspeed':
        break;
    }
    return skipLength;
  }

  private userCount(sender: Sender, counter: number): number {
    this.out(`**** Next packet #${counter} out ${sender.device}.  How many packets do you wish to send? `);
    const line = this.host.readInputLine();
    if (line === null) {
      throw new ReplayFatal(fatalText('send_packets.c', 'get_user_count', 1203, 'Unable to process user input for fd 0: Invalid argument'));
    }
    let count = 0;
    if (line.length > 1) {
      const parsed = /^[ \t\n\v\f\r]*(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(line);
      if (parsed !== null) count = Number(/^0[0-7]+$/.test(parsed[1]) ? BigInt('0o' + parsed[1].slice(1)) : BigInt(parsed[1]));
    }
    if (count === 0) {
      this.debug(1, 'send_packets.c', 'get_user_count', 1220, 'Input was less then 1 or non-numeric, assuming 1');
      count = 1;
    }
    return count;
  }

  private sleepNap(now: number): number {
    let nap = this.napNanos;
    if (nap === 0) return now;
    const maxSleep = this.settings.maxSleepNanos;
    if (maxSleep > 0 && nap > maxSleep) nap = maxSleep;
    this.host.sleepMicros(Math.floor(nap / 1000));
    return this.host.nowMicros();
  }

  printPacketStatistics(): void {
    const stats = this.stats;
    const diffUs = stats.endTime - stats.startTime;
    let bytesPerSecond = 0n;
    let bytesTenths = 0n;
    let megabitsPerSecond = 0n;
    let megabitsHundredths = 0n;
    let megabitsThousandths = 0n;
    let packetsPerSecond = 0n;
    let packetsHundredths = 0n;
    if (diffUs !== 0 && stats.packetsSent !== 0 && stats.bytesSent !== 0) {
      const bytes = BigInt(stats.bytesSent);
      const packets = BigInt(stats.packetsSent);
      const elapsed = BigInt(diffUs);
      let bytesX10: bigint;
      let packetsX100: bigint;
      if (bytes > 1000n * 1000n * 1000n && diffUs > 1000 * 1000) {
        bytesX10 = (bytes * 10n * 1000n) / (elapsed / 1000n);
        packetsX100 = (packets * 100n * 1000n) / (elapsed / 1000n);
      } else {
        bytesX10 = (bytes * 10n * 1000n * 1000n) / elapsed;
        packetsX100 = (packets * 100n * 1000n * 1000n) / elapsed;
      }
      bytesPerSecond = bytesX10 / 10n;
      bytesTenths = bytesX10 % 10n;
      const megabitsX1000 = (bytesPerSecond * 8n) / 1000n;
      const megabitsX100 = megabitsX1000 / 10n;
      megabitsPerSecond = megabitsX1000 / 1000n;
      megabitsHundredths = megabitsX100 % 100n;
      megabitsThousandths = megabitsX1000 % 1000n;
      packetsPerSecond = packetsX100 / 100n;
      packetsHundredths = packetsX100 % 100n;
    }
    const seconds = Math.trunc(diffUs / 1000000);
    const micros = diffUs % 1000000;
    const pad = (value: bigint | number, width: number) => String(value).padStart(width, '0');
    if (diffUs >= 1000 * 1000) {
      this.out(`Actual: ${stats.packetsSent} packets (${stats.bytesSent} bytes) sent in ${seconds}.${pad(Math.trunc(micros / 10000), 2)} seconds\n`);
    } else {
      this.out(`Actual: ${stats.packetsSent} packets (${stats.bytesSent} bytes) sent in ${seconds}.${pad(micros, 6)} seconds\n`);
    }
    if (megabitsPerSecond >= 1n) {
      this.out(`Rated: ${bytesPerSecond}.${bytesTenths} Bps, ${megabitsPerSecond}.${pad(megabitsHundredths, 2)} Mbps, ${packetsPerSecond}.${pad(packetsHundredths, 2)} pps\n`);
    } else {
      this.out(`Rated: ${bytesPerSecond}.${bytesTenths} Bps, ${megabitsPerSecond}.${pad(megabitsThousandths, 3)} Mbps, ${packetsPerSecond}.${pad(packetsHundredths, 2)} pps\n`);
    }
    if (stats.failed > 0) this.out(`Failed write attempts: ${stats.failed}\n`);
  }

  flowStatisticsText(): string {
    const stats = this.stats;
    let { flows, flowsUnique, flowsExpired, flowPackets, nonFlowPackets } = {
      flows: stats.flows, flowsUnique: stats.flowsUnique, flowsExpired: stats.flowsExpired,
      flowPackets: stats.flowPackets, nonFlowPackets: stats.nonFlowPackets,
    };
    const diffUs = stats.endTime - stats.startTime;
    if (flows === 0 || this.iteration === 0) return '';
    if (this.settings.preload && this.lastUniqueIteration !== 0) {
      const factor = this.lastUniqueIteration;
      flows *= factor; flowsUnique *= factor; flowsExpired *= factor; flowPackets *= factor; nonFlowPackets *= factor;
    } else {
      flowPackets = Math.floor((flowPackets * (this.lastUniqueIteration !== 0 ? this.lastUniqueIteration : this.iteration)) / this.iteration);
    }
    let flowsPerSecond = 0n;
    let hundredths = 0n;
    if (diffUs !== 0) {
      const x100 = (BigInt(flows) * 100n * 1000n * 1000n) / BigInt(diffUs);
      flowsPerSecond = x100 / 100n;
      hundredths = x100 % 100n;
    }
    const fps = `${flowsPerSecond}.${String(hundredths).padStart(2, '0')}`;
    if (this.settings.flowExpiry !== 0) {
      return `Flows: ${flows} flows, ${flowsUnique} unique, ${flowsExpired} expired, ${fps} fps, ${flowPackets} unique flow packets, ${nonFlowPackets} unique non-flow packets\n`;
    }
    return `Flows: ${flows} flows, ${fps} fps, ${flowPackets} unique flow packets, ${nonFlowPackets} unique non-flow packets\n`;
  }
}
