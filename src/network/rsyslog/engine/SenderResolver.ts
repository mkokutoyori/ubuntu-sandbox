import { isNumericHost } from './NumericHost';
import type { RsyslogHost } from './Host';
import { RS_RET } from './Log';
import type { GlobalSettings } from './Settings';
import type { RuntimeLog } from './Modules';

export interface ResolvedSender {
  readonly ip: string;
  readonly fqdn: string;
  readonly fqdnLowerCase: string;
}

interface CacheEntry extends ResolvedSender {
  readonly validUntilSeconds: number;
}

const UNRESOLVED_IP = '?error.obtaining.ip?';

export class SenderResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly host: RsyslogHost, private readonly settings: () => GlobalSettings, private readonly log: () => RuntimeLog) {}

  private nowSeconds(): number {
    return Math.floor(this.host.clock.wallMs() / 1000);
  }

  private entry(ip: string, fqdn: string): CacheEntry {
    return { ip, fqdn, fqdnLowerCase: fqdn.toLowerCase(), validUntilSeconds: this.nowSeconds() + this.settings().dnsCache.defaultTtlSeconds };
  }

  private lookup(ip: string): CacheEntry {
    const settings = this.settings();
    let fqdn = ip;
    if (!settings.disableDns) {
      const name = this.host.network.reverse(ip);
      if (name !== null) {
        if (isNumericHost(name)) {
          if (settings.dropMessagesWithMaliciousDnsPtrRecords) {
            this.log().error(`Malicious PTR record, message dropped IP = "${ip}" HOST = "${name}"`, RS_RET.MALICIOUS_ENTITY);
            return this.entry(UNRESOLVED_IP, UNRESOLVED_IP);
          }
          this.log().error(`Malicious PTR record (message accepted, but used IP instead of PTR name: IP = "${ip}" HOST = "${name}"`, -1);
        } else {
          fqdn = name;
        }
      }
    }
    return this.entry(ip, fqdn);
  }

  resolve(ip: string): ResolvedSender {
    if (!isNumericHost(ip)) return { ip: UNRESOLVED_IP, fqdn: UNRESOLVED_IP, fqdnLowerCase: UNRESOLVED_IP };
    const cached = this.cache.get(ip);
    const ttl = this.settings().dnsCache;
    if (cached !== undefined && !(ttl.enableTtl && cached.validUntilSeconds <= this.nowSeconds())) return cached;
    const entry = this.lookup(ip);
    this.cache.set(ip, entry);
    return entry;
  }
}
