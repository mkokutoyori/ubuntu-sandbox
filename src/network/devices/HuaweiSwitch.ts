import { DeviceType, EthernetFrame, ETHERTYPE_IPV4, IPAddress, type MACAddress } from '../core/types';
import { AgentRegistry } from './AgentRegistry';
import { lldpToNeighborDTO } from './inspection/neighborConverters';
import { Switch, STPPortState } from './Switch';
import type { ISwitchShell } from './shells/ISwitchShell';
import { HuaweiSwitchShell } from './shells/HuaweiSwitchShell';
import { NATEngine } from './router/NATEngine';
import { VRP_ACL_NUMBERING, VRP_SEQUENCING, VRP_DEFAULT_STEP, sourceProbePacket } from './router/ACLEngine';
import { LldpAgent } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP } from '../lldp/types';
import { StpAgent, type StpForwardState } from '../stp/StpAgent';
import { ETHERTYPE_STP } from '../stp/types';
import { LacpAgent } from '../lacp/LacpAgent';
import { ETHERTYPE_LACP } from '../lacp/types';
import { IgmpSnoopingAgent } from '../igmp-snooping/IgmpSnoopingAgent';
import { PimSnoopingAgent } from '../pim-snooping/PimSnoopingAgent';
import { Dot1xAgent } from '../dot1x/Dot1xAgent';
import { ETHERTYPE_EAPOL } from '../dot1x/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';
import { HuaweiDebugService } from './router/diag/HuaweiDebugService';
import { RouterManagementService } from './router/management/RouterManagementService';
import { SnmpService } from './router/management/SnmpService';

export class HuaweiSwitch extends Switch {
  static readonly MAX_PORT_GROUPS = 32;
  static readonly MAX_PORT_GROUP_MEMBERS = 48;

  private readonly agents = new AgentRegistry();
  private readonly lldpAgent: LldpAgent;
  private readonly stpAgent: StpAgent;
  private readonly lacpAgent: LacpAgent;
  private readonly igmpSnoopingAgent: IgmpSnoopingAgent;
  private readonly pimSnoopingAgent: PimSnoopingAgent;
  private readonly dot1xAgent: Dot1xAgent;
  private readonly natEngine = new NATEngine();
  _getNATEngine(): NATEngine { return this.natEngine; }
  private readonly voiceVlanOuiEntries: Array<{ macHex: string; maskHex: string; description?: string }> = [];

  constructor(type: DeviceType = 'switch-huawei', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, portCount, x, y);
    // Même raison que sur HuaweiRouter : les plages VRP, pas celles d'IOS.
    this.getVaclEngine().setNumberingPolicy(VRP_ACL_NUMBERING);
    this.getVaclEngine().setSequencingPolicy(VRP_SEQUENCING, VRP_DEFAULT_STEP);
    this.getVaclEngine().setUnmatchedDataPlaneAction('permit');
    this.natEngine.setDeviceId(this.id, this.getHostname());
    this.natEngine.setEventBus(this.getBus());
    this.natEngine.setACLMatchFn((aclId, srcIP, realPkt) => {
      const pkt = realPkt ?? sourceProbePacket(new IPAddress(srcIP));
      return this.getVaclEngine().evaluateACLByName(String(aclId), pkt) === 'permit';
    });
    this.natEngine.setInterfaceIPFn((iface) => {
      const m = iface.match(/^Vlanif(\d+)$/);
      if (!m) return null;
      return this.getSvi(Number(m[1]))?.ip?.toString() ?? null;
    });
    const hostBase = {
      sendOnLink: (request: import('../layers/link/LinkLayer').LinkSendRequest) =>
        this.getLinkLayer().send(request),
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
    };
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    const firstPort = this.getPorts()[0];
    const baseMac = firstPort ? firstPort.getMAC().toString() : '00:00:00:00:00:00';
    this.stpAgent = new StpAgent({
      ...hostBase,
      onForwardStateChanged: (p, s, v) => this.applyStpForwardState(p, s, v),
      onTopologyChangeAging: (sec) => this._setStpFastAging(sec),
      getStpPortVlans: (p) => this.getStpPortVlans(p),
      getStpBundleGroup: (p) => this.getStpBundleGroup(p),
    }, () => this.getBus(), baseMac);
    this.lacpAgent = new LacpAgent({
      ...hostBase,
      onLacpBundleChanged: (port, groupId, bundled) =>
        this.stpAgent.onBundleChanged(port, `Eth-Trunk${groupId}`, bundled),
    }, () => this.getBus(), baseMac);
    this.stpAgent.setMode('mstp');
    this.stpAgent.setPathcostMethod('long');
    this.igmpSnoopingAgent = new IgmpSnoopingAgent({
      ...hostBase,
      resolveIngressVlan: (p: string) => this.resolveSnoopingVlan(p),
      isTrunkPort: (p: string) => this._vtpIsTrunkPort(p),
      getSviIp: (vlan: number) =>
        this.getSvis().find(s => s.vlan === vlan)?.ip?.toString() ?? null,
      getVlanIds: () => [...this.getVLANs().keys()],
    }, () => this.getBus());
    this.pimSnoopingAgent = new PimSnoopingAgent({
      ...hostBase,
      resolveIngressVlan: (p: string) => this.resolveSnoopingVlan(p),
      isTrunkPort: (p: string) => this._vtpIsTrunkPort(p),
    }, () => this.getBus());
    this.dot1xAgent = new Dot1xAgent({
      ...hostBase,
      onDot1xPortAuthorized: (p, authorized) => this.applyDot1xAuth(p, authorized),
    }, () => this.getBus());
    this.agents.registerAll(
      this.lldpAgent, this.stpAgent, this.lacpAgent, this.igmpSnoopingAgent, this.pimSnoopingAgent,
      this.dot1xAgent,
    );
    this.agents.startAll();
  }

  private applyDot1xAuth(portName: string, authorized: boolean): void {
    if (!authorized) this.flushDynamicMacsOnPort(portName, 'dot1x-unauthorized');
  }

  /**
   * The Eth-Trunk a port is currently bundled into. VRP runs STP on the
   * trunk, not on its members, exactly as IOS does on a Port-channel.
   */
  private getStpBundleGroup(portName: string): { groupKey: string; members: string[] } | undefined {
    const info = this.lacpAgent.getPortInfo(portName);
    if (!info || !info.bundled) return undefined;
    const members = this.lacpAgent.getGroupMembers(info.groupId)
      .filter(p => p.bundled)
      .map(p => p.portName)
      .sort();
    if (members.length === 0) return undefined;
    return { groupKey: `Eth-Trunk${info.groupId}`, members };
  }

  private applyStpForwardState(portName: string, state: StpForwardState, vlan: number): void {
    this.setStpVlanState(portName, vlan, state);
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    // Re-bind every agent's subscriptions to the newly injected bus.
    // (setEventBus can fire from the base constructor, before the registry
    // field initializer ran — hence the optional chain.)
    this.agents?.restartAll();
    this._huaweiDebugService?.attachToBus(this.getBus(), this.id, this);
  }

  private _huaweiDebugService: HuaweiDebugService | null = null;

  /**
   * Le switch n'avait AUCUN magasin : `debugging stp` repondait
   * `Info: stp debugging is on.` et n'etait range nulle part, tandis que
   * `display debugging` etait refuse — la commande ne pouvait donc ni
   * agir ni etre relue. Meme service que le routeur, meme table, sur les
   * categories que cette plateforme sait tracer.
   */
  getHuaweiDebugService(): HuaweiDebugService {
    if (!this._huaweiDebugService) {
      this._huaweiDebugService = new HuaweiDebugService();
      this._huaweiDebugService.setPlatform('switch');
    }
    this._huaweiDebugService.attachToBus(this.getBus(), this.id, this);
    return this._huaweiDebugService;
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    if (frame.etherType === ETHERTYPE_LLDP) {
      if (this.isL2ProtocolTunneled(portName, 'lldp')) { super.handleFrame(portName, frame); return; }
      this.lldpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_STP) {
      if (this.isL2ProtocolTunneled(portName, 'stp')) { super.handleFrame(portName, frame); return; }
      this.stpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_LACP) {
      this.lacpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_EAPOL) {
      this.dot1xAgent.handleFrame(portName, frame);
      return;
    }
    if (!this.dot1xAgent.isPortAuthorized(portName)) {
      return;
    }
    this.igmpSnoopingAgent.handleFrame(portName, frame);
    this.pimSnoopingAgent.handleFrame(portName, frame);
    super.handleFrame(portName, frame);
  }

  protected override getIgmpSnoopingAgentOrNull(): IgmpSnoopingAgent {
    return this.igmpSnoopingAgent;
  }

  protected override getPimSnoopingAgentOrNull(): PimSnoopingAgent {
    return this.pimSnoopingAgent;
  }

  addVoiceVlanOui(macHex: string, maskHex: string, description?: string): void {
    this.voiceVlanOuiEntries.push({ macHex, maskHex, description });
  }

  getVoiceVlanOuiEntries(): ReadonlyArray<{ macHex: string; maskHex: string; description?: string }> {
    return this.voiceVlanOuiEntries;
  }

  protected override matchesVoiceVlanOui(mac: MACAddress): boolean {
    const macHex = mac.toString().replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    for (const entry of this.voiceVlanOuiEntries) {
      let match = true;
      for (let i = 0; i < 12; i += 2) {
        const macByte = parseInt(macHex.slice(i, i + 2), 16);
        const entryByte = parseInt(entry.macHex.slice(i, i + 2), 16);
        const maskByte = parseInt(entry.maskHex.slice(i, i + 2), 16);
        if ((macByte & maskByte) !== (entryByte & maskByte)) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }

  private _managementService: RouterManagementService | null = null;
  getManagementService(): RouterManagementService {
    if (!this._managementService) this._managementService = new RouterManagementService();
    return this._managementService;
  }

  private _snmpService: SnmpService | null = null;
  getSnmpService(): SnmpService {
    if (!this._snmpService) this._snmpService = new SnmpService();
    return this._snmpService;
  }

  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }
  private readonly portGroups = new Map<string, string[]>();

  getPortGroups(): [string, string[]][] {
    return [...this.portGroups].map(([n, m]) => [n, [...m]] as [string, string[]])
      .sort((a, b) => a[0].localeCompare(b[0]));
  }

  getPortGroupMembers(name: string): string[] | null {
    const m = this.portGroups.get(name);
    return m ? [...m] : null;
  }

  createPortGroup(name: string): boolean {
    if (this.portGroups.has(name)) return true;
    if (this.portGroups.size >= HuaweiSwitch.MAX_PORT_GROUPS) return false;
    this.portGroups.set(name, []);
    return true;
  }

  deletePortGroup(name: string): boolean {
    return this.portGroups.delete(name);
  }

  addPortGroupMembers(name: string, ports: readonly string[]): 'ok' | 'absent' | 'plein' {
    const membres = this.portGroups.get(name);
    if (!membres) return 'absent';
    const fusion = [...new Set([...membres, ...ports])];
    if (fusion.length > HuaweiSwitch.MAX_PORT_GROUP_MEMBERS) return 'plein';
    this.portGroups.set(name, fusion);
    return 'ok';
  }

  removePortGroupMembers(name: string, ports: readonly string[]): boolean {
    const membres = this.portGroups.get(name);
    if (!membres) return false;
    this.portGroups.set(name, membres.filter(m => !ports.includes(m)));
    return true;
  }

  getStpAgent(): StpAgent { return this.stpAgent; }
  getLacpAgent(): LacpAgent { return this.lacpAgent; }
  getIgmpSnoopingAgent(): IgmpSnoopingAgent { return this.igmpSnoopingAgent; }
  getPimSnoopingAgent(): PimSnoopingAgent { return this.pimSnoopingAgent; }
  getDot1xAgent(): Dot1xAgent { return this.dot1xAgent; }

  protected getPortName(index: number, _total: number): string {
    return `GigabitEthernet0/0/${index}`;
  }

  protected getInitialSTPState(): STPPortState {
    return 'listening';
  }

  protected createShell(): ISwitchShell {
    return new HuaweiSwitchShell();
  }

  protected onVlanDeleted(_vlanId: number, affectedPorts: string[]): void {
    const defaultVlan = this.vlans.get(1);
    for (const portName of affectedPorts) {
      const cfg = this._getSwitchportConfigs().get(portName);
      if (cfg) cfg.accessVlan = 1;
      if (defaultVlan) defaultVlan.ports.add(portName);
      this.portVlanStates.set(portName, 'active');
    }
  }

  protected onVlanRecreated(_vlanId: number): string[] {
    return [];
  }

  getOSType(): string { return 'huawei-vrp'; }

  getBootSequence(): string {
    return [
      '',
      `Huawei Versatile Routing Platform Software`,
      `VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)`,
      `Copyright (C) 2000-2025 HUAWEI TECH CO., LTD`,
      '',
      `${this.hostname} with ${this.getPortNames().length} GigabitEthernet interfaces`,
      `Base ethernet MAC address: ${this.getPort(this.getPortNames()[0])?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press ENTER to get started.',
    ].join('\n');
  }
}
