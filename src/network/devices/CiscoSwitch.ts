/**
 * CiscoSwitch - Cisco Catalyst 3560 Multilayer Switch
 *
 * Cisco-specific behaviors:
 *   - Port naming: FastEthernet0/X (first 24), GigabitEthernet0/X (25+)
 *   - STP: PortFast enabled by default → ports start in forwarding state
 *   - VLAN deletion: access ports become suspended/inactive
 *     They don't forward traffic until the VLAN is recreated.
 *   - VLAN recreation: suspended ports are reactivated automatically
 *   - CLI: CiscoSwitchShell (IOS-style user/privileged/config modes)
 *   - Boot: Cisco IOS C3560 format
 */

import { DeviceType, EthernetFrame, ETHERTYPE_IPV4, IPv4Packet, IPAddress } from '../core/types';
import { AgentRegistry } from './AgentRegistry';
import { cdpToNeighborDTO, lldpToNeighborDTO } from './inspection/neighborConverters';
import { Switch, STPPortState, type SwitchportMode } from './Switch';
import type { ISwitchShell } from './shells/ISwitchShell';
import { C3560_SOFTWARE, ciscoSoftwareDescriptor } from './shells/cisco/CiscoPlatform';
import { CiscoSwitchShell } from './shells/CiscoSwitchShell';
import { CdpAgent } from '../cdp/CdpAgent';
import { ETHERTYPE_CDP } from '../cdp/types';
import { LldpAgent } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP } from '../lldp/types';
import { DtpAgent } from '../dtp/DtpAgent';
import { ETHERTYPE_DTP, type DtpOperationalMode } from '../dtp/types';
import { StpAgent, type StpForwardState } from '../stp/StpAgent';
import { ETHERTYPE_STP } from '../stp/types';
import { LacpAgent } from '../lacp/LacpAgent';
import { ETHERTYPE_LACP } from '../lacp/types';
import { VtpAgent } from '../vtp/VtpAgent';
import { ETHERTYPE_VTP } from '../vtp/types';
import { UdldAgent } from '../udld/UdldAgent';
import { ETHERTYPE_UDLD } from '../udld/types';
import { IgmpSnoopingAgent } from '../igmp-snooping/IgmpSnoopingAgent';
import { PimSnoopingAgent } from '../pim-snooping/PimSnoopingAgent';
import { SyslogAgent } from '../syslog/SyslogAgent';
import { Dot1xAgent } from '../dot1x/Dot1xAgent';
import { ETHERTYPE_EAPOL } from '../dot1x/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';
import type { TimerHandle } from '@/events/Scheduler';
import { Logger } from '../core/Logger';
import { RouterDebugService } from './router/diag/RouterDebugService';
import { ArchiveService } from './router/archive/ArchiveService';

export class CiscoSwitch extends Switch {
  private readonly agents = new AgentRegistry();
  private readonly cdpAgent: CdpAgent;
  private readonly lldpAgent: LldpAgent;
  private readonly dtpAgent: DtpAgent;
  private readonly stpAgent: StpAgent;
  private readonly lacpAgent: LacpAgent;
  private readonly vtpAgent: VtpAgent;
  private readonly udldAgent: UdldAgent;
  private readonly igmpSnoopingAgent: IgmpSnoopingAgent;
  private readonly pimSnoopingAgent: PimSnoopingAgent;
  private readonly syslogAgent: SyslogAgent;
  private readonly dot1xAgent: Dot1xAgent;

  /**
   * Un Catalyst archive sa configuration comme un routeur le fait ; la
   * famille `archive` était refusée en bloc ici alors qu'elle existait
   * déjà côté routeur (audit 13 §4.2). Même service, pas une seconde
   * implémentation.
   */
  private readonly archiveService = new ArchiveService();
  getArchiveService(): ArchiveService { return this.archiveService; }

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, portCount, x, y);
    const hostBase = {
      sendOnLink: (request: import('../layers/link/LinkLayer').LinkSendRequest) =>
        this.getLinkLayer().send(request),
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
      sendUdpDatagram: (request: import('../layers/transport/UdpEgress').UdpSendRequest) =>
        this.sendUdpDatagram(request),
    };
    this.cdpAgent = new CdpAgent({
      ...hostBase,
      // Trunk ports advertise their native VLAN, access ports their
      // access VLAN — same resolution the snooping agents use.
      getNativeVlan: (p: string) => this.resolveSnoopingVlan(p),
      getVoiceVlan: (p: string) => this.getSwitchportConfig(p)?.voiceVlan,
    }, () => this.getBus());
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    this.dtpAgent = new DtpAgent({
      ...hostBase,
      onOperationalModeChanged: (p, m) => this.applyDtpOperationalMode(p, m),
    }, () => this.getBus());
    const firstPort = this.getPorts()[0];
    const baseMac = firstPort ? firstPort.getMAC().toString() : '00:00:00:00:00:00';
    this.stpAgent = new StpAgent({
      ...hostBase,
      onForwardStateChanged: (p, s, v) => this.applyStpForwardState(p, s, v),
      onStpBpduGuardErrDisable: (p) => this.applyStpBpduGuardErrDisable(p),
      onTopologyChangeAging: (sec) => this._setStpFastAging(sec),
      getStpPortVlans: (p) => this.getStpPortVlans(p),
      isStpTrunkPort: (p) => this._vtpIsTrunkPort(p),
      getStpNativeVlan: (p) => this.getSwitchportConfig(p)?.trunkNativeVlan ?? 1,
      getStpBundleGroup: (p) => this.getStpBundleGroup(p),
    }, () => this.getBus(), baseMac);
    this.lacpAgent = new LacpAgent({
      ...hostBase,
      onLacpBundleChanged: (port, groupId, bundled) =>
        this.stpAgent.onBundleChanged(port, `Port-channel${groupId}`, bundled),
    }, () => this.getBus(), baseMac);
    this.vtpAgent = new VtpAgent({
      ...hostBase,
      vtpListVlans: () => this._vtpListVlans(),
      vtpApplyVlans: (vs) => this._vtpApplyVlans(vs),
      vtpIsTrunkPort: (n) => this._vtpIsTrunkPort(n),
      vtpLocalInterest: () => this._vtpLocalInterest(),
      vtpUpdaterIdentity: () => this._vtpUpdaterIdentity(),
      vtpGetMstRegion: () => {
        const region = this.stpAgent.getMstRegion();
        return { name: region.name, revision: region.revision, instances: [...region.instances] };
      },
      vtpApplyMstRegion: (region) => {
        this.stpAgent.applyMstRegion(region.name, region.revision, region.instances);
      },
    }, () => this.getBus(), baseMac);
    this.udldAgent = new UdldAgent({
      ...hostBase,
      onUdldErrDisable: (p: string) => this.applyUdldErrDisable(p),
    }, () => this.getBus());
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
    this.syslogAgent = new SyslogAgent(hostBase, () => this.getBus());
    this.dot1xAgent = new Dot1xAgent({
      ...hostBase,
      onDot1xPortAuthorized: (p, authorized) => this.applyDot1xAuth(p, authorized),
    }, () => this.getBus());
    this.agents.registerAll(
      this.cdpAgent, this.lldpAgent, this.dtpAgent, this.stpAgent,
      this.lacpAgent, this.vtpAgent, this.udldAgent,
      this.igmpSnoopingAgent, this.pimSnoopingAgent, this.syslogAgent, this.dot1xAgent,
    );
    this.agents.startAll();
  }

  /**
   * React to an 802.1X authorization change. When a port loses
   * authorization, purge the MAC addresses it learned while authorized so a
   * newly-blocked device cannot keep being reached through stale dynamic
   * entries (real switches flush the port on de-authorization). Ingress
   * enforcement itself is done by `isPortAuthorized` in handleFrame.
   */
  private applyDot1xAuth(portName: string, authorized: boolean): void {
    if (!authorized) this.flushDynamicMacsOnPort(portName, 'dot1x-unauthorized');
  }

  private applyUdldErrDisable(portName: string): void {
    const p = this.getPort(portName);
    if (p) p.setUp(false);
  }

  private applyDtpOperationalMode(portName: string, mode: DtpOperationalMode): void {
    const cfg = this.getSwitchportConfig(portName);
    if (!cfg) return;
    if (cfg.mode === mode) return;
    this.syncSwitchportMode(portName, mode);
  }

  protected override syncSwitchportMode(portName: string, mode: SwitchportMode): boolean {
    const ok = super.syncSwitchportMode(portName, mode);
    if (ok && mode === 'trunk') this.vtpAgent?.onTrunkModeChanged(portName);
    return ok;
  }

  protected override isReservedVlanId(id: number): boolean {
    return id >= 1002 && id <= 1005;
  }

  private applyStpForwardState(portName: string, state: StpForwardState, vlan: number): void {
    this.setStpVlanState(portName, vlan, state);
  }

  /**
   * The Port-channel a port is currently bundled into, if any. Only ports
   * LACP has actually brought up count: a member still negotiating is not
   * part of the aggregate yet and keeps running STP on its own.
   */
  private getStpBundleGroup(portName: string): { groupKey: string; members: string[] } | undefined {
    const info = this.lacpAgent.getPortInfo(portName);
    if (!info || !info.bundled) return undefined;
    const members = this.lacpAgent.getGroupMembers(info.groupId)
      .filter(p => p.bundled)
      .map(p => p.portName)
      .sort();
    if (members.length === 0) return undefined;
    return { groupKey: `Port-channel${info.groupId}`, members };
  }

  /**
   * `errdisable recovery cause bpduguard`. A port BPDU Guard shut has to be
   * able to come back on its own like every other err-disable cause, and
   * the log has to say which cause it was — a bare port-down tells the
   * operator nothing.
   */
  private readonly bpduGuardErrDisabled = new Map<string, number>();
  private bpduGuardRecoverySec = 0;
  private bpduGuardRecoveryTimer: TimerHandle | null = null;

  private applyStpBpduGuardErrDisable(portName: string): void {
    const p = this.getPort(portName);
    if (p) p.setUp(false);
    this.setSTPState(portName, 'disabled');
    this.bpduGuardErrDisabled.set(portName, this.stpAgent.nowMs());
    Logger.warn(this.id, 'stp:bpduguard',
      `${this.name}: bpduguard error detected on ${portName}, putting ${portName} in err-disable state`);
    this.getBus().publish({
      topic: 'stp.errdisable.changed',
      payload: {
        deviceId: this.id, hostname: this.getHostname(),
        port: portName, cause: 'bpduguard', state: 'err-disabled',
      },
    });
    this.ensureBpduGuardRecoveryTimer();
  }

  _getBpduGuardRecoverySec(): number { return this.bpduGuardRecoverySec; }

  _setBpduGuardRecoverySec(sec: number): void {
    this.bpduGuardRecoverySec = Math.max(0, sec);
    if (this.bpduGuardRecoverySec > 0) this.ensureBpduGuardRecoveryTimer();
    else this.stopBpduGuardRecoveryTimer();
  }

  _getBpduGuardErrDisabledPorts(): Set<string> {
    return new Set(this.bpduGuardErrDisabled.keys());
  }

  _clearBpduGuardErrDisable(portName: string): boolean {
    if (!this.bpduGuardErrDisabled.delete(portName)) return false;
    const p = this.getPort(portName);
    if (p) p.setUp(true);
    Logger.warn(this.id, 'pm:err-recover',
      `Attempting to recover from bpduguard err-disable state on ${portName}`);
    this.getBus().publish({
      topic: 'stp.errdisable.changed',
      payload: {
        deviceId: this.id, hostname: this.getHostname(),
        port: portName, cause: 'bpduguard', state: 'recovered',
      },
    });
    if (this.bpduGuardErrDisabled.size === 0) this.stopBpduGuardRecoveryTimer();
    return true;
  }

  private ensureBpduGuardRecoveryTimer(): void {
    if (this.bpduGuardRecoveryTimer !== null) return;
    if (this.bpduGuardRecoverySec <= 0 || this.bpduGuardErrDisabled.size === 0) return;
    this.bpduGuardRecoveryTimer = this.getScheduler()
      .setInterval(() => this.recoverBpduGuardErrDisabled(), 1000);
  }

  private stopBpduGuardRecoveryTimer(): void {
    if (this.bpduGuardRecoveryTimer === null) return;
    this.getScheduler().clear(this.bpduGuardRecoveryTimer);
    this.bpduGuardRecoveryTimer = null;
  }

  private recoverBpduGuardErrDisabled(): void {
    if (this.bpduGuardRecoverySec <= 0 || this.bpduGuardErrDisabled.size === 0) {
      this.stopBpduGuardRecoveryTimer();
      return;
    }
    const now = this.stpAgent.nowMs();
    for (const [portName, since] of [...this.bpduGuardErrDisabled]) {
      if ((now - since) / 1000 >= this.bpduGuardRecoverySec) {
        this._clearBpduGuardErrDisable(portName);
      }
    }
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    // Re-bind every agent's subscriptions to the newly injected bus.
    // (setEventBus can fire from the base constructor, before the registry
    // field initializer ran — hence the optional chain.)
    this.agents?.restartAll();
    this._debugService?.attachToBus(this.getBus(), this.id, this);
  }

  private _debugService: RouterDebugService | null = null;

  getDebugService(): RouterDebugService {
    if (!this._debugService) this._debugService = new RouterDebugService('switch');
    this._debugService.attachToBus(this.getBus(), this.id, this);
    return this._debugService;
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    if (frame.etherType === ETHERTYPE_CDP) {
      if (this.isL2ProtocolTunneled(portName, 'cdp')) { super.handleFrame(portName, frame); return; }
      this.cdpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_LLDP) {
      if (this.isL2ProtocolTunneled(portName, 'lldp')) { super.handleFrame(portName, frame); return; }
      this.lldpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_DTP) {
      this.dtpAgent.handleFrame(portName, frame);
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
    if (frame.etherType === ETHERTYPE_VTP) {
      if (this.isL2ProtocolTunneled(portName, 'vtp')) { super.handleFrame(portName, frame); return; }
      this.vtpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_UDLD) {
      this.udldAgent.handleFrame(portName, frame);
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

  protected override getVtpAgentOrNull(): VtpAgent {
    return this.vtpAgent;
  }

  getDtpAgent(): DtpAgent { return this.dtpAgent; }
  getStpAgent(): StpAgent { return this.stpAgent; }
  getLacpAgent(): LacpAgent { return this.lacpAgent; }
  getVtpAgent(): VtpAgent { return this.vtpAgent; }
  getUdldAgent(): UdldAgent { return this.udldAgent; }
  getIgmpSnoopingAgent(): IgmpSnoopingAgent { return this.igmpSnoopingAgent; }
  getPimSnoopingAgent(): PimSnoopingAgent { return this.pimSnoopingAgent; }
  getSyslogAgent(): SyslogAgent { return this.syslogAgent; }
  getDot1xAgent(): Dot1xAgent { return this.dot1xAgent; }

  override setSwitchportMode(portName: string, mode: SwitchportMode): boolean {
    const r = super.setSwitchportMode(portName, mode);
    if (r) this.dtpAgent.setAdminMode(portName, mode === 'trunk' ? 'trunk' : 'access');
    return r;
  }

  getCdpAgent(): CdpAgent { return this.cdpAgent; }
  getCdpNeighbors(): NeighborDTO[] { return cdpToNeighborDTO(this.cdpAgent.getNeighbors()); }
  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }

  // ─── Vendor Hooks ──────────────────────────────────────────────

  protected getPortName(index: number, total: number): string {
    // Real Catalyst interfaces are 1-indexed: a 24-port switch is
    // FastEthernet0/1…0/24 with GigabitEthernet0/1… uplinks — there is no
    // FastEthernet0/0.
    return index < 24
      ? `FastEthernet0/${index + 1}`
      : `GigabitEthernet0/${index - 23}`;
  }

  protected getInitialSTPState(): STPPortState {
    // Cisco PortFast: ports start forwarding immediately
    return 'forwarding';
  }

  protected createShell(): ISwitchShell {
    return new CiscoSwitchShell();
  }

  /**
   * Cisco VLAN deletion behavior:
   * Access ports assigned to a deleted VLAN become suspended/inactive.
   * They remain assigned to the (now non-existent) VLAN but stop forwarding
   * traffic. This is the documented Cisco IOS/Catalyst behavior.
   */
  protected onVlanDeleted(vlanId: number, affectedPorts: string[]): void {
    for (const portName of affectedPorts) {
      this.portVlanStates.set(portName, 'suspended');
    }
  }

  /**
   * Cisco VLAN recreation behavior:
   * When a VLAN is recreated, any ports that were suspended because
   * they were assigned to that VLAN are reactivated automatically.
   */
  protected onVlanRecreated(vlanId: number): string[] {
    const reactivated: string[] = [];
    for (const [portName, cfg] of this._getSwitchportConfigs()) {
      if (cfg.mode === 'access' && cfg.accessVlan === vlanId && this.portVlanStates.get(portName) === 'suspended') {
        this.portVlanStates.set(portName, 'active');
        reactivated.push(portName);
      }
    }
    return reactivated;
  }

  getOSType(): string { return 'cisco-ios'; }

  getBootSequence(): string {
    return [
      '',
      ciscoSoftwareDescriptor(C3560_SOFTWARE),
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      `${this.hostname} processor with 65536K bytes of memory.`,
      `${this.getPortNames().filter(n => n.startsWith('Fast')).length} FastEthernet interfaces`,
      `${this.getPortNames().filter(n => n.startsWith('Gig')).length} Gigabit Ethernet interfaces`,
      '',
      `Base ethernet MAC address: ${this.getPort(this.getPortNames()[0])?.getMAC().toCiscoString() ?? '0000.0000.0000'}`,
      '',
      'Press RETURN to get started.',
    ].join('\n');
  }
}

/** Map CDP neighbour rows to the inspection DTO `showCdp` consumes. */
