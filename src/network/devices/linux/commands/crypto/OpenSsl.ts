import { simulationNowMs } from '@/network/core/SystemClock';
import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { runOpenSsl } from '@/network/crypto/openssl/OpenSslEngine';
import { OPENSSL_VERSION } from '@/network/crypto/openssl/opensslVersion';
import type { OpenSslHost } from '@/network/crypto/openssl/OpenSslHost';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { probeTlsPeer } from '@/network/tls/tlsPeerProbe';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { TlsServerChannel } from '@/network/tls/TlsServerChannel';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createRequest, createResponse } from '@/network/http/semantics/types';

function bytesText(bytes: Uint8Array | null): string {
  return bytes === null ? '' : bytesToFileText(bytes);
}

/**
 * docs/PRD-OpenSSL.md — la porte Linux du moteur `openssl`.
 *
 * Avant ce fichier, `dpkg -l openssl` annonçait le paquet installé et
 * le binaire n'existait pas : une machine affirmait disposer d'un outil
 * absent. `binaryPath` le déclare comme n'importe quel autre exécutable,
 * de sorte que `rm /usr/bin/openssl` le fasse disparaître pour de bon.
 */

function linuxOpenSslHost(ctx: LinuxCommandContext, stdin?: string): OpenSslHost {
  const vfs = ctx.executor.vfs;
  const chemin = (p: string) => vfs.normalizePath(p, ctx.executor.getCwd());
  return {
    readFile: (p) => vfs.readFile(chemin(p)),
    writeFile: (p, contenu) => vfs.writeFile(
      chemin(p), contenu,
      ctx.executor.userMgr.currentUid, ctx.executor.userMgr.currentGid, 0o022,
    ),
    fileExists: (p) => vfs.readFile(chemin(p)) !== null,
    now: () => simulationNowMs(),
    randomBytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
      return out;
    },
    stdin: () => stdin ?? null,
    // §P7 : le verdict d'une vraie connexion, par la même porte que
    // `nc` et `nmap` — `EndHost.tcpConnectOutcome`, synchrone parce que
    // la livraison de trames l'est dans ce simulateur.
    tcpConnect: (ip, port) => ctx.net.tcpConnectOutcome(ip, port),
    tlsPeerCertificate: (ip, port, servername, options) => {
      const sonde = probeTlsPeer(ctx.net.getTcpStack(), ip, port, {
        servername, trustAnchors: ctx.tlsTrustAnchors, ...options,
      });
      if (!sonde.ok) return { ok: false, reason: sonde.reason ?? 'handshake failed', alert: sonde.alert ?? null };
      return {
        ok: true, certificate: sonde.certificate,
        cipherSuite: sonde.cipherSuite, protocolVersion: sonde.protocolVersion ?? null, verified: sonde.verified,
        staple: sonde.staple ?? null,
        ...(sonde.received ? { received: sonde.received } : {}),
        ...(sonde.chain ? { chain: sonde.chain } : {}),
        ...(sonde.details ? { details: sonde.details } : {}),
        ...(sonde.channel ? { channel: sonde.channel } : {}),
      };
    },
    httpPost: (ip, port, path, body, headers) => {
      const request = createRequest('POST', path);
      request.headers.set('Host', `${ip}:${port}`);
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
      const payload = fileTextToBytes(body);
      request.headers.set('Content-Length', String(payload.length));
      request.body = payload;
      const session = new Http1ClientSession(ctx.net.getTcpStack(), ip, port);
      const result = session.send(request);
      session.close();
      if (result.ok === false || !result.response) return { ok: false, reason: result.ok === false ? result.error ?? 'no response' : 'no response' };
      return { ok: true, status: result.response.statusCode ?? 0, body: bytesText(result.response.body) };
    },
    serveHttp: (port, handler) => {
      const stack = ctx.net.getTcpStack();
      if (stack.listListeners().some((l) => l.localPort === port)) return false;
      new Http1ServerSession(stack, port, (req) => {
        const outcome = handler(bytesText(req.body));
        const response = createResponse(outcome.status, outcome.status === 200 ? 'OK' : 'Bad Request');
        response.headers.set('Content-Type', 'application/ocsp-response');
        response.body = fileTextToBytes(outcome.body);
        return response;
      }).start({ processName: 'openssl' });
      return true;
    },
    workingDirectory: () => ctx.executor.getCwd(),
    serveTlsStream: (port, tls, events) => {
      const stack = ctx.net.getTcpStack();
      if (stack.listListeners().some((l) => l.localPort === port)) return false;
      let current: TlsServerChannel | null = null;
      const config = {
        serverCert: tls.chain[0], serverChain: tls.chain.slice(1), serverPrivateKey: tls.privateKey,
        ...(tls.protocols ? { protocols: tls.protocols } : {}),
        ...(tls.cipherList ? { cipherList: tls.cipherList } : {}),
        ...(tls.clientAuth ? {
          requestClientCert: true,
          verifier: new CertificateVerifier({ trustAnchors: tls.clientAuth.anchors, clock: () => simulationNowMs() }),
          clientCertPolicy: tls.clientAuth.required ? 'strict' as const : 'optional' as const,
        } : {}),
      };
      stack.listen(port, {
        identity: { processName: 'openssl' },
        onAccept: (socket) => {
          const channel: TlsServerChannel = new TlsServerChannel(socket, new TlsServerSession(config as never), {
            onHandshakeComplete: () => events.accepted(),
            onData: (bytes) => events.data(bytesText(bytes)),
          });
          current = channel;
          socket.onClose(() => {
            if (current === channel) current = null;
            events.closed();
          });
        },
      });
      return {
        send: (text) => { if (current === null) return false; current.write(fileTextToBytes(text)); return true; },
        renegotiate: (requestClientCertificate) => current !== null && current.requestRenegotiation({ requestClientCertificate }),
        keyUpdate: (requestUpdate) => {
          if (current === null || current.session.negotiatedVersion !== '1.3') return false;
          current.keyUpdate(requestUpdate);
          return true;
        },
        closeConnection: () => { current?.close(); },
        stop: () => { current?.close(); stack.closeListener(port); },
      };
    },
    serveTls: (port, tls, respond) => {
      const stack = ctx.net.getTcpStack();
      if (stack.listListeners().some((l) => l.localPort === port)) return false;
      new HttpsServerSession(stack, port, {
        serverCert: tls.chain[0], serverChain: tls.chain.slice(1), serverPrivateKey: tls.privateKey,
        ...(tls.protocols ? { protocols: tls.protocols } : {}),
        ...(tls.cipherList ? { cipherList: tls.cipherList } : {}),
        ...(tls.clientAuth ? {
          requestClientCert: true,
          verifier: new CertificateVerifier({ trustAnchors: tls.clientAuth.anchors, clock: () => simulationNowMs() }),
          clientCertPolicy: tls.clientAuth.required ? 'strict' as const : 'optional' as const,
        } : {}),
      }, (req) => {
        const outcome = respond(req.method ?? 'GET', req.target ?? '/');
        const response = createResponse(outcome.status, outcome.status === 200 ? 'ok' : 'Not Found');
        response.headers.set('Content-Type', outcome.contentType);
        response.body = fileTextToBytes(outcome.body);
        return response;
      }).start({ processName: 'openssl' });
      return true;
    },
    resolveHost: (nom) => {
      const hosts = vfs.readFile('/etc/hosts') ?? '';
      for (const ligne of hosts.split('\n')) {
        const sansCommentaire = ligne.split('#')[0].trim();
        if (sansCommentaire === '') continue;
        const champs = sansCommentaire.split(/\s+/);
        if (champs.slice(1).includes(nom)) return champs[0];
      }
      return null;
    },
  };
}

export const opensslCommand: LinuxCommand = {
  name: 'openssl',
  package: 'openssl',
  // Malgré son nom, `needsNetworkContext: true` est la convention de ce
  // dépôt pour « dispatcher par le registre » plutôt que par un `case`
  // du switch — elle est écrite dans `Xxd.ts`, et `date`/`uname`/`bc`
  // la suivent sans toucher au réseau non plus. Avec `false`, la
  // commande était enregistrée, listée, complétée à la tabulation… et
  // répondait `command not found`.
  needsNetworkContext: true,
  binaryPath: '/usr/bin/openssl',
  complete: makeArgCompleter({
    flags: ['version', 'help', 'dgst', 'rand', 'base64', 'passwd', 'genrsa',
      'rsa', 'req', 'x509', 'verify', 'list', 'errstr', 'prime'],
  }),
  manSection: 1,
  usage: 'openssl command [ options ... ] [ parameters ... ]',
  help: `OpenSSL ${OPENSSL_VERSION} cryptography toolkit.`,
  options: [
    { flag: 'version', description: 'Display version information.' },
    { flag: 'dgst', description: 'Compute a message digest.' },
    { flag: 'enc', description: 'Symmetric encryption and base64 armour.' },
    { flag: 'genrsa', description: 'Generate an RSA private key.' },
    { flag: 'req', description: 'Create a certificate request or a self-signed certificate.' },
    { flag: 'x509', description: 'Display, convert or sign a certificate.' },
    { flag: 'verify', description: 'Verify a certificate chain.' },
  ],

  readsStdin: true,

  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    const r = this.runWithStatusSync!(ctx, args, stdin);
    return r.stderr ? `${r.output}${r.output && r.stderr ? '\n' : ''}${r.stderr}` : r.output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    const interactive = ctx.executor.interactiveTerminal && stdin === undefined && (args[0] === 's_client' || args[0] === 's_server');
    const print = ctx.executor.interactiveOutput ?? undefined;
    const r = runOpenSsl(linuxOpenSslHost(ctx, stdin), args, { interactive, ...(print ? { print } : {}) });
    if (r.channel) ctx.executor.offerInteractive({ kind: 'tls-client', channel: r.channel, version: r.channelVersion ?? '1.3' });
    if (r.streamServer) ctx.executor.offerInteractive({ kind: 'tls-server', controller: r.streamServer });
    return { output: r.output, exitCode: r.exitCode, stderr: r.stderr };
  },
};
