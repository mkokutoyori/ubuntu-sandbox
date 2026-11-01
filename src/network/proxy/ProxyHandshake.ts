import { IPAddress, IPv6Address } from '../core/types';
import { strerror } from '../core/Errno';

export type ProxyProtocol = 'connect' | 4 | 5;

export class ProxyHandshakeError extends Error {}

export interface ProxyChannel {
  write(text: string): void;
  read(count: number): Promise<string>;
  readByte(): Promise<string | null>;
}

export interface ProxyDestination {
  readonly host: string;
  readonly port: number;
  readonly address: IPAddress | IPv6Address | null;
}

const SOCKS5_VERSION = 5;
const SOCKS4_VERSION = 4;
const SOCKS_NO_AUTHENTICATION = 0;
const SOCKS_NO_ACCEPTABLE_METHOD = 0xff;
const SOCKS_CONNECT = 1;
const SOCKS_IPV4 = 1;
const SOCKS_DOMAIN = 3;
const SOCKS_IPV6 = 4;
const SOCKS4_GRANTED = 90;
const SOCKS5_MAXIMUM_DOMAIN_LENGTH = 255;
const HTTP_LINE_LIMIT = 1024;
const HTTP_HEADER_LIMIT = 64;
const SOCKS4_REPLY_LENGTH = 8;
const SOCKS5_METHOD_REPLY_LENGTH = 2;
const SOCKS5_METHOD_REPLY_ANNOUNCED = 3;
const SOCKS5_IPV4_REPLY_TAIL = 6;
const SOCKS5_IPV6_REPLY_TAIL = 18;

const SOCKS4_ERRORS: Readonly<Record<number, string>> = {
  90: 'Succeeded',
  91: 'Request rejected or failed',
  92: 'SOCKS server cannot connect to identd on the client',
  93: 'Client program and identd report different user-ids',
};

const SOCKS5_ERRORS: readonly string[] = [
  'Succeeded',
  'General SOCKS server failure',
  'Connection not allowed by ruleset',
  'Network unreachable',
  'Host unreachable',
  'Connection refused',
  'TTL expired',
  'Command not supported',
  'Address type not supported',
];

function bytes(...values: number[]): string {
  return String.fromCharCode(...values);
}

function portBytes(port: number): string {
  return bytes((port >> 8) & 0xff, port & 0xff);
}

async function readExactly(channel: ProxyChannel, count: number, announced = count): Promise<string> {
  const text = await channel.read(count);
  if (text.length !== count) {
    throw new ProxyHandshakeError(`read failed (${text.length}/${announced}): ${strerror('EPIPE')}`);
  }
  return text;
}

async function socks5(channel: ProxyChannel, destination: ProxyDestination): Promise<void> {
  channel.write(bytes(SOCKS5_VERSION, 1, SOCKS_NO_AUTHENTICATION));
  const method = await readExactly(channel, SOCKS5_METHOD_REPLY_LENGTH, SOCKS5_METHOD_REPLY_ANNOUNCED);
  if (method.charCodeAt(1) === SOCKS_NO_ACCEPTABLE_METHOD) {
    throw new ProxyHandshakeError('authentication method negotiation failed');
  }
  channel.write(socks5Request(destination));
  const head = await readExactly(channel, 4);
  const status = head.charCodeAt(1);
  if (status !== 0) {
    throw new ProxyHandshakeError(`connection failed, SOCKSv5 error: ${SOCKS5_ERRORS[status] ?? 'Unknown error'}`);
  }
  const addressType = head.charCodeAt(3);
  if (addressType === SOCKS_IPV4) await readExactly(channel, SOCKS5_IPV4_REPLY_TAIL);
  else if (addressType === SOCKS_IPV6) await readExactly(channel, SOCKS5_IPV6_REPLY_TAIL);
  else throw new ProxyHandshakeError('connection failed, unsupported address type');
}

function socks5Request(destination: ProxyDestination): string {
  const prefix = bytes(SOCKS5_VERSION, SOCKS_CONNECT, 0);
  const { address, host, port } = destination;
  if (address instanceof IPAddress) return prefix + bytes(SOCKS_IPV4, ...address.getOctets()) + portBytes(port);
  if (address instanceof IPv6Address) {
    const groups = address.getHextets().flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
    return prefix + bytes(SOCKS_IPV6, ...groups) + portBytes(port);
  }
  if (host.length > SOCKS5_MAXIMUM_DOMAIN_LENGTH) throw new ProxyHandshakeError('host name too long for SOCKS5');
  return prefix + bytes(SOCKS_DOMAIN, host.length) + host + portBytes(port);
}

async function socks4(channel: ProxyChannel, destination: ProxyDestination): Promise<void> {
  if (!(destination.address instanceof IPAddress)) throw new ProxyHandshakeError('internal error: SOCKS4 needs an IPv4 address');
  channel.write(bytes(SOCKS4_VERSION, SOCKS_CONNECT) + portBytes(destination.port) + bytes(...destination.address.getOctets(), 0));
  const reply = await readExactly(channel, SOCKS4_REPLY_LENGTH);
  const status = reply.charCodeAt(1);
  if (status !== SOCKS4_GRANTED) {
    throw new ProxyHandshakeError(`connection failed, SOCKSv4 error: ${SOCKS4_ERRORS[status] ?? 'Unknown error'}`);
  }
}

async function readLine(channel: ProxyChannel): Promise<string> {
  let line = '';
  for (;;) {
    if (line.length >= HTTP_LINE_LIMIT) throw new ProxyHandshakeError('proxy read too long');
    const next = await channel.readByte();
    if (next === null) throw new ProxyHandshakeError(`proxy read: ${strerror('EPIPE')}`);
    if (next === '\r') continue;
    if (next === '\n') return line;
    line += next;
  }
}

function sendConnect(channel: ProxyChannel, destination: ProxyDestination): void {
  const { host, port } = destination;
  if (/[\r\n\t \[\]]/.test(host)) throw new ProxyHandshakeError('Invalid hostname');
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  channel.write(`CONNECT ${authority} HTTP/1.0\r\n`);
}

export type ProxyOutcome = 'established' | 'authentication-required';

export interface ProxyCredentials {
  readonly user: string | null;
  readonly retry: boolean;
}

async function httpConnect(channel: ProxyChannel, destination: ProxyDestination, credentials: ProxyCredentials): Promise<ProxyOutcome> {
  sendConnect(channel, destination);
  if (credentials.retry) throw new ProxyHandshakeError('Unable to read proxy passphrase');
  channel.write('\r\n');
  const status = await readLine(channel);
  if (credentials.user !== null && /^HTTP\/1\.[01] 407 /.test(status)) return 'authentication-required';
  if (!/^HTTP\/1\.[01] 200 /.test(status)) throw new ProxyHandshakeError(`Proxy error: "${status}"`);
  for (let header = 0; header < HTTP_HEADER_LIMIT; header++) {
    if ((await readLine(channel)) === '') return 'established';
  }
  throw new ProxyHandshakeError('Too many proxy headers received');
}

export async function negotiateProxy(
  channel: ProxyChannel, protocol: ProxyProtocol, destination: ProxyDestination, credentials: ProxyCredentials,
): Promise<ProxyOutcome> {
  if (protocol === 5) await socks5(channel, destination);
  else if (protocol === 4) await socks4(channel, destination);
  else return httpConnect(channel, destination, credentials);
  return 'established';
}

export interface ProxyStream {
  write(text: string): void;
  onData(handler: (text: string) => void): () => void;
  onEnd(handler: () => void): () => void;
  onClose(handler: () => void): () => void;
}

export class BufferedProxyChannel implements ProxyChannel {
  private buffer = '';
  private finished = false;
  private wake: (() => void) | null = null;
  private readonly detachers: Array<() => void>;

  constructor(private readonly stream: ProxyStream) {
    const finish = (): void => { this.finished = true; this.notify(); };
    this.detachers = [
      stream.onData((text) => { this.buffer += text; this.notify(); }),
      stream.onEnd(finish),
      stream.onClose(finish),
    ];
  }

  write(text: string): void {
    this.stream.write(text);
  }

  async read(count: number): Promise<string> {
    while (this.buffer.length < count && !this.finished) await this.arrival();
    const taken = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(taken.length);
    return taken;
  }

  async readByte(): Promise<string | null> {
    const byte = await this.read(1);
    return byte === '' ? null : byte;
  }

  release(): string {
    for (const detach of this.detachers) detach();
    const leftover = this.buffer;
    this.buffer = '';
    return leftover;
  }

  private arrival(): Promise<void> {
    return new Promise((resolve) => { this.wake = resolve; });
  }

  private notify(): void {
    const resume = this.wake;
    this.wake = null;
    resume?.();
  }
}
