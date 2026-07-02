import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { parseZoneFile, ZoneFileError } from '@/network/dns/zone/ZoneFile';
import { ZoneError } from '@/network/dns/zone/Zone';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { normalizeDnsName, parentName } from '@/network/dns/wire/DnsName';
import {
  bindDnsUdpServer, unbindDnsUdpServer, DNS_PORT,
} from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { parseNamedConf } from './NamedConfParser';
import { NamedConfSyntaxError } from './NamedConfLexer';
import { buildNamedConfig } from './NamedConfig';
import { NamedConfigError } from './NamedConfigError';
import type { NamedConfig } from './NamedConfig';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { EndHost } from '@/network/devices/EndHost';
import type { IPAddress } from '@/network/core/types';

export interface Bind9OperationResult {
  ok: boolean;
  error?: string;
}

type ConfigLoadResult =
  | { ok: true; config: NamedConfig }
  | { ok: false; error: string };

export const NAMED_CONF_PATH = '/etc/bind/named.conf';
const PROCESS_NAME = 'named';

export class Bind9Service {
  private config: NamedConfig | null = null;
  private authoritative: AuthoritativeServer | null = null;
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

  checkConfig(): Bind9OperationResult {
    const loaded = this.loadConfig();
    return loaded.ok ? { ok: true } : loaded;
  }

  start(): Bind9OperationResult {
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

  restart(): Bind9OperationResult {
    this.stop();
    return this.start();
  }

  reload(): Bind9OperationResult {
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
  }

  private readonly handleQuery = (query: DnsMessage, sourceIP?: IPAddress): DnsMessage => {
    const response = this.authoritative!.answer(query);
    if (response.flags.rcode === DnsRcode.REFUSED && this.queryHitsFailedZone(query)) {
      return { ...response, flags: { ...response.flags, rcode: DnsRcode.SERVFAIL } };
    }
    return response;
  };

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
