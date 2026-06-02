/**
 * HuaweiRouter - Huawei VRP Router specialization
 *
 * Extends abstract Router with Huawei-specific:
 *   - Port naming: GE0/0/X
 *   - CLI shell: HuaweiVRPShell
 *   - Boot sequence: Huawei VRP bootstrap
 */

import { Router } from './Router';
import type { IRouterShell } from './shells/IRouterShell';
import { HuaweiVRPShell } from './shells/HuaweiVRPShell';
import {
  displayVersion,
  displayInterfaceBrief,
  displayCurrentConfig,
  displayIpIntBrief,
} from './shells/huawei/HuaweiDisplayCommands';
import { resolveHuaweiInterfaceName as resolveHuaweiIfName } from './shells/cli-utils';
import { LldpAgent, type LldpNeighbor } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP, LLDP_MULTICAST_MAC } from '../lldp/types';
import { VrrpAgent } from '../vrrp/VrrpAgent';
import { IP_PROTO_VRRP, VRRP_MULTICAST_MAC } from '../vrrp/types';
import { NtpAgent } from '../ntp/NtpAgent';
import { UDP_PORT_NTP } from '../ntp/types';
import { BfdAgent } from '../bfd/BfdAgent';
import { UDP_PORT_BFD_CONTROL } from '../bfd/types';
import { IgmpAgent } from '../igmp/IgmpAgent';
import { IP_PROTO_IGMP } from '../igmp/types';
import { PimAgent } from '../pim/PimAgent';
import { IP_PROTO_PIM, PIM_ALL_ROUTERS_MAC } from '../pim/types';
import { SyslogAgent } from '../syslog/SyslogAgent';
import { RadiusClientAgent } from '../radius/RadiusClientAgent';
import { RadiusServerAgent } from '../radius/RadiusServerAgent';
import { UDP_PORT_RADIUS_AUTH } from '../radius/types';
import { GreAgent } from '../gre/GreAgent';
import { IP_PROTO_GRE } from '../gre/types';
import { SnmpAgent } from '../snmp/SnmpAgent';
import { UDP_PORT_SNMP } from '../snmp/types';
import { NetFlowAgent } from '../netflow/NetFlowAgent';
import { TacacsClientAgent } from '../tacacs/TacacsClientAgent';
import { TacacsServerAgent } from '../tacacs/TacacsServerAgent';
import { VxlanAgent } from '../vxlan/VxlanAgent';
import { UDP_PORT_VXLAN } from '../vxlan/types';
import { TcpStack } from '../tcp/TcpStack';
import type { EthernetFrame, IPv4Packet, UDPPacket } from '../core/types';
import { IP_PROTO_UDP, IP_PROTO_TCP } from '../core/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';

export class HuaweiRouter extends Router {
  private readonly lldpAgent: LldpAgent;
  private readonly vrrpAgent: VrrpAgent;
  private readonly ntpAgent: NtpAgent;
  private readonly bfdAgent: BfdAgent;
  private readonly igmpAgent: IgmpAgent;
  private readonly pimAgent: PimAgent;
  private readonly syslogAgent: SyslogAgent;
  private readonly radiusClient: RadiusClientAgent;
  private readonly radiusServer: RadiusServerAgent;
  private readonly greAgent: GreAgent;
  private readonly snmpAgent: SnmpAgent;
  private readonly netflowAgent: NetFlowAgent;
  private readonly tacacsClient: TacacsClientAgent;
  private readonly tacacsServer: TacacsServerAgent;
  private readonly vxlanAgent: VxlanAgent;
  private readonly tcpStack: TcpStack;
  constructor(name: string = 'Router', x: number = 0, y: number = 0) {
    super('router-huawei', name, x, y);
    const hostBase = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
    };
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    this.vrrpAgent = new VrrpAgent(hostBase, () => this.getBus());
    this.ntpAgent = new NtpAgent(hostBase, () => this.getBus());
    this.bfdAgent = new BfdAgent(hostBase, () => this.getBus());
    this.igmpAgent = new IgmpAgent(hostBase, () => this.getBus());
    this.pimAgent = new PimAgent(hostBase, () => this.getBus());
    this.syslogAgent = new SyslogAgent(hostBase, () => this.getBus());
    this.radiusClient = new RadiusClientAgent(hostBase, () => this.getBus());
    this.radiusServer = new RadiusServerAgent(hostBase, () => this.getBus());
    this.greAgent = new GreAgent(hostBase, () => this.getBus());
    this.snmpAgent = new SnmpAgent({
      ...hostBase,
      getSysDescr: () => `Huawei VRP, ${this.name}`,
      getSysObjectId: () => '1.3.6.1.4.1.2011.2.27',
    }, () => this.getBus());
    this.netflowAgent = new NetFlowAgent(hostBase, () => this.getBus());
    this.tacacsClient = new TacacsClientAgent(hostBase, () => this.getBus(), () => this.tcpStack);
    this.tacacsServer = new TacacsServerAgent(hostBase, () => this.getBus(), () => this.tcpStack);
    this.vxlanAgent = new VxlanAgent(hostBase, () => this.getBus());
    this.tcpStack = new TcpStack(hostBase, () => this.getBus());
    this.lldpAgent.start();
    this.vrrpAgent.start();
    this.ntpAgent.start();
    this.bfdAgent.start();
    this.igmpAgent.start();
    this.pimAgent.start();
    this.syslogAgent.start();
    this.radiusClient.start();
    this.radiusServer.start();
    this.greAgent.start();
    this.snmpAgent.start();
    this.netflowAgent.start();
    this.tacacsClient.start();
    this.tacacsServer.start();
    this.vxlanAgent.start();
    this.tcpStack.start();
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    if (this.lldpAgent) { this.lldpAgent.stop(); this.lldpAgent.start(); }
    if (this.vrrpAgent) { this.vrrpAgent.stop(); this.vrrpAgent.start(); }
    if (this.ntpAgent) { this.ntpAgent.stop(); this.ntpAgent.start(); }
    if (this.bfdAgent) { this.bfdAgent.stop(); this.bfdAgent.start(); }
    if (this.igmpAgent) { this.igmpAgent.stop(); this.igmpAgent.start(); }
    if (this.pimAgent) { this.pimAgent.stop(); this.pimAgent.start(); }
    if (this.syslogAgent) { this.syslogAgent.stop(); this.syslogAgent.start(); }
    if (this.radiusClient) { this.radiusClient.stop(); this.radiusClient.start(); }
    if (this.radiusServer) { this.radiusServer.stop(); this.radiusServer.start(); }
    if (this.greAgent) { this.greAgent.stop(); this.greAgent.start(); }
    if (this.snmpAgent) { this.snmpAgent.stop(); this.snmpAgent.start(); }
    if (this.netflowAgent) { this.netflowAgent.stop(); this.netflowAgent.start(); }
    if (this.vxlanAgent) { this.vxlanAgent.stop(); this.vxlanAgent.start(); }
    if (this.tcpStack) { this.tcpStack.stop(); this.tcpStack.start(); }
    if (this.tacacsClient) { this.tacacsClient.stop(); this.tacacsClient.start(); }
    if (this.tacacsServer) { this.tacacsServer.stop(); this.tacacsServer.start(); }
  }

  protected override processIPv4(inPort: string, ipPkt: IPv4Packet): void {
    if (ipPkt.protocol === IP_PROTO_IGMP) {
      this.igmpAgent.handleIp(inPort, ipPkt.sourceIP, ipPkt);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_PIM) {
      this.pimAgent.handleIp(inPort, ipPkt.sourceIP, ipPkt);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_GRE) {
      const inner = this.greAgent.handleIp(inPort, ipPkt.sourceIP, ipPkt);
      if (inner) this.processIPv4(inPort, inner);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_TCP) {
      if (this.tcpStack.handleIp(inPort, ipPkt.sourceIP, ipPkt)) return;
    }
    if (ipPkt.protocol === IP_PROTO_UDP) {
      const udp = ipPkt.payload as UDPPacket | undefined;
      if (udp && udp.type === 'udp'
          && (udp.destinationPort === UDP_PORT_NTP || udp.sourcePort === UDP_PORT_NTP)) {
        this.ntpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_BFD_CONTROL) {
        this.bfdAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_RADIUS_AUTH) {
        this.radiusServer.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.sourcePort === UDP_PORT_RADIUS_AUTH) {
        this.radiusClient.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp'
          && (udp.destinationPort === UDP_PORT_SNMP || udp.sourcePort === UDP_PORT_SNMP)) {
        this.snmpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_VXLAN) {
        this.vxlanAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
    }
    super.processIPv4(inPort, ipPkt);
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    const dst = frame.dstMAC.toString().toLowerCase();
    if (frame.etherType === ETHERTYPE_LLDP && dst === LLDP_MULTICAST_MAC) {
      this.lldpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === 0x0800 && dst === VRRP_MULTICAST_MAC) {
      const ipPkt = frame.payload as IPv4Packet | undefined;
      if (ipPkt && ipPkt.protocol === IP_PROTO_VRRP) {
        this.vrrpAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        return;
      }
    }
    const octets = frame.dstMAC.getOctets();
    const isIpv4Multicast = octets[0] === 0x01 && octets[1] === 0x00 && octets[2] === 0x5e;
    if (frame.etherType === 0x0800 && isIpv4Multicast) {
      const ipPkt = frame.payload as IPv4Packet | undefined;
      if (ipPkt && ipPkt.protocol === IP_PROTO_IGMP) {
        this.igmpAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        return;
      }
      if (ipPkt && ipPkt.protocol === IP_PROTO_PIM && dst === PIM_ALL_ROUTERS_MAC) {
        this.pimAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        return;
      }
    }
    super.handleFrame(portName, frame);
  }

  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }
  getVrrpAgent(): VrrpAgent { return this.vrrpAgent; }
  getNtpAgent(): NtpAgent { return this.ntpAgent; }
  getBfdAgent(): BfdAgent { return this.bfdAgent; }
  getIgmpAgent(): IgmpAgent { return this.igmpAgent; }
  getPimAgent(): PimAgent { return this.pimAgent; }
  getSyslogAgent(): SyslogAgent { return this.syslogAgent; }
  getRadiusClient(): RadiusClientAgent { return this.radiusClient; }
  getRadiusServer(): RadiusServerAgent { return this.radiusServer; }
  getGreAgent(): GreAgent { return this.greAgent; }
  getSnmpAgent(): SnmpAgent { return this.snmpAgent; }
  getNetFlowAgent(): NetFlowAgent { return this.netflowAgent; }
  getTacacsClient(): TacacsClientAgent { return this.tacacsClient; }
  getTacacsServer(): TacacsServerAgent { return this.tacacsServer; }
  getVxlanAgent(): VxlanAgent { return this.vxlanAgent; }
  getTcpStack(): TcpStack { return this.tcpStack; }

  protected getVendorPortName(index: number): string {
    return `GE0/0/${index}`;
  }

  protected sshVendorTag(): 'huawei' { return 'huawei'; }

  protected createShell(): IRouterShell {
    return new HuaweiVRPShell();
  }

  /** Synchronous VRP exec whitelist consumed by the SSH cross-platform dispatch. */
  override getSshMotd(): string {
    return `Huawei Versatile Routing Platform Software\n<${this.hostname}>`;
  }

  override runSshCommandSync(
    _user: string,
    command: string,
  ): { output: string; exitCode: number } | null {
    let cmd = command.trim();
    if (!cmd) return { output: '', exitCode: 0 };
    if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
      cmd = cmd.slice(1, -1).trim();
    }

    if (/^hostname\s*$/i.test(cmd)) {
      return { output: `${this.hostname}\n`, exitCode: 0 };
    }
    // Expand VRP `command-alias alias <head>` shortcuts before pattern
    // matching so `ssh ... "dis-int Gi0/0/0"` invokes display interface.
    const expanded = this._getCommandAliases().expand(cmd);
    if (expanded !== cmd) return this.runSshCommandSync(_user, expanded);
    if (/^display\s+version\s*$/i.test(cmd)) {
      return { output: `${displayVersion(this)}\n`, exitCode: 0 };
    }
    if (/^display\s+logbuffer\s*$/i.test(cmd)) {
      const audit = this.getSecurityAuditLog();
      const header = 'Logging buffer configuration and contents: enabled\nAllowed max buffer size : 1024\nActual buffer size : 1024\nChannel number : 4, Channel name : logbuffer\nDropped messages : 0\nOverwritten messages : 0\nCurrent messages : ' + audit.entries().length + '\n';
      return { output: `${header}${audit.format()}\n`, exitCode: 0 };
    }
    if (/^display\s+users\s*$/i.test(cmd)) {
      return { output: `${this.getSshSessionRegistry().formatDisplayUsers()}\n`, exitCode: 0 };
    }
    if (/^display\s+local-user\s*$/i.test(cmd)) {
      const users = this._listLocalUsers();
      return { output: `User-name              State   Type   Privilege\n${users.map(u => `${u.name.padEnd(22)} A       SSH    ${u.privilege}`).join('\n')}\n`, exitCode: 0 };
    }
    if (/^display\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${displayInterfaceBrief(this)}\n`, exitCode: 0 };
    }
    // `display interface <name>` — per-interface details (matches the
    // VRP convention used after the command-alias expansion above).
    const dispInt = /^display\s+int(?:erface)?\s+(\S+)\s*$/i.exec(cmd);
    if (dispInt) {
      const portName = resolveHuaweiIfName(Array.from(this._getPortsInternal().keys()), dispInt[1]) || dispInt[1];
      const port = this.getPort(portName);
      if (!port) {
        return { output: `Error: Wrong parameter found at '^' position.\n`, exitCode: 1 };
      }
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const lines = [
        `${dispInt[1]} current state : ${port.getIsUp() ? 'UP' : 'DOWN'}`,
        `Line protocol current state : ${port.getIsUp() ? 'UP' : 'DOWN'}`,
        `Description:`,
        `Switch Port, Link-type : auto negotiation,`,
        `Hardware address is ${port.getMAC()}`,
        ip && mask ? `Internet Address is ${ip}/${mask}` : 'Internet protocol processing : disabled',
      ];
      return { output: `${lines.join('\n')}\n`, exitCode: 0 };
    }
    if (/^display\s+ip\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${displayIpIntBrief(this)}\n`, exitCode: 0 };
    }
    // `display current-configuration [ | include … ]` — synthesises a
    // VRP-style running config with the SSH-relevant directives that
    // were captured by the shell hooks.
    const dispMatch = /^display\s+current-configuration(?:\s*\|\s*(include|exclude)\s+(.+))?$/i.exec(cmd);
    if (dispMatch) {
      const base = displayCurrentConfig(this, false, false, new Set());
      const lines = base.split('\n');
      for (const u of this._listLocalUsers()) {
        lines.push(`local-user ${u.name} password cipher ${u.secret}`);
        lines.push(`local-user ${u.name} privilege level ${u.privilege}`);
      }
      const retries = this.getSshAuthenticationRetries();
      if (retries !== null) lines.push(`ssh server authentication-retries ${retries}`);
      // Append SSH-state directives so SSH-aware tests see them. Real
      // VRP emits "protocol inbound ssh" specifically when ssh is among
      // the permitted protocols (not just when 'all' is set), so the
      // grep-style assertions in operations notebooks keep working.
      if (this.sshServerEnabled) lines.push('stelnet server enable');
      if (this.vtyTransportInput === 'all' || this.vtyTransportInput === 'ssh') {
        lines.push('protocol inbound ssh');
      } else if (this.vtyTransportInput === 'telnet') {
        lines.push('protocol inbound telnet');
      } else if (this.vtyTransportInput === 'none') {
        lines.push('protocol inbound none');
      }
      const out = lines.join('\n');
      if (!dispMatch[1]) return { output: `${out}\n`, exitCode: 0 };
      const needle = dispMatch[2].trim();
      const filtered = dispMatch[1].toLowerCase() === 'include'
        ? lines.filter(l => l.includes(needle))
        : lines.filter(l => !l.includes(needle));
      return { output: `${filtered.join('\n')}\n`, exitCode: 0 };
    }
    return null;
  }

  getBootSequence(): string {
    const ports = this._getPortsInternal();
    return [
      '',
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      'BOARD TYPE:          AR2220',
      'BootROM Version:     1.0',
      '',
      `${ports.size} GigabitEthernet interfaces`,
      '',
      `Base ethernet MAC address: ${ports.values().next().value?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press any key to get started.',
    ].join('\n');
  }
}

function lldpToNeighborDTO(rows: readonly LldpNeighbor[]): NeighborDTO[] {
  return rows.map(n => ({
    localPort: n.localPort,
    remoteHost: n.systemName,
    remotePort: n.portId,
    remoteType: n.remoteType,
    remotePlatform: n.systemDescription.split(',')[0] ?? n.systemDescription,
    remoteCapability: n.remoteCapabilities[0] === 'Router' ? 'Router'
      : n.remoteCapabilities[0] === 'Bridge' ? 'Switch' : 'Host',
  }));
}
