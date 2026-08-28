import type { EndHost } from '../../EndHost';
import { DHCPServer } from '../../../dhcp/DHCPServer';
import { DHCPPacket } from '../../../dhcp/DHCPPacket';
import { buildDhcpServerReply } from '../../../dhcp/DhcpServerExchange';
import {
  IPAddress, SubnetMask, MACAddress, createIPv4Packet,
  ETHERTYPE_IPV4, IP_PROTO_UDP, type UDPPacket,
} from '../../../core/types';
import {
  parseDhcpdConf, parseDhcpdInterfaces, mergedOptions,
  type DhcpdConfig, type DhcpdSubnet,
} from './DhcpdConfig';
import { DHCP_SERVER_PORT, DHCP_CLIENT_PORT } from '@/network/core/WellKnownPorts';
import {
  DHCPD_BANNER, DHCPD_CONF_PATH, DHCPD_DEFAULTS_PATH, DHCPD_LEASES_PATH,
  DHCPD_LEASES_HEADER, DHCPD_PID_PATH, DHCPD_VERSION,
} from './DhcpdFiles';


const PROCESS_NAME = 'dhcpd';

export interface DhcpdOperationResult {
  readonly ok: boolean;
  readonly output: string;
}

export interface DhcpdFsPort {
  read(path: string): string | null;
  write(path: string, content: string): void;
  log?(message: string): void;
}

interface ServedInterface {
  readonly name: string;
  readonly address: string;
  readonly subnet: DhcpdSubnet;
}

function networkOf(address: string, mask: string): string {
  return new IPAddress(address).networkAddress(new SubnetMask(mask)).toString();
}

function poolNameFor(subnet: DhcpdSubnet): string {
  return `${subnet.network}/${new SubnetMask(subnet.netmask).toCIDR()}`;
}

const WEEKDAY_UTC = ['0', '1', '2', '3', '4', '5', '6'];

/** dhcpd.leases(5): `<weekday> YYYY/MM/DD HH:MM:SS`, always UTC. */
function leaseStamp(atMs: number): string {
  const date = new Date(atMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${WEEKDAY_UTC[date.getUTCDay()]} ${date.getUTCFullYear()}/`
    + `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export class LinuxDhcpdService {
  private readonly engine = new DHCPServer();
  private running = false;
  private served: ServedInterface[] = [];
  private lastConfig: DhcpdConfig | null = null;

  constructor(private readonly host: EndHost, private readonly fs: DhcpdFsPort) {
    this.engine.setEventBus(host.getBus());
  }

  isRunning(): boolean { return this.running; }

  getEngine(): DHCPServer { return this.engine; }

  servedInterfaces(): readonly string[] { return this.served.map(entry => entry.name); }

  /** `dhcpd -t` — parses the configuration and says so, changing nothing. */
  checkConfig(): DhcpdOperationResult {
    const text = this.fs.read(DHCPD_CONF_PATH);
    if (text === null) {
      return {
        ok: false,
        output: [...DHCPD_BANNER,
          `Can't open ${DHCPD_CONF_PATH}: No such file or directory`].join('\n'),
      };
    }
    const config = parseDhcpdConf(text, DHCPD_CONF_PATH);
    if (config.errors.length > 0) {
      return {
        ok: false,
        output: [...DHCPD_BANNER, ...config.errors.map(error => error.text),
          'Configuration file errors encountered -- exiting'].join('\n'),
      };
    }
    return {
      ok: true,
      output: [...DHCPD_BANNER,
        `Config file: ${DHCPD_CONF_PATH}`,
        `Database file: ${DHCPD_LEASES_PATH}`,
        `PID file: ${DHCPD_PID_PATH}`].join('\n'),
    };
  }

  /**
   * What the daemon decides at STARTUP and `dhcpd -t` never checks: is
   * there a subnet declaration for each interface it would listen on?
   */
  preflight(): DhcpdOperationResult & { config: DhcpdConfig | null; served: ServedInterface[] } {
    const check = this.checkConfig();
    if (!check.ok) return { ...check, config: null, served: [] };

    const text = this.fs.read(DHCPD_CONF_PATH) ?? '';
    const config = parseDhcpdConf(text, DHCPD_CONF_PATH);
    const wanted = parseDhcpdInterfaces(this.fs.read(DHCPD_DEFAULTS_PATH) ?? '');

    const lines: string[] = [...DHCPD_BANNER];
    const candidates = this.host.getPorts()
      .filter(port => !port.isAdminDown() && port.getIPAddress() !== null)
      .filter(port => port.getName() !== 'lo')
      .filter(port => wanted.length === 0 || wanted.includes(port.getName()));

    const served: ServedInterface[] = [];
    for (const port of candidates) {
      const address = port.getIPAddress()!.toString();
      const mask = port.getSubnetMask();
      const subnet = mask
        ? config.subnets.find(entry => entry.network === networkOf(address, mask.toString()))
        : undefined;
      if (!subnet) {
        lines.push(`No subnet declaration for ${port.getName()} (${address}).`);
        lines.push(`** Ignoring requests on ${port.getName()}.  If this is not what`);
        lines.push('   you want, please write a subnet declaration');
        lines.push('   in your dhcpd.conf file for the network segment');
        lines.push(`   to which interface ${port.getName()} is attached. **`);
        lines.push('');
        continue;
      }
      served.push({ name: port.getName(), address, subnet });
    }

    if (served.length === 0) {
      lines.push('');
      lines.push('Not configured to listen on any interfaces!');
      lines.push('');
      lines.push('If you think you have received this message due to a bug rather');
      lines.push('than a configuration issue please read the section on submitting');
      lines.push('bugs on either our web page at www.isc.org or in the README file');
      lines.push('before submitting a bug.  These pages explain the proper');
      lines.push('process and the information we find helpful for debugging.');
      return { ok: false, output: lines.join('\n'), config, served };
    }
    return { ok: true, output: lines.join('\n'), config, served };
  }

  start(): DhcpdOperationResult {
    if (this.running) return { ok: true, output: '' };

    const ready = this.preflight();
    if (!ready.ok || !ready.config) return { ok: ready.ok, output: ready.output };
    const config = ready.config;
    const served = ready.served;
    const lines = ready.output.split('\n');

    this.applyConfig(config, served);
    this.served = served;
    this.lastConfig = config;
    this.engine.enable();
    this.host.udpBind(DHCP_SERVER_PORT, this.handleDatagram, PROCESS_NAME);
    this.running = true;

    for (const entry of served) lines.push(`Listening on LPF/${entry.name}/${this.macOf(entry.name)}/${entry.subnet.network}/${new SubnetMask(entry.subnet.netmask).toCIDR()}`);
    for (const entry of served) lines.push(`Sending on   LPF/${entry.name}/${this.macOf(entry.name)}/${entry.subnet.network}/${new SubnetMask(entry.subnet.netmask).toCIDR()}`);
    return { ok: true, output: lines.join('\n') };
  }

  stop(): void {
    if (!this.running) return;
    this.host.udpClose(DHCP_SERVER_PORT);
    this.engine.disable();
    this.running = false;
    this.served = [];
  }

  restart(): DhcpdOperationResult {
    this.stop();
    return this.start();
  }

  private macOf(iface: string): string {
    return this.host.getPorts().find(port => port.getName() === iface)?.getMAC().toString() ?? '';
  }

  private applyConfig(config: DhcpdConfig, served: readonly ServedInterface[]): void {
    this.engine.setPingPacketCount(config.pingCheck ? 1 : 0);
    this.engine.setPingTimeoutMs(config.pingTimeoutSeconds * 1000);
    for (const [name] of this.engine.getAllPools()) this.engine.deletePool(name);
    for (const range of this.engine.getExcludedRanges()) {
      this.engine.removeExcludedRange(range.start, range.end);
    }

    for (const entry of served) {
      const subnet = entry.subnet;
      const name = poolNameFor(subnet);
      if (this.engine.getPool(name)) continue;
      const options = mergedOptions(config.globals, subnet.options);
      this.engine.createPool(name);
      this.engine.configurePoolNetwork(name, subnet.network, subnet.netmask);
      if (options.routers.length > 0) {
        this.engine.configurePoolRouter(name, options.routers);
      }
      if (options.domainNameServers.length > 0) {
        this.engine.configurePoolDNS(name, options.domainNameServers);
      }
      if (options.domainName) this.engine.configurePoolDomain(name, options.domainName);
      if (options.defaultLeaseTime) {
        this.engine.configurePoolLease(name, options.defaultLeaseTime);
      }
      this.restrictToRanges(subnet);
    }

    for (const host of config.hosts) {
      if (!host.hardwareEthernet || !host.fixedAddress) continue;
      const pool = served.find(entry => this.holdsAddress(entry.subnet, host.fixedAddress!));
      if (!pool) continue;
      this.engine.addStaticBinding(
        poolNameFor(pool.subnet), host.hardwareEthernet, host.fixedAddress);
    }
  }

  private holdsAddress(subnet: DhcpdSubnet, address: string): boolean {
    return networkOf(address, subnet.netmask) === subnet.network;
  }

  /**
   * ISC serves ONLY what a `range` names; the engine allocates the whole
   * subnet unless told otherwise, so everything outside the ranges is
   * excluded rather than the ranges being enumerated.
   */
  private restrictToRanges(subnet: DhcpdSubnet): void {
    const mask = new SubnetMask(subnet.netmask);
    const first = new IPAddress(subnet.network).toUint32() + 1;
    const last = ((new IPAddress(subnet.network).toUint32() | (~mask.toUint32() >>> 0)) >>> 0) - 1;
    if (subnet.ranges.length === 0) {
      this.engine.addExcludedRange(
        IPAddress.fromUint32(first).toString(), IPAddress.fromUint32(last).toString());
      return;
    }
    const sorted = [...subnet.ranges]
      .map(range => ({
        start: new IPAddress(range.start).toUint32(),
        end: new IPAddress(range.end).toUint32(),
      }))
      .sort((a, b) => a.start - b.start);

    let cursor = first;
    for (const range of sorted) {
      if (range.start > cursor) {
        this.engine.addExcludedRange(
          IPAddress.fromUint32(cursor).toString(),
          IPAddress.fromUint32(range.start - 1).toString());
      }
      cursor = Math.max(cursor, range.end + 1);
    }
    if (cursor <= last) {
      this.engine.addExcludedRange(
        IPAddress.fromUint32(cursor).toString(), IPAddress.fromUint32(last).toString());
    }
  }

  private readonly handleDatagram = (dgram: { inPort: string; udp: UDPPacket }): void => {
    if (!this.running) return;
    if (!this.served.some(entry => entry.name === dgram.inPort)) return;
    const pkt = dgram.udp.payload;
    if (!(pkt instanceof DHCPPacket) || pkt.op !== 1) return;
    this.serveOnWire(dgram.inPort, pkt);
  };

  private serveOnWire(inPort: string, pkt: DHCPPacket): void {
    const port = this.host.getPorts().find(entry => entry.getName() === inPort);
    const own = port?.getIPAddress()?.toString();
    if (own && own !== '0.0.0.0') this.engine.setServerIdentifier(own);
    this.engine.setServerOwnedAddresses(this.ownAddresses());

    const reply = buildDhcpServerReply(pkt, {
      server: this.engine,
      localGatewayIP: own,
      isAddressInUse: (ip) => this.addressIsTaken(inPort, ip),
    });
    if (!reply) return;
    if (reply.getMessageType() === 'DHCPACK') this.recordLease(pkt, reply);
    reply.giaddr = pkt.giaddr;
    if (pkt.giaddr !== '0.0.0.0') this.sendReplyToRelay(pkt.giaddr, reply);
    else this.sendReply(inPort, reply);
  }

  private addressIsTaken(inPort: string, ip: string): boolean {
    const taken = this.host.addressAnswersOnLink(inPort, new IPAddress(ip));
    if (taken) this.fs.log?.(`Abandoning IP address ${ip}: pinged before offer`);
    return taken;
  }

  private ownAddresses(): string[] {
    return this.host.getPorts()
      .map(port => port.getIPAddress()?.toString())
      .filter((address): address is string => !!address);
  }

  /** dhcpd.leases(5) — what `dhcp-lease-list` and every lab reads back. */
  private recordLease(request: DHCPPacket, reply: DHCPPacket): void {
    const binding = this.engine.getBindings().get(reply.yiaddr);
    if (!binding) return;
    const existing = this.fs.read(DHCPD_LEASES_PATH) ?? DHCPD_LEASES_HEADER;
    const hostName = request.getOption(12);
    const body = [
      `lease ${reply.yiaddr} {`,
      `  starts ${leaseStamp(binding.leaseStart)};`,
      `  ends ${leaseStamp(binding.leaseExpiration)};`,
      '  binding state active;',
      '  next binding state free;',
      `  hardware ethernet ${request.chaddr.toLowerCase()};`,
      ...(typeof hostName === 'string' && hostName.length > 0
        ? [`  client-hostname "${hostName}";`] : []),
      '}',
      '',
    ].join('\n');
    this.fs.write(DHCPD_LEASES_PATH, `${existing}${existing.endsWith('\n') ? '' : '\n'}${body}`);
  }

  private sendReplyToRelay(relayAgent: string, reply: DHCPPacket): void {
    this.host.sendUdpDatagram(
      new IPAddress(relayAgent), DHCP_SERVER_PORT, DHCP_SERVER_PORT, reply, 300);
  }

  private sendReply(inPort: string, reply: DHCPPacket): void {
    const port = this.host.getPorts().find(entry => entry.getName() === inPort);
    const srcIp = port?.getIPAddress();
    if (!port || !srcIp) return;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: DHCP_SERVER_PORT, destinationPort: DHCP_CLIENT_PORT,
      length: 8 + 300, checksum: 0, payload: reply,
    };
    this.host.sendFrame(inPort, {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: createIPv4Packet(
        srcIp, new IPAddress('255.255.255.255'), IP_PROTO_UDP, 64, udp, 8 + 300),
    });
  }

  version(): string { return DHCPD_VERSION; }

  config(): DhcpdConfig | null { return this.lastConfig; }
}
