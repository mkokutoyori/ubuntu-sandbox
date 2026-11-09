import type { TcpListener, TcpSocket, TcpStack } from '../../../tcp/TcpStack';
import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';

export type ProxyAction = 'accept' | 'deny';

export interface ExplicitProxySettings {
  readonly status: boolean;
  readonly port: number;
  readonly defaultAction: ProxyAction;
}

export interface ProxyPolicy {
  readonly id: string;
  readonly name: string;
  readonly srcIntf: readonly string[];
  readonly dstIntf: readonly string[];
  readonly srcAddr: readonly string[];
  readonly dstAddr: readonly string[];
  readonly schedule: string;
  readonly action: ProxyAction;
  readonly enabled: boolean;
}

export interface ExplicitProxyHost {
  readonly tcp: () => TcpStack;
  readonly claimPort?: (port: number) => void;
  readonly releasePort?: (port: number) => void;
  readonly resolve: (name: string) => Promise<string | null>;
  readonly ingressInterface: (localIp: string) => string | undefined;
  readonly egressInterface: (destination: string) => string | undefined;
  readonly zoneOf: (iface: string) => string | undefined;
  readonly matchesAddress: (names: readonly string[], candidate: string) => boolean;
  readonly scheduleActive: (name: string) => boolean;
  readonly onDecision?: (verdict: ProxyVerdict) => void;
}

export interface ProxyVerdict {
  readonly client: string;
  readonly host: string;
  readonly policyId: string | undefined;
  readonly action: ProxyAction;
}

interface ProxiedRequest {
  readonly method: string;
  readonly host: string;
  readonly port: number;
  readonly target: string;
  readonly version: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

const HEAD_END = '\r\n\r\n';
const DENIED_BODY = '<html><body><h1>Access Denied</h1><p>The explicit web proxy policy refuses this request.</p></body></html>';

function reply(status: number, reason: string, body = ''): string {
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
}

export function parseProxiedRequest(raw: string): ProxiedRequest | 'incomplete' | 'malformed' {
  const end = raw.indexOf(HEAD_END);
  if (end < 0) return 'incomplete';
  const lines = raw.slice(0, end).split('\r\n');
  const start = /^([A-Z]+) (\S+) HTTP\/(\d\.\d)$/.exec(lines[0]);
  if (!start) return 'malformed';
  const headers = lines.slice(1).map((line): readonly [string, string] => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  });
  const length = Number(headers.find(([name]) => name.toLowerCase() === 'content-length')?.[1] ?? '0');
  const body = raw.slice(end + HEAD_END.length);
  if (body.length < length) return 'incomplete';
  const absolute = /^http:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(start[2]);
  if (start[1] === 'CONNECT') return { method: 'CONNECT', host: start[2], port: 443, target: start[2], version: start[3], headers, body };
  if (!absolute) return 'malformed';
  return {
    method: start[1], host: absolute[1], port: absolute[2] ? Number(absolute[2]) : 80,
    target: absolute[3] ?? '/', version: start[3], headers, body: body.slice(0, length),
  };
}

export class ExplicitWebProxy {
  private settings: ExplicitProxySettings = { status: false, port: 8080, defaultAction: 'deny' };
  private policies: readonly ProxyPolicy[] = [];
  private listener: TcpListener | null = null;
  private armedPort: number | null = null;

  constructor(private readonly host: ExplicitProxyHost) {}

  port(): number | null { return this.settings.status ? this.settings.port : null; }

  apply(settings: ExplicitProxySettings): void {
    this.settings = settings;
    this.rearm();
  }

  setPolicies(policies: readonly ProxyPolicy[]): void {
    this.policies = Object.freeze([...policies]);
  }

  private rearm(): void {
    if (this.armedPort !== null && (!this.settings.status || this.armedPort !== this.settings.port)) {
      this.host.tcp().closeListener(this.armedPort);
      this.host.releasePort?.(this.armedPort);
      this.listener = null;
      this.armedPort = null;
    }
    if (!this.settings.status || this.armedPort !== null) return;
    this.host.claimPort?.(this.settings.port);
    this.listener = this.host.tcp().listen(this.settings.port, {
      onAccept: (socket) => { this.serve(socket); },
      identity: { processName: 'wad' },
    });
    if (this.listener) this.armedPort = this.settings.port;
  }

  private serve(client: TcpSocket): void {
    let buffer = '';
    let handled = false;
    client.onData((chunk) => {
      if (handled) return;
      buffer += String(chunk);
      const parsed = parseProxiedRequest(buffer);
      if (parsed === 'incomplete') return;
      handled = true;
      if (parsed === 'malformed') { this.finish(client, reply(400, 'Bad Request')); return; }
      void this.handle(client, parsed);
    });
  }

  private finish(client: TcpSocket, answer: string): void {
    client.write(answer);
    client.close();
  }

  private matches(policy: ProxyPolicy, ingress: string, destination: string, egress: string | undefined, client: string): boolean {
    if (!policy.enabled || !this.host.scheduleActive(policy.schedule)) return false;
    const names = (iface: string | undefined): readonly string[] => {
      if (iface === undefined) return [];
      const zone = this.host.zoneOf(iface);
      return zone === undefined ? [iface] : [iface, zone];
    };
    if (policy.srcIntf.length > 0 && !names(ingress).some(name => policy.srcIntf.includes(name))) return false;
    if (policy.dstIntf.length > 0 && !names(egress).some(name => policy.dstIntf.includes(name))) return false;
    if (policy.srcAddr.length > 0 && !this.host.matchesAddress(policy.srcAddr, client)) return false;
    if (policy.dstAddr.length > 0 && !this.host.matchesAddress(policy.dstAddr, destination)) return false;
    return true;
  }

  private async handle(client: TcpSocket, request: ProxiedRequest): Promise<void> {
    if (request.method === 'CONNECT') { this.finish(client, reply(501, 'Not Implemented')); return; }

    const destination = await this.host.resolve(request.host);
    if (destination === null) { this.finish(client, reply(502, 'Bad Gateway')); return; }

    const ingress = this.host.ingressInterface(client.localIp) ?? '';
    const egress = this.host.egressInterface(destination);
    const policy = this.policies.find(entry => this.matches(entry, ingress, destination, egress, client.remoteIp));
    const action = policy?.action ?? this.settings.defaultAction;
    this.host.onDecision?.({ client: client.remoteIp, host: request.host, policyId: policy?.id, action });
    if (action === 'deny') { this.finish(client, reply(403, 'Forbidden', DENIED_BODY)); return; }

    const upstream = this.host.tcp().connect(destination, request.port);
    if (!upstream || upstream.state !== 'established') { this.finish(client, reply(502, 'Bad Gateway')); return; }

    const forwarded = request.headers
      .filter(([name]) => !/^(proxy-|connection$)/i.test(name))
      .map(([name, value]) => `${name}: ${value}`);
    const head = `${request.method} ${request.target} HTTP/1.1\r\n${[...forwarded, 'Connection: close'].join('\r\n')}${HEAD_END}`;
    let answer = '';
    const stop = upstream.onData((chunk) => { answer += String(chunk); });
    upstream.write(bytesToBinaryString(binaryStringToBytes(head + request.body)));
    stop();
    upstream.close();
    this.finish(client, answer.length > 0 ? answer : reply(502, 'Bad Gateway'));
  }
}
