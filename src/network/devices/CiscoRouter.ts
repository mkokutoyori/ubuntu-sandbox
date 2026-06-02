/**
 * CiscoRouter - Cisco IOS Router specialization
 *
 * Extends abstract Router with Cisco-specific:
 *   - Port naming: GigabitEthernet0/X
 *   - CLI shell: CiscoIOSShell
 *   - Boot sequence: Cisco IOS bootstrap
 */

import { Router } from './Router';
import type { IRouterShell } from './shells/IRouterShell';
import { CiscoIOSShell } from './shells/CiscoIOSShell';
import {
  showVersion,
  showInterfacesStatus,
  showRunningConfig,
  showIpIntBrief,
} from './shells/cisco/CiscoShowCommands';
import { CdpAgent, type CdpNeighbor } from '../cdp/CdpAgent';
import { ETHERTYPE_CDP, CDP_MULTICAST_MAC } from '../cdp/types';
import { LldpAgent, type LldpNeighbor } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP, LLDP_MULTICAST_MAC } from '../lldp/types';
import { HsrpAgent } from '../hsrp/HsrpAgent';
import { UDP_PORT_HSRP } from '../hsrp/types';
import { VrrpAgent } from '../vrrp/VrrpAgent';
import { IP_PROTO_VRRP, VRRP_MULTICAST_MAC } from '../vrrp/types';
import { NtpAgent } from '../ntp/NtpAgent';
import { UDP_PORT_NTP } from '../ntp/types';
import { GlbpAgent } from '../glbp/GlbpAgent';
import { UDP_PORT_GLBP, GLBP_MULTICAST_MAC } from '../glbp/types';
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
import { PORT_TACACS } from '../tacacs/types';
import { VxlanAgent } from '../vxlan/VxlanAgent';
import { UDP_PORT_VXLAN } from '../vxlan/types';
import type { EthernetFrame, IPv4Packet, UDPPacket } from '../core/types';
import { IP_PROTO_UDP } from '../core/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';

export class CiscoRouter extends Router {
  private readonly cdpAgent: CdpAgent;
  private readonly lldpAgent: LldpAgent;
  private readonly hsrpAgent: HsrpAgent;
  private readonly vrrpAgent: VrrpAgent;
  private readonly ntpAgent: NtpAgent;
  private readonly glbpAgent: GlbpAgent;
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
  constructor(name: string = 'Router', x: number = 0, y: number = 0) {
    super('router-cisco', name, x, y);
    const hostBase = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
    };
    this.cdpAgent = new CdpAgent(hostBase, () => this.getBus());
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    this.hsrpAgent = new HsrpAgent(hostBase, () => this.getBus());
    this.vrrpAgent = new VrrpAgent(hostBase, () => this.getBus());
    this.ntpAgent = new NtpAgent(hostBase, () => this.getBus());
    this.glbpAgent = new GlbpAgent(hostBase, () => this.getBus());
    this.bfdAgent = new BfdAgent(hostBase, () => this.getBus());
    this.igmpAgent = new IgmpAgent(hostBase, () => this.getBus());
    this.pimAgent = new PimAgent(hostBase, () => this.getBus());
    this.syslogAgent = new SyslogAgent(hostBase, () => this.getBus());
    this.radiusClient = new RadiusClientAgent(hostBase, () => this.getBus());
    this.radiusServer = new RadiusServerAgent(hostBase, () => this.getBus());
    this.greAgent = new GreAgent(hostBase, () => this.getBus());
    this.snmpAgent = new SnmpAgent({
      ...hostBase,
      getSysDescr: () => `Cisco IOS Software, ${this.name}`,
      getSysObjectId: () => '1.3.6.1.4.1.9.1.222',
    }, () => this.getBus());
    this.netflowAgent = new NetFlowAgent(hostBase, () => this.getBus());
    this.tacacsClient = new TacacsClientAgent(hostBase, () => this.getBus());
    this.tacacsServer = new TacacsServerAgent(hostBase, () => this.getBus());
    this.vxlanAgent = new VxlanAgent(hostBase, () => this.getBus());
    this.cdpAgent.start();
    this.lldpAgent.start();
    this.hsrpAgent.start();
    this.vrrpAgent.start();
    this.ntpAgent.start();
    this.glbpAgent.start();
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
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    if (this.cdpAgent) { this.cdpAgent.stop(); this.cdpAgent.start(); }
    if (this.lldpAgent) { this.lldpAgent.stop(); this.lldpAgent.start(); }
    if (this.hsrpAgent) { this.hsrpAgent.stop(); this.hsrpAgent.start(); }
    if (this.vrrpAgent) { this.vrrpAgent.stop(); this.vrrpAgent.start(); }
    if (this.ntpAgent) { this.ntpAgent.stop(); this.ntpAgent.start(); }
    if (this.glbpAgent) { this.glbpAgent.stop(); this.glbpAgent.start(); }
    if (this.bfdAgent) { this.bfdAgent.stop(); this.bfdAgent.start(); }
    if (this.igmpAgent) { this.igmpAgent.stop(); this.igmpAgent.start(); }
    if (this.pimAgent) { this.pimAgent.stop(); this.pimAgent.start(); }
    if (this.syslogAgent) { this.syslogAgent.stop(); this.syslogAgent.start(); }
    if (this.radiusClient) { this.radiusClient.stop(); this.radiusClient.start(); }
    if (this.radiusServer) { this.radiusServer.stop(); this.radiusServer.start(); }
    if (this.greAgent) { this.greAgent.stop(); this.greAgent.start(); }
    if (this.snmpAgent) { this.snmpAgent.stop(); this.snmpAgent.start(); }
    if (this.netflowAgent) { this.netflowAgent.stop(); this.netflowAgent.start(); }
    if (this.tacacsClient) { this.tacacsClient.stop(); this.tacacsClient.start(); }
    if (this.tacacsServer) { this.tacacsServer.stop(); this.tacacsServer.start(); }
    if (this.vxlanAgent) { this.vxlanAgent.stop(); this.vxlanAgent.start(); }
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
    if (ipPkt.protocol === IP_PROTO_UDP) {
      const udp = ipPkt.payload as UDPPacket | undefined;
      if (udp && udp.type === 'udp') {
        if (udp.destinationPort === UDP_PORT_HSRP) {
          this.hsrpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.destinationPort === UDP_PORT_NTP || udp.sourcePort === UDP_PORT_NTP) {
          this.ntpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.destinationPort === UDP_PORT_GLBP) {
          this.glbpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.destinationPort === UDP_PORT_BFD_CONTROL) {
          this.bfdAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.destinationPort === UDP_PORT_RADIUS_AUTH) {
          this.radiusServer.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.sourcePort === UDP_PORT_RADIUS_AUTH) {
          this.radiusClient.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.destinationPort === UDP_PORT_SNMP || udp.sourcePort === UDP_PORT_SNMP) {
          this.snmpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.destinationPort === PORT_TACACS) {
          this.tacacsServer.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.sourcePort === PORT_TACACS) {
          this.tacacsClient.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
        if (udp.destinationPort === UDP_PORT_VXLAN) {
          this.vxlanAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
          return;
        }
      }
    }
    super.processIPv4(inPort, ipPkt);
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    const dst = frame.dstMAC.toString().toLowerCase();
    if (frame.etherType === ETHERTYPE_CDP && dst === CDP_MULTICAST_MAC) {
      this.cdpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_LLDP && dst === LLDP_MULTICAST_MAC) {
      this.lldpAgent.handleFrame(portName, frame);
      return;
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
      if (ipPkt && ipPkt.protocol === IP_PROTO_UDP) {
        const udp = ipPkt.payload as UDPPacket | undefined;
        if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_HSRP) {
          this.hsrpAgent.handleUdp(portName, ipPkt.sourceIP, udp);
          return;
        }
        if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_GLBP
            && dst === GLBP_MULTICAST_MAC) {
          this.glbpAgent.handleUdp(portName, ipPkt.sourceIP, udp);
          return;
        }
      }
      if (ipPkt && ipPkt.protocol === IP_PROTO_VRRP
          && dst === VRRP_MULTICAST_MAC) {
        this.vrrpAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        return;
      }
    }
    super.handleFrame(portName, frame);
  }

  getCdpAgent(): CdpAgent { return this.cdpAgent; }
  getCdpNeighbors(): NeighborDTO[] { return cdpToNeighborDTO(this.cdpAgent.getNeighbors()); }
  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }
  getHsrpAgent(): HsrpAgent { return this.hsrpAgent; }
  getVrrpAgent(): VrrpAgent { return this.vrrpAgent; }
  getNtpAgent(): NtpAgent { return this.ntpAgent; }
  getGlbpAgent(): GlbpAgent { return this.glbpAgent; }
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

  protected getVendorPortName(index: number): string {
    return `GigabitEthernet0/${index}`;
  }

  protected sshVendorTag(): 'cisco' { return 'cisco'; }

  protected createShell(): IRouterShell {
    return new CiscoIOSShell();
  }

  /** Synchronous IOS exec whitelist consumed by the SSH cross-platform dispatch. */
  override getSshMotd(): string {
    return `Cisco IOS Software\n${this.hostname}#`;
  }

  /**
   * Synthetic SFTP-file source — Cisco IOS exposes running-config /
   * startup-config / flash:/ over scp when `ip scp server enable` is
   * set. The scp adapter calls read() with a path; we return the
   * canonical text the user would see via `show running-config`.
   */
  getSftpFileSource(): { read: (p: string) => string | null; list: () => readonly string[] } {
    const knownFiles = ['running-config', 'startup-config'];
    return {
      read: (path: string) => {
        const p = path.replace(/^\/+/, '').toLowerCase();
        if (p === 'running-config' || p === 'system:running-config') return showRunningConfig(this);
        if (p === 'startup-config' || p === 'nvram:startup-config') return showRunningConfig(this);
        return null;
      },
      list: () => knownFiles,
    };
  }

  override runSshCommandSync(
    _user: string,
    command: string,
  ): { output: string; exitCode: number } | null {
    let trimmed = command.trim();
    if (!trimmed) return { output: '', exitCode: 0 };
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      trimmed = trimmed.slice(1, -1).trim();
    }

    // Expand `alias exec <head>` shortcuts before any pattern match so
    // `ssh ... "si"` invokes `show ip interface brief` via the dispatcher.
    const aliasHead = trimmed.split(/\s+/)[0];
    const shellAliases = (this as unknown as { shell?: { aliases?: { resolve: (m: string, n: string) => string | null } } }).shell?.aliases;
    const aliasExpansion = shellAliases?.resolve('exec', aliasHead) ?? null;
    const cmd = aliasExpansion
      ? aliasExpansion + trimmed.slice(aliasHead.length)
      : trimmed;

    // Universal connectivity probe used by every cross-vendor client.
    if (/^hostname\s*$/i.test(cmd)) {
      return { output: `${this.hostname}\n`, exitCode: 0 };
    }
    // `show version` — model + IOS banner.
    if (/^show\s+version\s*$/i.test(cmd)) {
      return { output: `${showVersion(this)}\n`, exitCode: 0 };
    }
    if (/^show\s+logging\s*$/i.test(cmd)) {
      const audit = this.getSecurityAuditLog();
      const formatted = audit.format();
      const header = 'Syslog logging: enabled (0 messages dropped, 0 flushes, 0 overruns, xml disabled, filtering disabled)\nConsole logging: level debugging, 0 messages logged, xml disabled\nMonitor logging: level debugging, 0 messages logged, xml disabled\nBuffer logging: level debugging, 0 messages logged, xml disabled\n\nLog Buffer (4096 bytes):\n';
      return { output: `${header}${formatted}\n`, exitCode: 0 };
    }
    if (/^show\s+privilege\s*$/i.test(cmd)) {
      return { output: 'Current privilege level is 15\n', exitCode: 0 };
    }
    if (/^show\s+users?\s*$/i.test(cmd)) {
      return { output: `${this.getSshSessionRegistry().formatShowUsers()}\n`, exitCode: 0 };
    }
    // `show interfaces status` — link state per port.
    if (/^show\s+int(?:erfaces)?\s+status\s*$/i.test(cmd)) {
      return { output: `${showInterfacesStatus(this)}\n`, exitCode: 0 };
    }
    // `show ip interface brief`.
    if (/^show\s+ip\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${showIpIntBrief(this)}\n`, exitCode: 0 };
    }
    // `show running-config [ | include … ]` — pipe filter supported.
    const runMatch = /^show\s+run(?:ning-config)?(?:\s*\|\s*(include|exclude)\s+(.+))?$/i.exec(cmd);
    if (runMatch) {
      const base = showRunningConfig(this);
      const extra: string[] = this._listLocalUsers().map(u =>
        `username ${u.name} privilege ${u.privilege} secret 5 ${u.secret}`,
      );
      const blockCfg = this.getLoginBlockConfig();
      if (blockCfg) extra.push(`login block-for ${blockCfg.blockSeconds} attempts ${blockCfg.attempts} within ${blockCfg.withinSeconds}`);
      const full = extra.length > 0 ? `${base}\n${extra.join('\n')}` : base;
      if (!runMatch[1]) return { output: `${full}\n`, exitCode: 0 };
      const needle = runMatch[2].trim();
      const lines = full.split('\n');
      const filtered = runMatch[1].toLowerCase() === 'include'
        ? lines.filter(l => l.includes(needle))
        : lines.filter(l => !l.includes(needle));
      return { output: `${filtered.join('\n')}\n`, exitCode: 0 };
    }
    return null;
  }

  getBootSequence(): string {
    const ports = this._getPortsInternal();
    const giPorts = [...ports.keys()].filter(n => n.startsWith('Gig'));
    const faPorts = [...ports.keys()].filter(n => n.startsWith('Fast'));
    return [
      '',
      'System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)',
      'Copyright (c) 2003-2025 by cisco Systems, Inc.',
      '',
      `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5, RELEASE SOFTWARE (fc1)`,
      'Technical Support: http://www.cisco.com/techsupport',
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      'Cisco C2911 (revision 1.0) with 524288K/65536K bytes of memory.',
      'Processor board ID FTX1234567A',
      `${giPorts.length} Gigabit Ethernet interfaces`,
      ...(faPorts.length > 0 ? [`${faPorts.length} FastEthernet interfaces`] : []),
      'DRAM configuration is 64 bits wide with parity enabled.',
      '256K bytes of non-volatile configuration memory.',
      '',
      `Base ethernet MAC address: ${ports.values().next().value?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      '--- System Configuration Dialog ---',
      '',
      'Press RETURN to get started.',
    ].join('\n');
  }
}

function cdpToNeighborDTO(rows: readonly CdpNeighbor[]): NeighborDTO[] {
  return rows.map(n => ({
    localPort: n.localPort,
    remoteHost: n.remoteHost,
    remotePort: n.remotePort,
    remoteType: n.remoteType,
    remotePlatform: n.remotePlatform,
    remoteCapability: n.remoteCapability,
  }));
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
