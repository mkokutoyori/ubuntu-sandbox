import type { LinuxCommandContext } from '../../LinuxCommandContext';
import { IPAddress, IPv6Address } from '../../../../../core/types';
import type { TcpSocket } from '../../../../../tcp/TcpStack';
import {
  BufferedProxyChannel, negotiateProxy, ProxyHandshakeError,
  type ProxyDestination, type ProxyOutcome, type ProxyStream,
} from '../../../../../proxy/ProxyHandshake';
import { NetcatExit, strtonum, type NetcatOptions } from './NetcatArguments';
import { wireText } from './NetcatSession';

const SOCKS_DEFAULT_PORT = '1080';
const HTTP_PROXY_DEFAULT_PORT = '3128';
const PORT_MAX = 65535;
const MAXIMUM_ATTEMPTS = 4;
const RESOLVER_ARGUMENT_LIMIT = 64;

export function proxyPortOf(ctx: LinuxCommandContext, opts: NetcatOptions): number {
  const text = opts.proxyPort ?? (opts.proxyProtocol === 'connect' ? HTTP_PROXY_DEFAULT_PORT : SOCKS_DEFAULT_PORT);
  const parsed = strtonum(text, 0, PORT_MAX);
  if ('value' in parsed) return parsed.value;
  const service = /^[0-9]+$/.test(text) ? null : ctx.executor.resolveServicePort(text, 'tcp');
  if (service === null) {
    throw new NetcatExit([`nc: getaddrinfo for host "${opts.proxyHost}" port ${text}: Servname not supported for ai_socktype`]);
  }
  return service;
}

function resolutionFailure(host: string, port: number, reason: string): NetcatExit {
  return new NetcatExit([`nc: getaddrinfo("${host.slice(0, RESOLVER_ARGUMENT_LIMIT)}", "${port}"): ${reason}`]);
}

function destinationOf(ctx: LinuxCommandContext, opts: NetcatOptions, host: string, port: number): ProxyDestination {
  const literal4 = IPAddress.tryParse(host);
  const literal6 = literal4 ? null : IPv6Address.tryParse(host);
  if (opts.proxyProtocol === 5) return { host, port, address: literal4 ?? literal6 };
  if (opts.proxyProtocol === 'connect') return { host, port, address: null };
  if (literal6) throw resolutionFailure(host, port, 'Address family for hostname not supported');
  const resolved = literal4 ?? ctx.net.resolveHostnameSync(host);
  if (!resolved) throw resolutionFailure(host, port, 'Name or service not known');
  return { host, port, address: resolved };
}

function streamOf(socket: TcpSocket): ProxyStream {
  return {
    write: (text) => { socket.write(text); },
    onData: (handler) => socket.onData((chunk) => handler(wireText(chunk))),
    onEnd: (handler) => socket.onEnd(handler),
    onClose: (handler) => socket.onClose(() => handler()),
  };
}

async function negotiateOnSocket(
  ctx: LinuxCommandContext, opts: NetcatOptions, socket: TcpSocket, host: string, port: number, retry: boolean,
): Promise<{ outcome: ProxyOutcome; leftover: string }> {
  const channel = new BufferedProxyChannel(streamOf(socket));
  try {
    const destination = destinationOf(ctx, opts, host, port);
    const outcome = await negotiateProxy(channel, opts.proxyProtocol, destination, { user: opts.proxyUser, retry });
    return { outcome, leftover: channel.release() };
  } catch (error) {
    channel.release();
    socket.close();
    if (error instanceof ProxyHandshakeError) throw new NetcatExit([`nc: ${error.message}`]);
    throw error;
  }
}

export async function connectThroughProxy<T extends { socket: TcpSocket | null }>(
  ctx: LinuxCommandContext, opts: NetcatOptions, host: string, port: number, open: () => Promise<T>,
): Promise<{ opened: T; leftover: string }> {
  for (let attempt = 0; ; attempt++) {
    if (attempt >= MAXIMUM_ATTEMPTS) throw new NetcatExit(['nc: Too many authentication failures']);
    const opened = await open();
    if (opened.socket === null) return { opened, leftover: '' };
    const { outcome, leftover } = await negotiateOnSocket(ctx, opts, opened.socket, host, port, attempt > 0);
    if (outcome === 'established') return { opened, leftover };
    opened.socket.close();
  }
}
