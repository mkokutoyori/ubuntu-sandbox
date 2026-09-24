import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import type { FtpReply } from '@/network/ftp/types';
import type { CurlOptions } from './CurlArgs';
import type { CurlHost } from './CurlHost';
import {
  connectFailure, dial, resolvedOverride,
  type CurlFailure, type CurlOutcome, type CurlUrl,
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

function baseName(localPath: string): string {
  const parts = localPath.split('/');
  return parts[parts.length - 1] ?? '';
}

export async function performCurlFtp(
  host: CurlHost, url: CurlUrl, opts: CurlOptions, uploadBody: string | null,
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

  const porte = await dial(host, address, url.port, opts.connectTimeoutMs);
  if (porte.kind !== 'open') {
    return connectFailure(porte, url, url.port, address, method, 0, trace);
  }
  trace.push(`* Connected to ${url.host} (${address}) port ${url.port}`);

  const client = new FtpClientSession(host.tcpStack(), address, '', url.port);
  const code = (r: FtpReply | null): number => r?.code ?? 0;
  const finish = (outcome: CurlOutcome): CurlOutcome => {
    client.sendCommand({ verb: 'QUIT' });
    client.close();
    return outcome;
  };

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

  const passive = async (): Promise<CurlFailure | null> => {
    const extended = client.requestPassiveEndpoint(true);
    const endpoint = code(extended.reply) === 229 ? extended : client.requestPassiveEndpoint(false);
    if (endpoint.address === null || endpoint.port === null) return failure(13, 'Weird PASV reply', address);
    const data = await dial(host, endpoint.address, endpoint.port, opts.connectTimeoutMs);
    if (data.kind !== 'open') return connectFailure(data, url, endpoint.port, address, method, 0, trace);
    client.adoptDataSocket(data.socket);
    return null;
  };

  const success = (body: string, statusCode: number): CurlOutcome => ({
    ok: true, url, remoteIp: address, statusCode, reasonPhrase: '', httpVersion: '',
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
    const listing = client.list(undefined, 'LIST');
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
