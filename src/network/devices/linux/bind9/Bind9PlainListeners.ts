import type { IPAddress, IPv6Address } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { bindDnsUdpServer, unbindDnsUdpServer, type DnsDatagramHandler } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer, type DnsStreamHandler } from '@/network/dns/transport/DnsTcpTransport';
import type { OperationResult } from '../LinuxServiceManager';
import type { AclHostEnvironment } from './NamedAcl';
import type { NamedPlainListen } from './NamedConfig';
import { listenAddresses } from './Bind9ListenAddresses';

export interface PlainListenerDeps {
  readonly host: EndHost;
  readonly processName: string;
  readonly udpHandler: DnsDatagramHandler;
  readonly tcpHandler: DnsStreamHandler;
  readonly environment: () => AclHostEnvironment;
}

interface PlainBinding {
  readonly port: number;
  readonly address: string;
}

const WILDCARD_V4 = '0.0.0.0';
const WILDCARD_V6 = '::';

const keyOf = (binding: PlainBinding): string => `${binding.address}#${binding.port}`;
const isV6 = (address: string): boolean => address.includes(':');
const wildcardOf = (address: string): string => (isV6(address) ? WILDCARD_V6 : WILDCARD_V4);

export class Bind9PlainListeners {
  private bindings: PlainBinding[] = [];
  private declaresIpv6 = false;

  constructor(private readonly deps: PlainListenerDeps) {}

  rebind(listens: readonly NamedPlainListen[]): OperationResult {
    const wanted = this.wantedBindings(listens);
    this.declaresIpv6 = listens.some((listen) => listen.ipv6);
    if (wanted.map(keyOf).join(' ') === this.bindings.map(keyOf).join(' ')) return { ok: true };
    this.stop();
    return this.bind(wanted);
  }

  stop(): void {
    const { host } = this.deps;
    for (const port of new Set(this.bindings.map((binding) => binding.port))) unbindDnsUdpServer(host, port);
    for (const { port, address } of this.bindings.splice(0)) unbindDnsTcpServer(host, port, address);
  }

  private wantedBindings(listens: readonly NamedPlainListen[]): PlainBinding[] {
    const environment = this.deps.environment();
    const wanted: PlainBinding[] = [];
    for (const listen of listens) {
      for (const address of listenAddresses(listen.addresses, listen.ipv6, environment)) {
        if (!wanted.some((binding) => binding.address === address && binding.port === listen.port)) wanted.push({ port: listen.port, address });
      }
    }
    return wanted;
  }

  private serves(destination: IPAddress | IPv6Address, port: number): boolean {
    const address = destination.toString();
    if (isV6(address) && !this.declaresIpv6) return true;
    return this.bindings.some((binding) => binding.port === port && (binding.address === address || binding.address === wildcardOf(address)));
  }

  private bind(wanted: readonly PlainBinding[]): OperationResult {
    const { host, processName, udpHandler, tcpHandler } = this.deps;
    for (const port of new Set(wanted.map((binding) => binding.port))) {
      const families = new Set(wanted.filter((binding) => binding.port === port).map((binding) => (isV6(binding.address) ? 'ipv6' : 'ipv4')));
      try {
        bindDnsUdpServer(host, udpHandler, port, processName, undefined, undefined, {
          families: [...families] as Array<'ipv4' | 'ipv6'>,
          acceptsDestination: (destination) => this.serves(destination, port),
        });
      } catch {
        this.stop();
        return { ok: false, error: 'could not listen on UDP socket: address already in use' };
      }
      this.bindings.push(...wanted.filter((binding) => binding.port === port));
    }
    for (const { port, address } of wanted) {
      try {
        bindDnsTcpServer(host, tcpHandler, port, { address, processName });
      } catch {
        this.stop();
        return { ok: false, error: 'could not listen on TCP socket: address already in use' };
      }
    }
    return { ok: true };
  }
}
