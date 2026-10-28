import type { TcpWireOutcome } from '@/network/tcp/types';
import { parseDialAddress } from '@/network/tcp/dial';
import {
  established, refused, resolved, unresolved,
  type NetkitAddress, type NetkitConnection, type NetkitResolution, type NetkitTelnetHost, type NetkitTelnetTransport,
} from './NetkitTelnetHost';

export interface DeviceNetkitDeps {
  readonly environment: () => ReadonlyArray<readonly [string, string]>;
  readonly user: () => { readonly name: string; readonly uid: number } | null;
  readonly lookupUser: (name: string) => { readonly uid: number } | null;
  readonly hostname: () => string;
  readonly size: () => { readonly rows: number; readonly cols: number } | null;
  readonly readFile: (path: string) => string | null;
  readonly tty: boolean;
  readonly lookupHost: (name: string) => string | null;
  readonly servicePort: (name: string) => number | null;
  readonly reach: (ip: string, port: number) => Promise<TcpWireOutcome>;
  readonly routeFailure?: (ip: string) => string | null;
  readonly dial: (ip: string, port: number) => Promise<NetkitTelnetTransport | { readonly dialFailed: string } | null>;
}

const WIRE_ERRNO: Readonly<Record<Exclude<TcpWireOutcome, 'open'>, string>> = {
  refused: 'Connection refused',
  timeout: 'Connection timed out',
  prohibited: 'No route to host',
  unreachable: 'Network is unreachable',
  'host-unreachable': 'No route to host',
};

export class DeviceNetkitHost implements NetkitTelnetHost {
  constructor(private readonly deps: DeviceNetkitDeps) {}

  environment(): ReadonlyArray<readonly [string, string]> { return this.deps.environment(); }
  currentUser(): { readonly name: string; readonly uid: number } | null { return this.deps.user(); }
  lookupUser(name: string): { readonly uid: number } | null { return this.deps.lookupUser(name); }
  isTty(): boolean { return this.deps.tty; }
  terminalSize(): { readonly rows: number; readonly cols: number } | null { return this.deps.tty ? this.deps.size() : null; }
  terminalSpeed(): { readonly input: number; readonly output: number } {
    return this.deps.tty ? { input: 38400, output: 38400 } : { input: 0, output: 0 };
  }
  hostname(): string { return this.deps.hostname(); }
  canonicalHostname(name: string): string { return name; }
  readFile(path: string): string | null { return this.deps.readFile(path); }

  resolve(host: string, service: string, family: 0 | 4 | 6, numericOnly: boolean): NetkitResolution {
    const port = /^\d+$/.test(service) ? Number(service) : this.deps.servicePort(service);
    if (port === null) return unresolved('Servname not supported for ai_socktype', false);
    const literal = parseDialAddress(host);
    if (literal !== null) {
      const version: 4 | 6 = host.includes(':') ? 6 : 4;
      if (family !== 0 && family !== version) return unresolved('Address family for hostname not supported', false);
      return resolved([{ text: literal.toString(), family: version }], port, null);
    }
    if (numericOnly) return unresolved('Name or service not known', true);
    const ip = family === 6 ? null : this.deps.lookupHost(host);
    if (ip === null) return unresolved('Name or service not known', true);
    return resolved([{ text: ip, family: 4 }], port, host);
  }

  async connect(address: NetkitAddress, port: number): Promise<NetkitConnection> {
    const routeFailure = this.deps.routeFailure?.(address.text) ?? null;
    if (routeFailure !== null) return refused(routeFailure);
    const reach = await this.deps.reach(address.text, port);
    if (reach !== 'open') return refused(WIRE_ERRNO[reach]);
    const dialed = await this.deps.dial(address.text, port);
    if (dialed === null) return refused('Connection refused');
    if ('dialFailed' in dialed) return refused(WIRE_ERRNO[dialed.dialFailed as Exclude<TcpWireOutcome, 'open'>] ?? 'Connection refused');
    return established(dialed);
  }
}
