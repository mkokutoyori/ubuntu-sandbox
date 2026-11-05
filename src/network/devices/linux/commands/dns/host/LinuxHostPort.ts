import { PathClock } from '@/network/core/time/PathClock';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { buildLegacyQueryMessage, nextDnsTransactionId, rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import { queryDnsOverTcp, queryDnsOverTcpStream, type DnsTcpClient } from '@/network/dns/transport/DnsTcpTransport';
import { transferComplete } from '@/network/dns/transfer/AxfrSession';
import { dialTcp, parseDialAddress } from '@/network/tcp/dial';
import { isDialFailure } from '@/network/tcp/types';
import type { TcpStack } from '@/network/tcp/TcpStack';
import type { LinuxCommandContext } from '../../LinuxCommandContext';
import { getAddrInfo, isHostLookupFailure } from '../../../nss/HostLookup';
import type { ExchangeFailure, ExchangeOutcome, FailureReason, HostPort, TransferOutcome } from './HostPort';

const RESOLV_CONF = '/etc/resolv.conf';

interface Dialer {
  readonly client: DnsTcpClient;
  failure(): FailureReason | null;
}

function dialerFor(stack: TcpStack): Dialer {
  let reason: FailureReason | null = null;
  return {
    client: {
      tcpConnect: async (destination, portNumber) => {
        const target = parseDialAddress(destination);
        if (target === null || !PortNumber.isValid(portNumber)) return null;
        const dialed = await dialTcp(stack, target, PortNumber.of(portNumber));
        if (!isDialFailure(dialed)) return dialed;
        if (dialed.dialFailed === 'refused') reason = 'connection refused';
        else if (dialed.dialFailed === 'timeout') reason = 'timed out';
        else reason = stack.hasEgressTo(destination) ? 'host unreachable' : 'network unreachable';
        return null;
      },
    },
    failure: () => reason,
  };
}

const failed = (phase: ExchangeFailure['phase'], reason: FailureReason): ExchangeFailure => ({ outcome: 'failed', phase, reason });

export function linuxHostPort(ctx: LinuxCommandContext): HostPort {
  const { executor, net } = ctx;

  async function exchangeOverTcp(
    address: string, port: number, query: DnsMessage, timeoutMs: number, startedAt: number,
  ): Promise<ExchangeOutcome> {
    const target = parseDialAddress(address);
    if (target === null) return failed('setup', 'network unreachable');
    const dialer = dialerFor(net.getTcpStack());
    const message = await queryDnsOverTcp(dialer.client, target, query, port, timeoutMs);
    if (message !== null) {
      return { outcome: 'reply', message, size: encodeDnsMessage(message).length, elapsedMs: PathClock.now() - startedAt };
    }
    const dialFailure = dialer.failure();
    return dialFailure === null ? failed('exchange', 'timed out') : failed('setup', dialFailure);
  }

  return {
    resolvConf: () => net.readFile(RESOLV_CONF),

    ipv6Available: () => [...net.getPorts().values()].some((port) => port.isIPv6Enabled()),

    addressesOf: async (name) => {
      const found = await getAddrInfo(executor.nss, name, { port: net.destinationSelectionPort(), policy: net.destinationPolicy() });
      return isHostLookupFailure(found) ? null : found.addresses;
    },

    exchange: async (request): Promise<ExchangeOutcome> => {
      const startedAt = PathClock.now();
      const typeName = rrTypeName(request.type);
      if (request.tcp) {
        const query = buildLegacyQueryMessage(nextDnsTransactionId(), request.name, typeName, {
          recursionDesired: request.recurse, qclass: request.rrClass,
        });
        if (query === null) return failed('exchange', 'timed out');
        return exchangeOverTcp(request.address, request.port, query, request.timeoutMs, startedAt);
      }
      let refused = false;
      let unreachable = false;
      const message = await net.queryDns(request.address, request.name, typeName, request.timeoutMs, {
        recursionDesired: request.recurse,
        port: request.port,
        qclass: request.rrClass,
        onTransportFailure: () => { refused = true; },
        onUnreachable: () => { unreachable = true; },
      });
      if (message !== null) {
        return { outcome: 'reply', message, size: encodeDnsMessage(message).length, elapsedMs: PathClock.now() - startedAt };
      }
      if (unreachable) return failed('setup', 'network unreachable');
      return failed('exchange', refused ? 'connection refused' : 'timed out');
    },

    transfer: async (request): Promise<TransferOutcome> => {
      const startedAt = PathClock.now();
      const target = parseDialAddress(request.address);
      if (target === null) return failed('setup', 'network unreachable');
      const base = buildLegacyQueryMessage(nextDnsTransactionId(), request.name, rrTypeName(request.type), {
        recursionDesired: false, qclass: request.rrClass,
      });
      if (base === null) return failed('exchange', 'timed out');
      const query: DnsMessage = request.type === RRType.IXFR
        ? {
          ...base,
          flags: { ...base.flags, opcode: DnsOpcode.QUERY, rcode: DnsRcode.NOERROR },
          authorities: [makeSoaRecord(request.name, 0, {
            mname: '.', rname: '.', serial: request.ixfrSerial, refresh: 0, retry: 0, expire: 0, minimum: 0,
          })],
        }
        : base;
      const dialer = dialerFor(net.getTcpStack());
      const result = await queryDnsOverTcpStream(dialer.client, target, query, transferComplete, request.port, request.timeoutMs);
      if (result === null) {
        const dialFailure = dialer.failure();
        return dialFailure === null ? failed('exchange', 'timed out') : failed('setup', dialFailure);
      }
      return { outcome: 'messages', messages: result.messages, sizes: result.frames.map((frame) => frame.length), elapsedMs: PathClock.now() - startedAt };
    },
  };
}
