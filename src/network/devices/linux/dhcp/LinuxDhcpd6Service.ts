import type { EndHost } from '../../EndHost';
import { IPv6Address } from '../../../core/types';
import { Dhcpv6HostService, dhcpv6PortOf } from '../../../dhcpv6/Dhcpv6HostService';
import type { DHCPv6Packet } from '../../../dhcpv6/DHCPv6Packet';
import type { DHCPv6Server } from '../../../dhcpv6/DHCPv6Server';
import {
  parseDhcpdConf, parseDhcpdInterfaces, mergedOptions,
  type DhcpdConfig, type DhcpdSubnet6,
} from './DhcpdConfig';
import {
  DHCPD_BANNER, DHCPD_DEFAULTS_PATH, DHCPD_LEASES_HEADER, DHCPD6_CONF_PATH, DHCPD6_LEASES_PATH, DHCPD6_PID_PATH,
} from './DhcpdFiles';
import { leaseStamp, type DhcpdFsPort, type DhcpdOperationResult } from './LinuxDhcpdService';

const PROCESS_NAME = 'dhcpd';

function poolNameFor(subnet: DhcpdSubnet6): string {
  return `${new IPv6Address(subnet.prefix).getNetworkPrefix(subnet.prefixLength)}/${subnet.prefixLength}`;
}

function duidBytes(duid: string): number[] {
  return duid.split(':').map(part => parseInt(part, 16));
}

function escapedKey(iaid: number, duid: string): string {
  const bytes = [(iaid >>> 24) & 255, (iaid >>> 16) & 255, (iaid >>> 8) & 255, iaid & 255, ...duidBytes(duid)];
  return bytes.map(byte => (byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c
    ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, '0')}`)).join('');
}

export class LinuxDhcpd6Service {
  private readonly service: Dhcpv6HostService;
  private served: string[] = [];

  constructor(private readonly host: EndHost, private readonly fs: DhcpdFsPort) {
    this.service = new Dhcpv6HostService(dhcpv6PortOf(host), PROCESS_NAME);
    this.service.observeReplies((request, reply) => this.recordLeases(request, reply));
  }

  isRunning(): boolean { return this.service.isRunning(); }

  getEngine(): DHCPv6Server { return this.service.getEngine(); }

  reconfigure(clientDuid: string, msgType: 'RENEW' | 'REBIND' | 'INFORMATION-REQUEST'): boolean {
    return this.service.sendReconfigure(clientDuid, msgType);
  }

  servedInterfaces(): readonly string[] { return this.served; }

  checkConfig(): DhcpdOperationResult {
    const text = this.fs.read(DHCPD6_CONF_PATH);
    if (text === null) {
      return { ok: false, output: [...DHCPD_BANNER, `Can't open ${DHCPD6_CONF_PATH}: No such file or directory`].join('\n') };
    }
    const config = parseDhcpdConf(text, DHCPD6_CONF_PATH);
    if (config.errors.length > 0) {
      return {
        ok: false,
        output: [...DHCPD_BANNER, ...config.errors.map(error => error.text),
          'Configuration file errors encountered -- exiting'].join('\n'),
      };
    }
    return {
      ok: true,
      output: [...DHCPD_BANNER, `Config file: ${DHCPD6_CONF_PATH}`,
        `Database file: ${DHCPD6_LEASES_PATH}`, `PID file: ${DHCPD6_PID_PATH}`].join('\n'),
    };
  }

  preflight(): DhcpdOperationResult & { config: DhcpdConfig | null; served: string[] } {
    const check = this.checkConfig();
    if (!check.ok) return { ...check, config: null, served: [] };
    const config = parseDhcpdConf(this.fs.read(DHCPD6_CONF_PATH) ?? '', DHCPD6_CONF_PATH);
    const wanted = parseDhcpdInterfaces(this.fs.read(DHCPD_DEFAULTS_PATH) ?? '', 'v6');
    const lines: string[] = [...DHCPD_BANNER];
    const served: string[] = [];
    for (const port of this.host.getPorts()) {
      if (port.getName() === 'lo' || port.isAdminDown()) continue;
      if (wanted.length > 0 && !wanted.includes(port.getName())) continue;
      const global = port.getGlobalIPv6();
      const subnet = global ? config.subnets6.find(entry =>
        global.isInSameSubnet(new IPv6Address(entry.prefix), entry.prefixLength)) : undefined;
      if (!subnet) {
        lines.push(`No subnet6 declaration for ${port.getName()} (${(port.getLinkLocalIPv6() ?? port.getGlobalIPv6())?.toString() ?? 'no address'}).`);
        lines.push(`** Ignoring requests on ${port.getName()}.  If this is not what`);
        lines.push('   you want, please write a subnet6 declaration');
        lines.push('   in your dhcpd.conf file for the network segment');
        lines.push(`   to which interface ${port.getName()} is attached. **`);
        lines.push('');
        continue;
      }
      served.push(port.getName());
    }
    if (served.length === 0) {
      lines.push('', 'Not configured to listen on any interfaces!', '');
      return { ok: false, output: lines.join('\n'), config, served };
    }
    return { ok: true, output: lines.join('\n'), config, served };
  }

  start(): DhcpdOperationResult {
    if (this.service.isRunning()) return { ok: true, output: '' };
    const ready = this.preflight();
    if (!ready.ok || !ready.config) return { ok: ready.ok, output: ready.output };
    this.applyConfig(ready.config);
    this.served = ready.served;
    this.service.servedInterfaces = new Set(ready.served);
    if (!this.service.start()) return { ok: false, output: `${ready.output}\nCan't bind to port 547: address already in use` };
    return { ok: true, output: ready.output };
  }

  stop(): void {
    this.service.stop();
    this.served = [];
  }

  restart(): DhcpdOperationResult {
    this.stop();
    return this.start();
  }

  private applyConfig(config: DhcpdConfig): void {
    const engine = this.service.getEngine();
    for (const name of [...engine.getAllPools().keys()]) engine.deletePool(name);
    for (const subnet of config.subnets6) {
      const name = poolNameFor(subnet);
      const options = mergedOptions(config.globals, subnet.options);
      const valid = options.defaultLeaseTime ?? 43200;
      const preferred = options.preferredLifetime ?? 27000;
      engine.createPool(name);
      engine.configurePoolPrefix(name, subnet.prefix, subnet.prefixLength);
      engine.configurePoolRanges(name, subnet.ranges.map(range => ({ startIp: range.start, endIp: range.end })));
      engine.configurePoolLifetime(name, preferred, valid);
      engine.configurePoolTimers(name, options.renewalTime, options.rebindingTime);
      engine.configurePoolDns(name, options.nameServers6);
      if (options.domainSearch[0]) engine.configurePoolDomain(name, options.domainSearch[0]);
      if (options.preference) engine.configurePoolPreference(name, options.preference);
      if (options.unicast6) engine.configurePoolServerUnicast(name, options.unicast6);
      if (options.infoRefreshTime !== null) engine.configurePoolInformationRefresh(name, options.infoRefreshTime);
      for (const range of subnet.prefixRanges) engine.configurePoolDelegationRange(name, range.low, range.high, range.length);
    }
    for (const host of config.hosts) {
      if (!host.clientDuid) continue;
      const subnet = config.subnets6.find(entry => host.fixedAddress6
        ? new IPv6Address(host.fixedAddress6).isInSameSubnet(new IPv6Address(entry.prefix), entry.prefixLength)
        : host.fixedPrefix6 !== null);
      if (!subnet) continue;
      const name = poolNameFor(subnet);
      if (host.fixedAddress6) {
        engine.configurePoolReservation(name, { address: host.fixedAddress6, clientDuid: host.clientDuid, iaid: null, name: host.name });
      }
      if (host.fixedPrefix6) {
        engine.configurePoolStaticDelegation(name, {
          prefix: host.fixedPrefix6.prefix, prefixLength: host.fixedPrefix6.length, clientDuid: host.clientDuid, iaid: null,
        });
      }
    }
  }

  private recordLeases(_request: DHCPv6Packet, reply: DHCPv6Packet): void {
    if (reply.msgType !== 'REPLY') return;
    const engine = this.service.getEngine();
    const blocks: string[] = [];
    for (const binding of engine.getBindings()) {
      const pool = engine.getPool(binding.poolName);
      blocks.push([
        `ia-na "${escapedKey(binding.iaid, binding.clientDuid)}" {`,
        `  cltt ${leaseStamp(binding.leaseStart)};`,
        `  iaaddr ${binding.address} {`,
        '    binding state active;',
        `    preferred-life ${pool?.preferredLifetime ?? 0};`,
        `    max-life ${pool?.validLifetime ?? 0};`,
        `    ends ${leaseStamp(binding.leaseExpiration)};`,
        '  }',
        '}',
        '',
      ].join('\n'));
    }
    for (const binding of engine.getPrefixBindings()) {
      const pool = engine.getPool(binding.poolName);
      blocks.push([
        `ia-pd "${escapedKey(binding.iaid, binding.clientDuid)}" {`,
        `  cltt ${leaseStamp(binding.leaseStart)};`,
        `  iaprefix ${binding.prefix}/${binding.prefixLength} {`,
        '    binding state active;',
        `    preferred-life ${pool?.preferredLifetime ?? 0};`,
        `    max-life ${pool?.validLifetime ?? 0};`,
        `    ends ${leaseStamp(binding.leaseExpiration)};`,
        '  }',
        '}',
        '',
      ].join('\n'));
    }
    this.fs.write(DHCPD6_LEASES_PATH, `${DHCPD_LEASES_HEADER}${blocks.length > 0 ? '\n' : ''}${blocks.join('\n')}`);
  }
}
