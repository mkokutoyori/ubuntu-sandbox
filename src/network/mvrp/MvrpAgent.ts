import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import { MACAddress, type EthernetFrame } from '../core/types';
import type { LinkSendRequest } from '../layers/link/LinkLayer';
import type { Port } from '../hardware/Port';
import { MRP_TIMERS_CENTISECONDS, LeaveAllMachine, leaveAllInterval } from '../mrp/MrpLeaveAll';
import {
  ApplicantMachine, attributeEventFor, DEFAULT_PARTICIPATION,
  type ApplicantEvent, type ApplicantParticipation,
} from '../mrp/MrpApplicant';
import {
  RegistrarMachine, type RegistrarAdminControl, type RegistrarEvent, type RegistrarOutcome,
} from '../mrp/MrpRegistrar';
import type { AttributeEvent } from '../mrp/MrpPdu';
import {
  MVRP_CUSTOMER_ADDRESS, MVRP_ETHERTYPE, MVRP_MAX_VID, MVRP_PROVIDER_ADDRESS,
  decodeMvrp, encodeMvrp, type MvrpDeclaration,
} from './MvrpPdu';

export interface MvrpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): Port | undefined;
  sendOnLink(request: LinkSendRequest): boolean;
  portForwarding?(portName: string): boolean;
  pvidOf?(portName: string): number;
  fixedRegistrations?(portName: string): ReadonlySet<number>;
  onVlanRegistered(portName: string, vid: number, isNew: boolean): void;
  onVlanDeregistered(portName: string, vid: number): void;
}

export type MvrpComponent = 'c-vlan' | 's-vlan';

export interface MvrpPortConfig {
  enabled: boolean;
  registration: RegistrarAdminControl;
  participant: ApplicantParticipation['mode'];
  pointToPoint: boolean;
}

export interface MvrpPortStats {
  pdusSent: number;
  pdusReceived: number;
  pdusDiscarded: number;
  newReceived: number;
  joinReceived: number;
  leaveReceived: number;
  leaveAllReceived: number;
  registrationFailures: number;
}

interface PortRuntime {
  config: MvrpPortConfig;
  applicants: Map<number, ApplicantMachine>;
  registrars: Map<number, RegistrarMachine>;
  declared: Set<number>;
  pendingNew: Set<number>;
  leaveAll: LeaveAllMachine;
  leaveTimers: Map<number, symbol>;
  stats: MvrpPortStats;
  joinTimer?: symbol;
  leaveAllTimer?: symbol;
}

const EVENT_TO_APPLICANT: Readonly<Record<AttributeEvent, ApplicantEvent>> = Object.freeze({
  new: 'rNew', joinIn: 'rJoinIn', in: 'rIn', joinMt: 'rJoinMt', mt: 'rMt', lv: 'rLv',
});

const EVENT_TO_REGISTRAR: Readonly<Partial<Record<AttributeEvent, RegistrarEvent>>> = Object.freeze({
  new: 'rNew', joinIn: 'rJoinIn', joinMt: 'rJoinMt', lv: 'rLv',
});

function emptyStats(): MvrpPortStats {
  return {
    pdusSent: 0, pdusReceived: 0, pdusDiscarded: 0, newReceived: 0, joinReceived: 0,
    leaveReceived: 0, leaveAllReceived: 0, registrationFailures: 0,
  };
}

export class MvrpAgent extends ReactiveAgentBase {
  private globallyEnabled = false;
  private component: MvrpComponent = 'c-vlan';
  private timers = { ...MRP_TIMERS_CENTISECONDS };
  private readonly ports = new Map<string, PortRuntime>();
  private readonly local = new Set<number>();
  private readonly ownTimers = new TimerSet(() => this.getScheduler());
  private random: () => number = Math.random;

  constructor(
    private readonly host: MvrpHost,
    getBus: () => IEventBus,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
  }

  protected isEnabled(): boolean { return this.globallyEnabled; }

  protected armTimers(): void {
    for (const [name, runtime] of this.ports) {
      if (runtime.config.enabled) this.startLeaveAllTimer(name, runtime);
    }
  }

  protected override stopTimers(): void {
    super.stopTimers();
    this.ownTimers.clearAll();
  }

  setRandom(random: () => number): void { this.random = random; }

  setComponent(component: MvrpComponent): void { this.component = component; }

  setTimers(timers: Partial<typeof MRP_TIMERS_CENTISECONDS>): void {
    this.timers = { ...this.timers, ...timers };
  }

  setEnabled(enabled: boolean): void {
    if (this.globallyEnabled === enabled) return;
    this.globallyEnabled = enabled;
    if (!enabled) {
      for (const [name, runtime] of [...this.ports]) if (runtime.config.enabled) this.dropPort(name, runtime);
      return;
    }
    for (const [name, runtime] of this.ports) if (runtime.config.enabled) this.beginPort(name, runtime);
  }

  isGloballyEnabled(): boolean { return this.globallyEnabled; }

  configurePort(portName: string, patch: Partial<MvrpPortConfig>): void {
    const runtime = this.runtimeOf(portName);
    const wasEnabled = runtime.config.enabled && this.globallyEnabled;
    runtime.config = { ...runtime.config, ...patch };
    const isEnabled = runtime.config.enabled && this.globallyEnabled;
    if (!wasEnabled && isEnabled) this.beginPort(portName, runtime);
    else if (wasEnabled && !isEnabled) this.dropPort(portName, runtime);
    else if (isEnabled) this.rebuildMachines(portName, runtime);
  }

  getPortConfig(portName: string): Readonly<MvrpPortConfig> { return this.runtimeOf(portName).config; }

  getStats(portName: string): Readonly<MvrpPortStats> { return this.runtimeOf(portName).stats; }

  registeredVids(portName: string): number[] {
    const runtime = this.ports.get(portName);
    if (!runtime) return [];
    return [...runtime.registrars].filter(([, r]) => r.isRegistered).map(([vid]) => vid).sort((a, b) => a - b);
  }

  declaredVids(portName: string): number[] {
    return [...(this.ports.get(portName)?.declared ?? [])].sort((a, b) => a - b);
  }

  registerVlanMember(vid: number): void {
    if (vid < 1 || vid > MVRP_MAX_VID) return;
    this.local.add(vid);
    this.reconcile(vid, true);
  }

  deregisterVlanMember(vid: number): void {
    if (!this.local.delete(vid)) return;
    this.reconcile(vid, false);
  }

  refreshFixedRegistrations(): void {
    const vids = new Set<number>(this.local);
    for (const [name, runtime] of this.ports) {
      for (const vid of runtime.registrars.keys()) vids.add(vid);
      for (const vid of this.host.fixedRegistrations?.(name) ?? []) vids.add(vid);
    }
    for (const vid of vids) this.reconcile(vid, false);
  }

  onPortForwardingChanged(portName: string): void {
    const runtime = this.ports.get(portName);
    if (!runtime || !this.active(runtime)) return;
    const forwarding = this.host.portForwarding?.(portName) ?? true;
    const vids = new Set<number>(this.local);
    for (const other of this.ports.values()) for (const vid of other.registrars.keys()) vids.add(vid);
    if (!forwarding) {
      for (const [vid, registrar] of runtime.registrars) {
        const outcome = registrar.handle('Flush');
        this.applyRegistrarOutcome(portName, runtime, vid, outcome);
      }
    }
    for (const vid of vids) this.reconcile(vid, false);
  }

  handleFrame(portName: string, frame: EthernetFrame): boolean {
    if (frame.etherType !== MVRP_ETHERTYPE) return false;
    const runtime = this.ports.get(portName);
    if (!runtime || !this.active(runtime)) return false;
    if (frame.dstMAC.toString().toLowerCase() !== this.address()) return false;

    const payload = frame.payload;
    const decoded = payload instanceof Uint8Array ? decodeMvrp(payload) : { ok: false, error: 'not an MRPDU' };
    if (!decoded.ok || decoded.declarations === undefined) {
      runtime.stats.pdusDiscarded++;
      this.getBus().publish({
        topic: 'mvrp.pdu.discarded',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), port: portName, reason: decoded.error ?? 'malformed' },
      });
      return true;
    }
    runtime.stats.pdusReceived++;
    this.getBus().publish({
      topic: 'mvrp.pdu.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(), port: portName,
        leaveAll: decoded.leaveAll === true, declarations: decoded.declarations.length,
      },
    });

    if (decoded.leaveAll === true) this.receiveLeaveAll(portName, runtime);
    for (const declaration of decoded.declarations) this.receiveDeclaration(portName, runtime, declaration);
    return true;
  }

  private address(): string {
    return this.component === 'c-vlan' ? MVRP_CUSTOMER_ADDRESS : MVRP_PROVIDER_ADDRESS;
  }

  private active(runtime: PortRuntime): boolean {
    return this.globallyEnabled && runtime.config.enabled;
  }

  private runtimeOf(portName: string): PortRuntime {
    let runtime = this.ports.get(portName);
    if (!runtime) {
      runtime = {
        config: { enabled: false, registration: 'normal', participant: 'normal', pointToPoint: true },
        applicants: new Map(), registrars: new Map(), declared: new Set(), pendingNew: new Set(),
        leaveAll: new LeaveAllMachine(), leaveTimers: new Map(), stats: emptyStats(),
      };
      this.ports.set(portName, runtime);
    }
    return runtime;
  }

  private participation(runtime: PortRuntime): ApplicantParticipation {
    return { ...DEFAULT_PARTICIPATION, pointToPoint: runtime.config.pointToPoint, mode: runtime.config.participant };
  }

  private applicantOf(runtime: PortRuntime, vid: number): ApplicantMachine {
    let machine = runtime.applicants.get(vid);
    if (!machine) {
      machine = new ApplicantMachine(this.participation(runtime));
      machine.handle('Begin', false);
      runtime.applicants.set(vid, machine);
    }
    return machine;
  }

  private registrarOf(runtime: PortRuntime, vid: number): RegistrarMachine {
    let machine = runtime.registrars.get(vid);
    if (!machine) {
      machine = new RegistrarMachine(runtime.config.registration, runtime.config.pointToPoint);
      runtime.registrars.set(vid, machine);
    }
    return machine;
  }

  private rebuildMachines(portName: string, runtime: PortRuntime): void {
    const previous = [...runtime.registrars.keys()];
    runtime.applicants.clear();
    runtime.registrars.clear();
    runtime.declared.clear();
    for (const vid of previous) this.registrarOf(runtime, vid);
    this.refreshFixedRegistrations();
    void portName;
  }

  private beginPort(portName: string, runtime: PortRuntime): void {
    runtime.leaveAll.handle('Begin');
    this.startLeaveAllTimer(portName, runtime);
    this.refreshFixedRegistrations();
  }

  private dropPort(portName: string, runtime: PortRuntime): void {
    for (const token of runtime.leaveTimers.values()) this.ownTimers.clear(token);
    runtime.leaveTimers.clear();
    if (runtime.joinTimer) this.ownTimers.clear(runtime.joinTimer);
    if (runtime.leaveAllTimer) this.ownTimers.clear(runtime.leaveAllTimer);
    runtime.joinTimer = undefined;
    runtime.leaveAllTimer = undefined;
    const registered = [...runtime.registrars].filter(([, r]) => r.isRegistered).map(([vid]) => vid);
    runtime.applicants.clear();
    runtime.registrars.clear();
    runtime.declared.clear();
    for (const vid of registered) {
      this.host.onVlanDeregistered(portName, vid);
      this.reconcile(vid, false);
    }
  }

  private startLeaveAllTimer(portName: string, runtime: PortRuntime): void {
    if (runtime.leaveAllTimer) this.ownTimers.clear(runtime.leaveAllTimer);
    if (this.timers.leaveAllTime === 0) return;
    const delayMs = leaveAllInterval(this.timers.leaveAllTime, this.random) * 10;
    runtime.leaveAllTimer = this.ownTimers.setTimeout(() => {
      runtime.leaveAllTimer = undefined;
      if (!this.active(runtime)) return;
      runtime.leaveAll.handle('leavealltimer');
      this.startLeaveAllTimer(portName, runtime);
      this.requestTransmit(portName, runtime);
    }, delayMs);
  }

  private requestTransmit(portName: string, runtime: PortRuntime): void {
    if (runtime.joinTimer || !this.active(runtime)) return;
    const delayMs = runtime.config.pointToPoint
      ? this.timers.joinTime * 10
      : this.random() * this.timers.joinTime * 10;
    runtime.joinTimer = this.ownTimers.setTimeout(() => {
      runtime.joinTimer = undefined;
      this.transmit(portName, runtime);
    }, delayMs);
  }

  private registrarIn(runtime: PortRuntime, vid: number): boolean {
    return runtime.registrars.get(vid)?.state === 'IN';
  }

  private transmit(portName: string, runtime: PortRuntime): void {
    if (!this.active(runtime)) return;
    const leaveAllOutcome = runtime.leaveAll.handle('tx');
    const leaveAll = leaveAllOutcome.sendLeaveAll;
    const declarations: MvrpDeclaration[] = [];
    let again = false;

    for (const [vid, applicant] of [...runtime.applicants]) {
      const registrarIn = this.registrarIn(runtime, vid);
      const outcome = applicant.handle(leaveAll ? 'txLA' : 'tx', registrarIn);
      if (outcome.send !== undefined) declarations.push({ vid, event: attributeEventFor(outcome.send, registrarIn) });
      if (outcome.requestTransmit) again = true;
    }
    if (leaveAll) this.receiveLeaveAll(portName, runtime, true);

    if (leaveAll || declarations.length > 0) {
      const payload = encodeMvrp({ leaveAll, declarations });
      const sent = this.host.sendOnLink({
        iface: portName, destination: new MACAddress(this.address()), etherType: MVRP_ETHERTYPE, payload,
      });
      if (sent) {
        runtime.stats.pdusSent++;
        this.getBus().publish({
          topic: 'mvrp.pdu.sent',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(), port: portName,
            leaveAll, declarations: declarations.length,
          },
        });
      }
    }
    if (again) this.requestTransmit(portName, runtime);
  }

  private receiveLeaveAll(portName: string, runtime: PortRuntime, own = false): void {
    if (!own) {
      runtime.stats.leaveAllReceived++;
      runtime.leaveAll.handle('rLA');
      this.startLeaveAllTimer(portName, runtime);
    }
    for (const [vid, registrar] of [...runtime.registrars]) {
      this.applyRegistrarOutcome(portName, runtime, vid, registrar.handle('rLA'));
    }
    for (const [vid, applicant] of [...runtime.applicants]) {
      const outcome = applicant.handle('rLA', this.registrarIn(runtime, vid));
      if (outcome.requestTransmit) this.requestTransmit(portName, runtime);
    }
  }

  private receiveDeclaration(portName: string, runtime: PortRuntime, declaration: MvrpDeclaration): void {
    const vid = declaration.vid === 0 ? (this.host.pvidOf?.(portName) ?? 1) : declaration.vid;
    if (declaration.event === 'new') runtime.stats.newReceived++;
    else if (declaration.event === 'lv') runtime.stats.leaveReceived++;
    else if (declaration.event === 'joinIn' || declaration.event === 'joinMt') runtime.stats.joinReceived++;

    const registrarEvent = EVENT_TO_REGISTRAR[declaration.event];
    if (registrarEvent !== undefined) {
      const registrar = this.registrarOf(runtime, vid);
      this.applyRegistrarOutcome(portName, runtime, vid, registrar.handle(registrarEvent), declaration.event === 'new');
    }
    const applicant = this.applicantOf(runtime, vid);
    const outcome = applicant.handle(EVENT_TO_APPLICANT[declaration.event], this.registrarIn(runtime, vid));
    if (outcome.requestTransmit) this.requestTransmit(portName, runtime);
  }

  private applyRegistrarOutcome(
    portName: string, runtime: PortRuntime, vid: number, outcome: RegistrarOutcome, isNewMessage = false,
  ): void {
    if (outcome.leavetimer === 'stop') this.clearLeaveTimer(runtime, vid);
    if (outcome.leavetimer === 'start') {
      this.clearLeaveTimer(runtime, vid);
      runtime.leaveTimers.set(vid, this.ownTimers.setTimeout(() => {
        runtime.leaveTimers.delete(vid);
        const registrar = runtime.registrars.get(vid);
        if (registrar && this.active(runtime)) this.applyRegistrarOutcome(portName, runtime, vid, registrar.handle('leavetimer'));
      }, this.timers.leaveTime * 10));
    }
    if (outcome.indication === 'new' || outcome.indication === 'join') {
      this.host.onVlanRegistered(portName, vid, outcome.indication === 'new' || isNewMessage);
      this.getBus().publish({
        topic: 'mvrp.vlan.registered',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), port: portName, vid, isNew: outcome.indication === 'new' },
      });
      this.reconcile(vid, outcome.indication === 'new');
    } else if (outcome.indication === 'lv') {
      this.host.onVlanDeregistered(portName, vid);
      this.getBus().publish({
        topic: 'mvrp.vlan.deregistered',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), port: portName, vid },
      });
      this.reconcile(vid, false);
    }
  }

  private clearLeaveTimer(runtime: PortRuntime, vid: number): void {
    const token = runtime.leaveTimers.get(vid);
    if (token) this.ownTimers.clear(token);
    runtime.leaveTimers.delete(vid);
  }

  private sourcesOf(vid: number, excluded: string): boolean {
    if (this.local.has(vid)) return true;
    for (const [name, runtime] of this.ports) {
      if (name === excluded || !this.active(runtime)) continue;
      if (!(this.host.portForwarding?.(name) ?? true)) continue;
      if (runtime.registrars.get(vid)?.isRegistered === true) return true;
      if (this.host.fixedRegistrations?.(name)?.has(vid) === true) return true;
    }
    return false;
  }

  private reconcile(vid: number, isNew: boolean): void {
    for (const [name, runtime] of this.ports) {
      if (!this.active(runtime)) continue;
      const forwarding = this.host.portForwarding?.(name) ?? true;
      const want = forwarding && this.sourcesOf(vid, name);
      const has = runtime.declared.has(vid);
      if (want && !has) {
        runtime.declared.add(vid);
        const outcome = this.applicantOf(runtime, vid).handle(isNew ? 'New' : 'Join', this.registrarIn(runtime, vid));
        if (outcome.requestTransmit) this.requestTransmit(name, runtime);
      } else if (!want && has) {
        runtime.declared.delete(vid);
        const outcome = this.applicantOf(runtime, vid).handle('Lv', this.registrarIn(runtime, vid));
        if (outcome.requestTransmit) this.requestTransmit(name, runtime);
      }
    }
  }
}
