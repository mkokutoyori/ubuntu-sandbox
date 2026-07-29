import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdCurl } from '../../LinuxNetCommands';
import { fetchHttp } from './HttpFetch';
import { HttpsClientSession } from '@/network/http/https/HttpsClientSession';
import { CertificateVerifier, certificateMatchesHostname } from '@/network/pki/CertificateVerifier';
import { createRequest } from '@/network/http/semantics/types';
import { makeArgCompleter } from '../completionHelpers';

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export const curlCommand: LinuxCommand = {
  name: 'curl',
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-I', '-k', '-s', '-v', '--head', '--insecure', '--silent'],
  }),
  usage: 'curl [-k] [-s] [-v] [-I] URL',
  help: 'Transfer data from or to a server.',

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const head = args.includes('-I') || args.includes('--head');
    let url: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-k' || a === '--insecure') continue;
      if (a === '-s' || a === '--silent' || a === '-v' || a === '-I' || a === '--head') continue;
      if (!a.startsWith('-')) url = a;
    }
    if (!url) return cmdCurl(args);

    const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url);
    if (!m) return cmdCurl(args);
    const scheme = m[1].toLowerCase();
    const host = m[2];
    const port = m[3] ? parseInt(m[3], 10) : scheme === 'https' ? 443 : 80;
    const path = m[4] || '/';

    if (scheme === 'https') {
      const ip = await ctx.net.resolveHostname(host);
      if (!ip) return `curl: (6) Could not resolve host: ${host}`;

      try {
        const verifier = new CertificateVerifier({ trustAnchors: ctx.tlsTrustAnchors });
        const session = new HttpsClientSession(ctx.net.getTcpStack(), ip.toString(), port, { verifier });
        const request = createRequest('GET', path);
        request.headers.set('Host', host);
        const result = session.send(request);

        if (!result.ok || !result.response) {
          session.close();
          return `curl: (60) SSL certificate problem: unable to get local issuer certificate`;
        }
        if (session.peerCertificate && !certificateMatchesHostname(session.peerCertificate, host)) {
          session.close();
          return `curl: (60) SSL: no alternative certificate subject name matches target host name '${host}'`;
        }
        session.close();
        const { response } = result;
        if (head) {
          return [
            `HTTP/${response.httpVersion} ${response.statusCode} ${response.reasonPhrase ?? ''}`,
            ...response.headers.entries().map(([k, v]) => `${k}: ${v}`),
            '',
          ].join('\n');
        }
        return response.body ? bytesToBinaryString(response.body) : '';
      } catch {
        return `curl: (35) OpenSSL SSL_connect: SSL routines::wrong version number in connection to ${host}:${port}`;
      }
    }

    // PRD-Windows-Server.md §5 P11 / PRD-HTTP.md §5 P12: a real HTTP dial
    // (IIS/W3SVC, or any other real HTTP-hosting device), not a stub.
    const fetched = await fetchHttp(ctx, url);
    if (fetched.ok === false) {
      if (fetched.reason === 'unresolved-host') return `curl: (6) Could not resolve host: ${fetched.host}`;
      if (fetched.reason === 'refused') return `curl: (7) Failed to connect to ${fetched.host} port ${fetched.port}: Connection refused`;
      return 'curl: (3) URL using bad/illegal format or missing URL';
    }
    const { response } = fetched;
    if (head) {
      return [
        `HTTP/1.1 ${response.statusCode} ${response.statusText}`,
        ...Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`),
        '',
      ].join('\n');
    }
    return response.body;
  },
};
