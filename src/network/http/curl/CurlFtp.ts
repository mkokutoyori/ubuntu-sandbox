import { IPAddress } from '@/network/core/types';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import type { FtpReply } from '@/network/ftp/types';
import type { CurlOptions } from './CurlArgs';
import type { CurlHost } from './CurlHost';
import {
  connectFailure, dial, resolvedOverride,
  type DialPolicy, type CurlFailure, type CurlOutcome, type CurlUrl,
} from './CurlTransfer';

const DEFAULT_USER = 'anonymous';
const DEFAULT_PASSWORD = 'ftp@example.com';

function credentialsFor(url: CurlUrl, opts: CurlOptions): { user: string; password: string } {
  if (opts.user !== null) {
    const colon = opts.user.indexOf(':');
    return colon < 0
      ? { user: opts.user, password: '' }
      : { user: opts.user.slice(0, colon), password: opts.user.slice(colon + 1) };
  }
  if (url.user !== undefined) return { user: url.user, password: url.password ?? '' };
  return { user: DEFAULT_USER, password: DEFAULT_PASSWORD };
}

function pathSegments(path: string): { dirs: string[]; file: string } {
  const clean = path.split(/[?#]/)[0];
  const parts = clean.split('/').slice(1).map((p) => decodeURIComponent(p));
  const file = parts.pop() ?? '';
  return { dirs: parts.filter((p) => p.length > 0), file };
}

interface FtpPortSpec {
  readonly address: string;
  readonly portMin: number;
  readonly portMax: number;
}

const MAX_PORT = 65535;

function unsignedPrefix(text: string): number {
  const digits = /^\d+/.exec(text)?.[0];
  return digits === undefined ? 0 : Math.min(Number(digits), MAX_PORT);
}

function parseFtpPort(spec: string): FtpPortSpec {
  if (spec.length <= 1) return { address: '', portMin: 0, portMax: 0 };
  const colon = spec.indexOf(':');
  const address = colon < 0 ? spec : spec.slice(0, colon);
  let portMin = 0;
  let portMax = 0;
  if (colon >= 0) {
    const ports = spec.slice(colon + 1);
    portMin = unsignedPrefix(ports);
    const dash = ports.indexOf('-');
    portMax = dash >= 0 ? unsignedPrefix(ports.slice(dash + 1)) : portMin;
  }
  return portMin > portMax ? { address, portMin: 0, portMax: 0 } : { address, portMin, portMax };
}

function baseName(localPath: string): string {
  const parts = localPath.split('/');
  return parts[parts.length - 1] ?? '';
}

export async function performCurlFtp(
  host: CurlHost, url: CurlUrl, opts: CurlOptions, uploadBody: string | null, budget: DialPolicy,
): Promise<CurlOutcome> {
  const trace: string[] = [];
  const method = uploadBody !== null ? 'STOR' : 'RETR';
  const failure = (code: number, message: string, remoteIp = ''): CurlFailure => ({
    ok: false, code, message: `curl: (${code}) ${message}`,
    url, remoteIp, method, numRedirects: 0, trace,
  });

  const address = resolvedOverride(opts, url) ?? await host.resolveHostname(url.host);
  if (!address) return failure(6, `Could not resolve host: ${url.host}`);
  trace.push(`*   Trying ${address}:${url.port}...`);

  const porte = await dial(host, address, url.port, budget);
  if (porte.kind !== 'open') {
    return connectFailure(porte, url, url.port, address, method, 0, trace);
  }
  trace.push(`* Connected to ${url.host} (${address}) port ${url.port}`);

  const client = new FtpClientSession(host.tcpStack(), address, '', url.port);
  const code = (r: FtpReply | null): number => r?.code ?? 0;
  const finish = (outcome: CurlOutcome): CurlOutcome => {
    client.close();
    return outcome;
  };

  if (opts.verbose) client.observeExchange((line) => trace.push(line));
  const greeting = client.adopt(porte.socket);
  if (code(greeting) !== 220) {
    return finish(failure(8, `Got a ${String(code(greeting)).padStart(3, '0')} ftp-server response when 220 was expected`, address));
  }

  const { user, password } = credentialsFor(url, opts);
  const userReply = client.sendCommand({ verb: 'USER', argument: user });
  if (code(userReply) !== 230) {
    if (code(userReply) !== 331) return finish(failure(67, `Access denied: ${code(userReply)}`, address));
    const passReply = client.sendCommand({ verb: 'PASS', argument: password });
    if (code(passReply) !== 230) return finish(failure(67, `Access denied: ${code(passReply)}`, address));
  }
  client.sendCommand({ verb: 'PWD' });

  const { dirs, file } = pathSegments(url.path);
  for (const dir of dirs) {
    if (code(client.sendCommand({ verb: 'CWD', argument: dir })) >= 400) {
      return finish(failure(9, 'Server denied you to change to the given directory', address));
    }
  }

  const bindActiveListener = (spec: FtpPortSpec, bindAddress: string, nonLocalAllowed: boolean): { port: number; bindAddress: string } | CurlFailure => {
    let currentBind = bindAddress;
    let mayBeNonLocal = nonLocalAllowed;
    for (let port = spec.portMin; port <= spec.portMax;) {
      if (mayBeNonLocal && !host.ownsAddress(currentBind)) {
        currentBind = porte.socket.localIp;
        mayBeNonLocal = false;
        port = spec.portMin;
        continue;
      }
      try {
        return { port: client.openActiveListener(port, currentBind).localPort, bindAddress: currentBind };
      } catch (error) {
        if (!String(error).includes('EADDRINUSE') && !String(error).includes('EACCES')) {
          return failure(30, `bind(port=${port}) failed: Cannot assign requested address`, address);
        }
      }
      port++;
    }
    return failure(30, 'bind() failed, we ran out of ports', address);
  };

  const active = async (): Promise<CurlFailure | null> => {
    const spec = parseFtpPort(opts.ftpPort ?? '');
    const named = spec.address === '' ? null : (host.interfaceAddress(spec.address) ?? spec.address);
    const advertised = named === null ? porte.socket.localIp : (IPAddress.tryParse(named) ? named : await host.resolveHostname(named));
    if (advertised === null) return failure(30, `Could not resolve host: ${named}`, address);
    let command: 'EPRT' | 'PORT' = opts.disableEprt ? 'PORT' : 'EPRT';
    for (;;) {
      const bound = bindActiveListener(spec, advertised, named !== null);
      if ('ok' in bound) return bound;
      const answer = client.announceActiveEndpoint(command, advertised, bound.port);
      if (Math.floor(code(answer) / 100) === 2) {
        trace.push('* Connect data stream actively');
        return null;
      }
      if (command === 'PORT') return failure(30, 'Failed to do PORT', address);
      trace.push('* disabling EPRT usage');
      command = 'PORT';
    }
  };

  const passive = async (): Promise<CurlFailure | null> => {
    if (opts.ftpPort !== null) return active();
    const extended = opts.disableEpsv ? null : client.requestPassiveEndpoint(true);
    const endpoint = extended !== null && code(extended.reply) === 229 ? extended : client.requestPassiveEndpoint(false);
    if (endpoint.address === null || endpoint.port === null) return failure(13, 'Weird PASV reply', address);
    const data = await dial(host, endpoint.address, endpoint.port, budget);
    if (data.kind !== 'open') return connectFailure(data, url, endpoint.port, address, method, 0, trace);
    client.adoptDataSocket(data.socket);
    return null;
  };

  const success = (body: string, statusCode: number): CurlOutcome => ({
    ok: true, url, remoteIp: address, localIp: porte.socket.localIp, localPort: porte.socket.localPort,
    statusCode, reasonPhrase: '', httpVersion: '',
    headers: [], body, method, numRedirects: 0, trace,
  });

  if (uploadBody !== null) {
    const target = file || baseName(opts.uploadFile ?? '');
    if (!target) return finish(failure(3, 'Uploading to a URL without a file name', address));
    const storeChannel = await passive();
    if (storeChannel) return finish(storeChannel);
    client.sendCommand({ verb: 'TYPE', argument: 'I' });
    const stored = client.storeFile(target, uploadBody);
    if (code(stored) >= 400 || stored === null) {
      return finish(failure(25, `Failed FTP upload: ${code(client.lastServerReply)}`, address));
    }
    return finish(success('', code(stored)));
  }

  if (file === '') {
    const listChannel = await passive();
    if (listChannel) return finish(listChannel);
    client.sendCommand({ verb: 'TYPE', argument: 'A' });
    const listing = client.list(undefined, opts.listOnly ? 'NLST' : 'LIST');
    if (code(listing.reply) >= 400) {
      return finish(failure(19, `RETR response: ${String(code(listing.reply)).padStart(3, '0')}`, address));
    }
    const text = listing.lines.length > 0 ? `${listing.lines.join('\n')}\n` : '';
    return finish(success(text, code(listing.reply)));
  }

  const retrieveChannel = await passive();
  if (retrieveChannel) return finish(retrieveChannel);
  client.sendCommand({ verb: 'TYPE', argument: 'I' });
  if (code(client.sendCommand({ verb: 'SIZE', argument: file })) === 550) {
    return finish(failure(78, 'The file does not exist', address));
  }
  const retrieved = client.retrieveFile(file);
  if (code(retrieved.reply) >= 400) {
    const replyCode = code(retrieved.reply);
    return finish(failure(replyCode === 550 ? 78 : 19, `RETR response: ${String(replyCode).padStart(3, '0')}`, address));
  }
  return finish(success(retrieved.content ?? '', code(retrieved.reply)));
}
