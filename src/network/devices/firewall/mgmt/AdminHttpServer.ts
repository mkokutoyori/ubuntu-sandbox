import type { TcpStack } from '../../../tcp/TcpStack';
import { Http1ServerSession } from '../../../http/http1/Http1ServerSession';
import { HttpsServerSession } from '../../../http/https/HttpsServerSession';
import { createResponse, type HttpMessage } from '../../../http/semantics/types';
import type { X509Certificate } from '../../../pki/X509Certificate';
import type { PkiPrivateKey } from '../../../pki/PkiKeyPair';
import type { ManagementPorts } from './ManagementAccess';

export interface AdminServerCertificate {
  readonly certificate: X509Certificate;
  readonly privateKey: PkiPrivateKey;
}

export interface AdminHttpPeer {
  readonly ip: string;
  readonly port: number;
  readonly secure: boolean;
}

export interface AdminHttpApp {
  handle(
    request: HttpMessage, peer: AdminHttpPeer,
  ): HttpMessage | Promise<HttpMessage>;
}

export interface AdminHttpServerDeps {
  tcp(): TcpStack;
  ports(): ManagementPorts;
  httpsRedirect(): boolean;
  serverCertificate(): AdminServerCertificate | undefined;
  app(): AdminHttpApp | null;
  capturePort(): number | null;
  capturedResponse(client: { ip: string; port: number }): HttpMessage | null;
}

export function redirectResponse(location: string): HttpMessage {
  const response = createResponse(301, 'Moved Permanently');
  response.headers.set('Location', location);
  response.headers.set('Content-Length', '0');
  return response;
}

export function httpsLocationFor(
  request: HttpMessage, httpsPort: number,
): string {
  const host = (request.headers.get('host') ?? '').replace(/:\d+$/, '');
  const authority = httpsPort === 443 ? host : `${host}:${httpsPort}`;
  const target = request.target ?? '/';
  return `https://${authority}${target.startsWith('/') ? target : `/${target}`}`;
}

type PlainListener = { port: number; session: Http1ServerSession } | null;

export class AdminHttpServer {
  private http: PlainListener = null;
  private capture: PlainListener = null;
  private https: { port: number; session: HttpsServerSession } | null = null;
  private certificateName = '';
  private readonly yielded = new Set<number>();

  constructor(private readonly deps: AdminHttpServerDeps) {}

  yieldPort(port: number): void {
    if (this.yielded.has(port)) return;
    this.yielded.add(port);
    this.refresh();
  }

  reclaimPort(port: number): void {
    if (!this.yielded.delete(port)) return;
    this.refresh();
  }

  refresh(): void {
    const admin = this.deps.ports().http;
    this.http = this.rebindPlain(this.http, this.wanted(admin));
    const captured = this.deps.capturePort();
    this.capture = this.rebindPlain(
      this.capture,
      captured === null || captured === admin ? null : this.wanted(captured));
    this.rebindHttps(this.wanted(this.deps.ports().https));
  }

  detach(): void {
    this.http?.session.stop();
    this.capture?.session.stop();
    this.https?.session.stop();
    this.http = null;
    this.capture = null;
    this.https = null;
  }

  private rebindPlain(current: PlainListener, port: number | null): PlainListener {
    if (current?.port === port) return current;
    current?.session.stop();
    if (port === null) return null;

    const session = new Http1ServerSession(
      this.deps.tcp(), port,
      (request, peer) => this.serve(request, {
        ip: peer?.ip ?? '0.0.0.0', port: peer?.port ?? 0, secure: false,
      }));
    try {
      session.start({ processName: 'httpsd', pid: 0 });
    } catch {
      return null;
    }
    return { port, session };
  }

  private wanted(port: number): number | null {
    return this.yielded.has(port) ? null : port;
  }

  private rebindHttps(port: number | null): void {
    const material = this.deps.serverCertificate();
    const name = material === undefined ? '' : material.certificate.subject;
    if (this.https?.port === port && this.certificateName === name) return;
    this.https?.session.stop();
    this.https = null;
    this.certificateName = name;
    if (port === null || material === undefined) return;

    const session = new HttpsServerSession(
      this.deps.tcp(), port,
      { serverCert: material.certificate, serverPrivateKey: material.privateKey },
      (request, peer) => this.serve(request, {
        ip: peer?.ip ?? '0.0.0.0', port: peer?.port ?? 0, secure: true,
      }));
    try {
      session.start({ processName: 'httpsd', pid: 0 });
    } catch {
      return;
    }
    this.https = { port, session };
  }

  private serve(
    request: HttpMessage, peer: AdminHttpPeer,
  ): HttpMessage | Promise<HttpMessage> {
    const captured = this.deps.capturedResponse({ ip: peer.ip, port: peer.port });
    if (captured !== null) return captured;
    if (!peer.secure && this.deps.httpsRedirect()) {
      return redirectResponse(httpsLocationFor(request, this.deps.ports().https));
    }
    const app = this.deps.app();
    if (app === null) return createResponse(503, 'Service Unavailable');
    return app.handle(request, peer);
  }
}
