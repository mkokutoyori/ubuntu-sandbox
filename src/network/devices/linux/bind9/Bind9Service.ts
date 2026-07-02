import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { parseZoneFile, ZoneFileError } from '@/network/dns/zone/ZoneFile';
import { ZoneError } from '@/network/dns/zone/Zone';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { IPAddress } from '@/network/core/types';
import { normalizeDnsName, parentName } from '@/network/dns/wire/DnsName';
import {
  bindDnsUdpServer, unbindDnsUdpServer, DNS_PORT,
} from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { parseNamedConf } from './NamedConfParser';
import { NamedConfSyntaxError } from './NamedConfLexer';
import { buildNamedConfig } from './NamedConfig';
import { NamedConfigError } from './NamedConfigError';
import type { NamedConfig, NamedZone } from './NamedConfig';
import type { AclHostEnvironment } from './NamedAcl';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { EndHost } from '@/network/devices/EndHost';
import type { OperationResult } from '../LinuxServiceManager';

type ConfigLoadResult =
  | { ok: true; config: NamedConfig }
  | { ok: false; error: string };

export const NAMED_CONF_PATH = '/etc/bind/named.conf';
const PROCESS_NAME = 'named';
const LOOPBACK = '127.0.0.1';

export class Bind9Service {
  private config: NamedConfig | null = null;
  private authoritative: AuthoritativeServer | null = null;
  private resolver: RecursiveResolver | null = null;
  private readonly cache = new DnsCache();
  private readonly loadedZones = new Map<string, number>();
  private readonly failedZones = new Set<string>();
  private running = false;
  private activePort = DNS_PORT;

  constructor(
    private readonly host: EndHost,
    private readonly readFile: (path: string) => string | null,
    private readonly configPath: string = NAMED_CONF_PATH,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  zoneSerial(name: string): number | undefined {
    return this.loadedZones.get(normalizeDnsName(name));
  }

  checkConfig(): OperationResult {
    const loaded = this.loadConfig();
    return loaded.ok ? { ok: true } : loaded;
  }

  start(): OperationResult {
    if (this.running) return { ok: true };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;

    this.applyConfig(loaded.config);
    const port = loaded.config.options.listenOnPort;
    try {
      bindDnsUdpServer(this.host, this.handleQuery, port, PROCESS_NAME);
    } catch {
      return { ok: false, error: `could not listen on UDP socket: address already in use` };
    }
    try {
      bindDnsTcpServer(this.host, this.handleQuery, port);
    } catch {
      unbindDnsUdpServer(this.host, port);
      return { ok: false, error: `could not listen on TCP socket: address already in use` };
    }
    this.activePort = port;
    this.running = true;
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
    unbindDnsUdpServer(this.host, this.activePort);
    unbindDnsTcpServer(this.host, this.activePort);
    this.running = false;
  }

  restart(): OperationResult {
    this.stop();
    return this.start();
  }

  reload(): OperationResult {
    if (!this.running) return { ok: false, error: 'named is not running' };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    this.applyConfig(loaded.config);
    if (loaded.config.options.listenOnPort !== this.activePort) {
      this.stop();
      return this.start();
    }
    return { ok: true };
  }

  private loadConfig(): ConfigLoadResult {
    const source = this.readFile(this.configPath);
    if (source === null) {
      return { ok: false, error: `open: ${this.configPath}: file not found` };
    }
    try {
      const statements = parseNamedConf(source, {
        file: this.configPath,
        readInclude: this.readFile,
      });
      return { ok: true, config: buildNamedConfig(statements) };
    } catch (error) {
      if (error instanceof NamedConfSyntaxError || error instanceof NamedConfigError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  private applyConfig(config: NamedConfig): void {
    const store = new ZoneStore();
    this.loadedZones.clear();
    this.failedZones.clear();

    for (const zone of config.zones) {
      if (zone.type !== 'primary') continue;
      const content = zone.file === null ? null : this.readFile(zone.file);
      if (content === null) {
        this.failedZones.add(zone.name);
        continue;
      }
      try {
        const parsed = parseZoneFile(content, zone.name);
        store.addZone(parsed);
        this.loadedZones.set(zone.name, parsed.soa.data.serial);
      } catch (error) {
        if (error instanceof ZoneFileError || error instanceof ZoneError) {
          this.failedZones.add(zone.name);
          continue;
        }
        throw error;
      }
    }

    this.config = config;
    this.authoritative = new AuthoritativeServer(store);
    this.resolver = this.buildResolver(config);
  }

  private buildResolver(config: NamedConfig): RecursiveResolver | null {
    if (!config.options.recursion) return null;
    const upstreams: IPAddress[] = [];
    for (const forwarder of config.options.forwarders) {
      const parsed = IPAddress.tryParse(forwarder);
      if (parsed) upstreams.push(parsed);
    }
    for (const zone of config.zones) {
      if (zone.type !== 'hint' || zone.file === null) continue;
      const content = this.readFile(zone.file);
      if (content !== null) upstreams.push(...collectHintAddresses(content));
    }
    if (upstreams.length === 0) return null;
    return new RecursiveResolver(this.host, upstreams, this.cache);
  }

  private aclEnvironment(): AclHostEnvironment {
    const localAddresses: string[] = [];
    const localNetworks: { address: string; prefix: number }[] = [];
    for (const port of this.host.getInterfaces()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      localAddresses.push(ip.toString());
      localNetworks.push({
        address: IPAddress.fromUint32((ip.toUint32() & mask.toUint32()) >>> 0).toString(),
        prefix: mask.toCIDR(),
      });
    }
    return { localAddresses, localNetworks };
  }

  private zoneFor(qname: string): NamedZone | null {
    const zones = this.config?.zones ?? [];
    let candidate: string | null = normalizeDnsName(qname);
    while (candidate !== null) {
      const zone = zones.find((z) => z.name === candidate);
      if (zone) return zone;
      candidate = parentName(candidate);
    }
    return null;
  }

  private readonly handleQuery = (
    query: DnsMessage, sourceIP?: IPAddress,
  ): DnsMessage | Promise<DnsMessage> => {
    const config = this.config!;
    const env = this.aclEnvironment();
    const source = sourceIP?.toString() ?? LOOPBACK;
    const recursionAllowed =
      config.options.recursion && config.options.allowRecursion.matches(source, env);

    if (!config.options.allowQuery.matches(source, env)) {
      return this.refuse(query, recursionAllowed);
    }

    const question = query.questions[0];
    if (question && (question.qtype === RRType.AXFR || question.qtype === RRType.IXFR)) {
      const transferAcl = this.zoneFor(question.qname)?.allowTransfer
        ?? config.options.allowTransfer;
      if (!transferAcl.matches(source, env)) {
        return this.refuse(query, recursionAllowed);
      }
    }

    const response = this.authoritative!.answer(query);
    if (response.flags.rcode === DnsRcode.REFUSED && this.queryHitsFailedZone(query)) {
      return {
        ...response,
        flags: { ...response.flags, rcode: DnsRcode.SERVFAIL, ra: recursionAllowed },
      };
    }

    const outsideAuthority = !response.flags.aa && response.flags.rcode === DnsRcode.REFUSED;
    if (outsideAuthority && question && query.flags.rd && recursionAllowed && this.resolver) {
      return this.recurse(query);
    }
    return { ...response, flags: { ...response.flags, ra: recursionAllowed } };
  };

  private async recurse(query: DnsMessage): Promise<DnsMessage> {
    const question = query.questions[0];
    const result = await this.resolver!.resolve(question.qname, question.qtype);
    const rcode =
      result.status === 'NOERROR' ? DnsRcode.NOERROR :
      result.status === 'NXDOMAIN' ? DnsRcode.NXDOMAIN :
      DnsRcode.SERVFAIL;
    return {
      id: query.id,
      flags: {
        qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false,
        rd: query.flags.rd, ra: true, ad: false, cd: false, rcode,
      },
      questions: [question],
      answers: [...result.answers],
      authorities: [],
      additionals: [],
    };
  }

  private refuse(query: DnsMessage, recursionAllowed: boolean): DnsMessage {
    return {
      id: query.id,
      flags: {
        qr: true, opcode: query.flags.opcode, aa: false, tc: false,
        rd: query.flags.rd, ra: recursionAllowed, ad: false, cd: false,
        rcode: DnsRcode.REFUSED,
      },
      questions: query.questions,
      answers: [],
      authorities: [],
      additionals: [],
    };
  }

  private queryHitsFailedZone(query: DnsMessage): boolean {
    const question = query.questions[0];
    if (!question) return false;
    let candidate: string | null = normalizeDnsName(question.qname);
    while (candidate !== null) {
      if (this.failedZones.has(candidate)) return true;
      candidate = parentName(candidate);
    }
    return false;
  }
}

const HINT_ADDRESS_PATTERN = /\bA\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*$/;

function collectHintAddresses(content: string): IPAddress[] {
  const addresses: IPAddress[] = [];
  for (const line of content.split('\n')) {
    const stripped = line.split(';')[0].trimEnd();
    const match = HINT_ADDRESS_PATTERN.exec(stripped);
    if (!match) continue;
    const parsed = IPAddress.tryParse(match[1]);
    if (parsed) addresses.push(parsed);
  }
  return addresses;
}
