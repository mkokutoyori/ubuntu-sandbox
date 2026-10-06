import { readFileSync } from 'node:fs';
import { runLdapsearch, type LdapToolHost } from '@/network/ldap/openldap/ldapsearch';
import type { LdapChannel, ChannelRead, ConnectOutcome } from '@/network/ldap/openldap/ldapChannel';
import { parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';

export interface RecordedConnection {
  readonly port: number;
  readonly transcript: readonly (readonly ['c' | 's', string, number])[];
}

export interface Scenario {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly connections: readonly RecordedConnection[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface Corpus {
  readonly files: Readonly<Record<string, string>>;
  readonly scenarios: readonly Scenario[];
}

export interface TraceRecord {
  readonly corpus: string;
  readonly scenario: string;
  readonly level: number;
  readonly connections?: readonly RecordedConnection[];
  readonly stdout?: string;
  readonly stderr: string;
  readonly exitCode?: number;
}

export interface TraceCorpus {
  readonly traces: readonly TraceRecord[];
}

export const DEFAULT_PORT = 3891;

export function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(`src/__tests__/unit/network-v2/${name}`, 'utf8')) as T;
}

function splitPdus(bytes: Uint8Array): Uint8Array[] {
  const pdus: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const next = parseTLV(bytes, offset).nextOffset;
    pdus.push(bytes.subarray(offset, next));
    offset = next;
  }
  return pdus;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function asLatin1(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1');
}

export function unfoldAndMaskTemporaryNames(text: string): string {
  return text.replace(/\n /g, '').replace(/(ldapsearch-[A-Za-z]+-)[A-Za-z0-9]{6}/g, '$1XXXXXX');
}

export function normalizeTrace(text: string): string {
  return text
    .replace(/0x[0-9a-f]+/g, '0xPTR')
    .replace(/IP=127\.0\.0\.1:\d+/g, 'IP=127.0.0.1:PORT')
    .replace(/last used: .*\d{4}/g, 'last used: DATE')
    .replace(/(wait4msg ld 0xPTR) \d+ s \d+ us to go/g, '$1 N s N us to go')
    .replace(/(ldapsearch-[A-Za-z]+-)[A-Za-z0-9]{6}/g, '$1XXXXXX');
}

interface InFlight {
  readonly seq: number;
  readonly chunks: Uint8Array[];
  readonly channel: ReplayChannel;
}

class ReplayNetwork {
  readonly channels: ReplayChannel[] = [];
  readonly inFlight: InFlight[] = [];

  deliverEarliestWhenIdle(): void {
    if (this.channels.some((channel) => channel.hasData()) || this.inFlight.length === 0) return;
    let earliest = 0;
    for (let index = 1; index < this.inFlight.length; index++) {
      if (this.inFlight[index].seq < this.inFlight[earliest].seq) earliest = index;
    }
    const [batch] = this.inFlight.splice(earliest, 1);
    for (const chunk of batch.chunks) batch.channel.receive(chunk);
  }
}

class ReplayChannel implements LdapChannel {
  readonly peerAddress = '127.0.0.1';
  readonly localEndpoint = 'IP=127.0.0.1:50000';
  private inbox = new Uint8Array(0);
  private cursor = 0;

  constructor(
    private readonly events: readonly { direction: string; pdu: Uint8Array; seq: number }[],
    private readonly problems: string[],
    private readonly network: ReplayNetwork,
  ) {
    network.channels.push(this);
  }

  hasData(): boolean {
    return this.inbox.length > 0;
  }

  receive(bytes: Uint8Array): void {
    const joined = new Uint8Array(this.inbox.length + bytes.length);
    joined.set(this.inbox, 0);
    joined.set(bytes, this.inbox.length);
    this.inbox = joined;
  }

  write(bytes: Uint8Array): boolean {
    const recorded = this.events[this.cursor];
    if (recorded === undefined || recorded.direction !== 'c') {
      this.problems.push(`unexpected request ${hex(bytes)}`);
      return true;
    }
    this.cursor++;
    if (hex(bytes) !== hex(recorded.pdu)) {
      this.problems.push(`request mismatch: sent ${hex(bytes)} recorded ${hex(recorded.pdu)}`);
    }
    const chunks: Uint8Array[] = [];
    const seq = this.cursor < this.events.length ? this.events[this.cursor].seq : 0;
    while (this.cursor < this.events.length && this.events[this.cursor].direction === 's') {
      chunks.push(this.events[this.cursor++].pdu);
    }
    if (chunks.length > 0) this.network.inFlight.push({ seq, chunks, channel: this });
    return true;
  }

  read(want: number): ChannelRead {
    if (this.inbox.length === 0) {
      return this.network.inFlight.some((batch) => batch.channel === this) ? { kind: 'again' } : { kind: 'eof' };
    }
    const taken = this.inbox.slice(0, want);
    this.inbox = this.inbox.slice(taken.length);
    return { kind: 'data', bytes: taken };
  }

  readable(): boolean {
    this.network.deliverEarliestWhenIdle();
    return this.hasData();
  }

  upgradeTls = () => ({ ok: true }) as const;

  close(): void {}
}

const CONNECTION_REFUSED = 111;

function replayTransport(connections: readonly RecordedConnection[], problems: string[]) {
  const opened = new Set<number>();
  const network = new ReplayNetwork();
  return {
    resolve: async () => ['127.0.0.1'],
    connect(_address: string, port: number): ConnectOutcome {
      const index = connections.findIndex((candidate, position) => candidate.port === port && !opened.has(position));
      if (index < 0) return { kind: 'failed', errno: CONNECTION_REFUSED };
      opened.add(index);
      const events: { direction: string; pdu: Uint8Array; seq: number }[] = [];
      for (const [direction, chunk, seq] of connections[index].transcript) {
        for (const pdu of splitPdus(Buffer.from(chunk, 'hex'))) events.push({ direction, pdu, seq });
      }
      return { kind: 'connected', channel: new ReplayChannel(events, problems, network) };
    },
  };
}

export interface ReplayOptions {
  readonly args: readonly string[];
  readonly debugLevel?: number;
  readonly files: Readonly<Record<string, string>>;
}

export interface ReplayOutcome {
  readonly problems: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function replay(scenario: Scenario, options: ReplayOptions): Promise<ReplayOutcome> {
  const problems: string[] = [];
  const { files } = options;
  let stdinPosition = 0;
  const host: LdapToolHost = {
    environment: (name) => ({ HOME: '/root', USER: 'root' } as Record<string, string>)[name] ?? null,
    readTextFile: (path) => files[path] ?? null,
    readFile: (path) => (files[path] === undefined
      ? { error: 'No such file or directory' }
      : { bytes: Buffer.from(files[path], 'latin1') }),
    fileMode: (path) => (files[path] === undefined ? null : 0o644),
    createTemporaryFile: (template) => ({ path: template.replace('XXXXXX', 'AAAAAA') }),
    transport: replayTransport(scenario.connections, problems),
    clock: { now: () => 0, nowMicroseconds: () => 0, ctime: () => 'Thu Jan  1 00:00:00 1970\n' },
    readStdinLine() {
      if (stdinPosition >= scenario.stdin.length) return null;
      const newline = scenario.stdin.indexOf('\n', stdinPosition);
      const line = scenario.stdin.slice(stdinPosition, newline < 0 ? undefined : newline);
      stdinPosition = newline < 0 ? scenario.stdin.length : newline + 1;
      return line;
    },
    readStdinCharacter: () => (stdinPosition < scenario.stdin.length ? scenario.stdin[stdinPosition++] : null),
    localHostName: () => 'vm',
    localAddress: () => '127.0.0.1',
    saslClientMechanisms: () => [],
    lookupDomainHosts: () => null,
  };
  const port = scenario.connections[0]?.port ?? DEFAULT_PORT;
  const debug = options.debugLevel === undefined ? [] : ['-d', String(options.debugLevel)];
  const result = await runLdapsearch(['ldapsearch', '-H', `ldap://127.0.0.1:${port}`, ...debug, ...options.args], host);
  return { problems, stdout: asLatin1(result.stdout), stderr: asLatin1(result.stderr), exitCode: result.exitCode };
}

export function compareWithRecording(
  outcome: ReplayOutcome,
  recorded: { stdout: string; stderr: string; exitCode: number },
  traced: boolean,
): string[] {
  const problems = [...outcome.problems];
  const mask = traced ? normalizeTrace : (text: string) => text;
  if (unfoldAndMaskTemporaryNames(outcome.stdout) !== unfoldAndMaskTemporaryNames(recorded.stdout)) {
    problems.push(`stdout differs:\n--- real\n${recorded.stdout}\n--- simulated\n${outcome.stdout}`);
  }
  if (mask(outcome.stderr) !== mask(recorded.stderr)) {
    problems.push(`stderr differs:\n--- real\n${recorded.stderr}\n--- simulated\n${outcome.stderr}`);
  }
  if (outcome.exitCode !== recorded.exitCode) {
    problems.push(`exit status real=${recorded.exitCode} simulated=${outcome.exitCode}`);
  }
  return problems;
}

export { runLdapsearch };
