import { IPAddress } from '@/network/core/types';
import type { IScheduler } from '@/events/Scheduler';
import type { TcpStack } from '@/network/tcp/TcpStack';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import { decodePdu, encodePdu } from './LdpCodec';
import { LdpIdentifier } from './LdpIdentifier';
import {
  LDP_HOLD_TIME_INFINITE, LDP_LINK_HELLO_DEFAULT_HOLD_SECONDS, LDP_PORT, LDP_VERSION, StatusCode,
  type FecElement, type LabelMappingMessage, type LdpMessage,
} from './LdpMessages';
import { LdpSession, type LdpSessionOwner, type LdpSessionParameters } from './LdpSession';

export interface LdpRoute {
  readonly prefix: IPAddress;
  readonly length: number;
  readonly nextHop: IPAddress | null;
  readonly iface: string;
  readonly connected: boolean;
  readonly distance: number;
  readonly metric: number;
}

export interface LdpInterfaceAddress {
  readonly name: string;
  readonly address: IPAddress;
  readonly up: boolean;
}

export interface LdpHost {
  routerId(): IPAddress;
  interfaces(): readonly LdpInterfaceAddress[];
  routes(): readonly LdpRoute[];
  sendHello(iface: string, payload: Uint8Array): void;
  tcp(): TcpStack;
}

export type LdpControlMode = 'independent' | 'ordered';

export interface LdpConfig {
  helloIntervalSeconds: number;
  helloHoldSeconds: number;
  keepAliveSeconds: number;
  controlMode: LdpControlMode;
  maxPduLength: number;
}

export interface LdpAdjacency {
  readonly peer: LdpIdentifier;
  readonly iface: string;
  readonly source: IPAddress;
  readonly transport: IPAddress;
  readonly holdSeconds: number;
  timer: number | null;
}

export interface LdpFec {
  readonly key: string;
  readonly prefix: IPAddress;
  readonly length: number;
}

export interface LdpLocalBinding {
  readonly fec: LdpFec;
  readonly label: MplsLabel;
  readonly egress: boolean;
  readonly revision: number;
}

export interface LdpForwardingRow {
  readonly localLabel: MplsLabel;
  readonly outgoing: MplsLabel | 'none';
  readonly fec: LdpFec;
  readonly iface: string;
  readonly nextHop: IPAddress;
}

const SESSION_RETRY_MS = 2000;
const INIT_BACKOFF_FIRST_MS = 15000;
const INIT_BACKOFF_MAX_MS = 120000;

function fecKey(prefix: IPAddress, length: number): string {
  return `${prefix}/${length}`;
}

function fecOf(element: FecElement): LdpFec | null {
  return element.kind === 'prefix' ? { key: fecKey(element.prefix, element.length), prefix: element.prefix, length: element.length } : null;
}

function networkOf(address: IPAddress, length: number): IPAddress {
  const value = length === 0 ? 0 : (address.toUint32() & (0xffffffff << (32 - length))) >>> 0;
  return IPAddress.fromUint32(value);
}

export class LdpEngine implements LdpSessionOwner {
  readonly config: LdpConfig = {
    helloIntervalSeconds: 5, helloHoldSeconds: LDP_LINK_HELLO_DEFAULT_HOLD_SECONDS, keepAliveSeconds: 180,
    controlMode: 'independent', maxPduLength: 4096,
  };
  private readonly enabledInterfaces = new Set<string>();
  private readonly adjacencyTable = new Map<string, LdpAdjacency>();
  private readonly sessionTable = new Map<string, LdpSession>();
  private readonly pending = new Set<LdpSession>();
  private readonly localBindings = new Map<string, LdpLocalBinding>();
  private readonly received = new Map<string, Map<string, MplsLabel>>();
  private readonly advertised = new Map<string, Map<string, MplsLabel>>();
  private readonly advertisedAddresses = new Map<string, Set<string>>();
  private readonly installedIlm = new Map<number, true>();
  private readonly installedFtn = new Map<string, FecInstall>();
  private readonly retryHandles = new Map<string, number>();
  private readonly backoff = new Map<string, { until: number; delay: number }>();
  private helloTimer: number | null = null;
  private listening = false;
  private messageCounter = 0;
  private configurationSequence = 0;
  private fingerprint = '';
  private revisionCounter = 0;
  private forwardingTable: LdpForwardingRow[] = [];
  routerIdSource: { readonly iface: string; readonly force: boolean } | null = null;

  constructor(
    private readonly host: LdpHost,
    private readonly mpls: MplsEngine,
    private readonly getScheduler: () => IScheduler,
  ) {}

  get localId(): LdpIdentifier {
    return LdpIdentifier.of(this.host.routerId(), 0);
  }

  get parameters(): LdpSessionParameters {
    return {
      keepAliveTimeSeconds: this.config.keepAliveSeconds, advertisementMode: 'unsolicited',
      loopDetection: false, maxPduLength: this.config.maxPduLength,
    };
  }

  nowMs(): number {
    return this.getScheduler().now();
  }

  nextMessageId(): number {
    this.messageCounter = (this.messageCounter + 1) >>> 0;
    return this.messageCounter;
  }

  scheduleTimeout(callback: () => void, delayMs: number): number {
    return this.getScheduler().setTimeout(callback, delayMs);
  }

  cancelTimeout(handle: number): void {
    this.getScheduler().clear(handle);
  }

  enableInterface(iface: string): void {
    this.mpls.enableInterface(iface);
    if (this.enabledInterfaces.has(iface)) return;
    this.enabledInterfaces.add(iface);
    this.configurationSequence++;
    this.start();
    this.sendHelloOn(iface);
    this.reconcile();
  }

  disableInterface(iface: string): void {
    if (!this.enabledInterfaces.delete(iface)) return;
    this.mpls.disableInterface(iface);
    this.configurationSequence++;
    for (const adjacency of [...this.adjacencyTable.values()]) {
      if (adjacency.iface === iface) this.dropAdjacency(adjacency);
    }
    this.reconcile();
  }

  private globallyEnabled = true;

  isGloballyEnabled(): boolean {
    return this.globallyEnabled;
  }

  setGloballyEnabled(enabled: boolean): void {
    if (this.globallyEnabled === enabled) return;
    this.globallyEnabled = enabled;
    if (!enabled) {
      if (this.helloTimer !== null) this.getScheduler().clear(this.helloTimer);
      this.helloTimer = null;
      this.resetSessions();
      for (const adjacency of [...this.adjacencyTable.values()]) this.dropAdjacency(adjacency);
    } else if (this.enabledInterfaces.size > 0) {
      this.start();
      for (const iface of this.enabledInterfaces) this.sendHelloOn(iface);
    }
    this.reconcile();
  }

  isInterfaceEnabled(iface: string): boolean {
    return this.enabledInterfaces.has(iface);
  }

  private start(): void {
    if (!this.listening) {
      this.listening = true;
      this.host.tcp().listen(LDP_PORT, { onAccept: (socket) => this.accept(socket) });
    }
    if (this.helloTimer === null) {
      this.helloTimer = this.getScheduler().setInterval(() => this.tick(), this.config.helloIntervalSeconds * 1000);
    }
  }

  resetSessions(): void {
    for (const session of [...this.sessionTable.values()]) session.shutdown();
  }

  stop(): void {
    if (this.helloTimer !== null) this.getScheduler().clear(this.helloTimer);
    this.helloTimer = null;
    for (const session of [...this.sessionTable.values()]) session.shutdown();
    for (const adjacency of [...this.adjacencyTable.values()]) this.dropAdjacency(adjacency);
    this.reconcile();
  }

  private tick(): void {
    for (const iface of this.enabledInterfaces) this.sendHelloOn(iface);
    const current = this.routeFingerprint();
    if (current !== this.fingerprint) this.reconcile();
  }

  private routeFingerprint(): string {
    const routes = this.host.routes().map(r => `${r.prefix}/${r.length}>${r.nextHop ?? '-'}@${r.iface}`).sort().join(';');
    const interfaces = this.host.interfaces().map(i => `${i.name}=${i.address}:${i.up}`).sort().join(';');
    return `${routes}|${interfaces}|${this.host.routerId()}`;
  }

  private sendHelloOn(iface: string): void {
    if (!this.globallyEnabled) return;
    const port = this.host.interfaces().find(i => i.name === iface && i.up);
    if (!port) return;
    const bytes = encodePdu({
      version: LDP_VERSION, sender: this.localId,
      messages: [{
        kind: 'hello', id: this.nextMessageId(), holdTimeSeconds: this.config.helloHoldSeconds, targeted: false,
        requestTargetedHellos: false, transportAddress: this.host.routerId(), configurationSequenceNumber: this.configurationSequence,
      }],
    });
    this.host.sendHello(iface, bytes);
  }

  receiveHello(inPort: string, source: IPAddress, payload: Uint8Array): void {
    if (!this.globallyEnabled || !this.enabledInterfaces.has(inPort)) return;
    let pdu;
    try { pdu = decodePdu(payload); } catch { return; }
    if (pdu.sender.equals(this.localId) || !pdu.sender.isPlatformWide()) return;
    for (const message of pdu.messages) {
      if (message.kind !== 'hello' || message.targeted) continue;
      const requested = message.holdTimeSeconds === 0 ? LDP_LINK_HELLO_DEFAULT_HOLD_SECONDS : message.holdTimeSeconds;
      const hold = requested === LDP_HOLD_TIME_INFINITE ? requested : Math.min(requested, this.config.helloHoldSeconds);
      this.refreshAdjacency(pdu.sender, inPort, source, message.transportAddress ?? source, hold);
    }
  }

  private refreshAdjacency(peer: LdpIdentifier, iface: string, source: IPAddress, transport: IPAddress, hold: number): void {
    const key = `${peer}@${iface}`;
    const existing = this.adjacencyTable.get(key);
    if (existing?.timer != null) this.cancelTimeout(existing.timer);
    const adjacency: LdpAdjacency = { peer, iface, source, transport, holdSeconds: hold, timer: null };
    if (hold !== LDP_HOLD_TIME_INFINITE) {
      adjacency.timer = this.scheduleTimeout(() => this.expireAdjacency(key), hold * 1000);
    }
    this.adjacencyTable.set(key, adjacency);
    if (!existing) this.ensureSession(adjacency);
  }

  private expireAdjacency(key: string): void {
    const adjacency = this.adjacencyTable.get(key);
    if (adjacency) this.dropAdjacency(adjacency);
  }

  private dropAdjacency(adjacency: LdpAdjacency): void {
    if (adjacency.timer !== null) this.cancelTimeout(adjacency.timer);
    this.adjacencyTable.delete(`${adjacency.peer}@${adjacency.iface}`);
    const remaining = [...this.adjacencyTable.values()].some(a => a.peer.equals(adjacency.peer));
    if (remaining) return;
    const retry = this.retryHandles.get(adjacency.peer.lsrId.toString());
    if (retry !== undefined) { this.cancelTimeout(retry); this.retryHandles.delete(adjacency.peer.lsrId.toString()); }
    this.sessionTable.get(adjacency.peer.lsrId.toString())?.shutdown();
  }

  hasHelloAdjacency(peer: LdpIdentifier): boolean {
    return [...this.adjacencyTable.values()].some(a => a.peer.equals(peer));
  }

  private ensureSession(adjacency: LdpAdjacency): void {
    const peerKey = adjacency.peer.lsrId.toString();
    if (this.sessionTable.has(peerKey)) return;
    const local = this.host.routerId();
    if (local.toUint32() <= adjacency.transport.toUint32()) return;
    this.connect(adjacency);
  }

  private connect(adjacency: LdpAdjacency): void {
    const peerKey = adjacency.peer.lsrId.toString();
    if (this.sessionTable.has(peerKey) || !this.hasHelloAdjacency(adjacency.peer)) return;
    const wait = this.backoff.get(peerKey);
    const now = this.getScheduler().now();
    if (wait && wait.until > now) {
      this.scheduleRetry(peerKey, adjacency, wait.until - now);
      return;
    }
    const socket = this.host.tcp().connect(adjacency.transport.toString(), LDP_PORT, { localIp: this.host.routerId().toString() });
    if (!socket || socket.state !== 'established') {
      socket?.close();
      this.scheduleRetry(peerKey, adjacency, SESSION_RETRY_MS);
      return;
    }
    const session = new LdpSession(this, socket, 'active', adjacency.peer, adjacency.transport.toString());
    this.sessionTable.set(peerKey, session);
    session.start();
  }

  private scheduleRetry(peerKey: string, adjacency: LdpAdjacency, delayMs: number): void {
    const previous = this.retryHandles.get(peerKey);
    if (previous !== undefined) this.cancelTimeout(previous);
    this.retryHandles.set(peerKey, this.scheduleTimeout(() => {
      this.retryHandles.delete(peerKey);
      this.connect(adjacency);
    }, delayMs));
  }

  private accept(socket: import('@/network/tcp/TcpStack').TcpSocket): void {
    const session = new LdpSession(this, socket, 'passive', null, socket.remoteIp);
    this.pending.add(session);
    session.start();
  }

  sessionOperational(session: LdpSession): void {
    this.pending.delete(session);
    const peerKey = (session.peer as LdpIdentifier).lsrId.toString();
    const existing = this.sessionTable.get(peerKey);
    if (existing && existing !== session && existing.state === 'operational') {
      session.shutdown();
      return;
    }
    this.sessionTable.set(peerKey, session);
    this.backoff.delete(peerKey);
    this.received.set(peerKey, new Map());
    this.advertised.set(peerKey, new Map());
    this.advertisedAddresses.set(peerKey, new Set());
    this.syncAddresses(session, peerKey);
    this.reconcile();
  }

  sessionClosed(session: LdpSession, _reason: string, rejected: boolean): void {
    this.pending.delete(session);
    if (!session.peer) return;
    const peerKey = session.peer.lsrId.toString();
    if (this.sessionTable.get(peerKey) === session) this.sessionTable.delete(peerKey);
    this.received.delete(peerKey);
    this.advertised.delete(peerKey);
    this.advertisedAddresses.delete(peerKey);
    if (rejected && session.role === 'active') {
      const previous = this.backoff.get(peerKey);
      const delay = previous ? Math.min(previous.delay * 2, INIT_BACKOFF_MAX_MS) : INIT_BACKOFF_FIRST_MS;
      this.backoff.set(peerKey, { until: this.getScheduler().now() + delay, delay });
    }
    this.reconcile();
    const adjacency = [...this.adjacencyTable.values()].find(a => a.peer.equals(session.peer as LdpIdentifier));
    if (adjacency) this.ensureSession(adjacency);
  }

  sessionMessage(session: LdpSession, message: LdpMessage): void {
    const peerKey = (session.peer as LdpIdentifier).lsrId.toString();
    switch (message.kind) {
      case 'address':
        for (const address of message.addresses) session.peerAddresses.set(address.toString(), address);
        this.reconcile();
        return;
      case 'address-withdraw':
        for (const address of message.addresses) session.peerAddresses.delete(address.toString());
        this.reconcile();
        return;
      case 'label-mapping':
        this.onMapping(session, peerKey, message);
        return;
      case 'label-request':
        this.onRequest(session, peerKey, message.fec, message.id);
        return;
      case 'label-withdraw':
        this.onWithdraw(session, peerKey, message.fec, message.label, message.id);
        return;
      case 'label-release':
        this.onRelease(peerKey, message.fec, message.label);
        return;
      default:
        return;
    }
  }

  private onMapping(session: LdpSession, peerKey: string, message: LabelMappingMessage): void {
    const table = this.received.get(peerKey);
    if (!table) return;
    for (const element of message.fec) {
      const fec = fecOf(element);
      if (fec) table.set(fec.key, message.label);
    }
    this.reconcile();
    void session;
  }

  private onRequest(session: LdpSession, peerKey: string, fecs: readonly FecElement[], requestId: number): void {
    for (const element of fecs) {
      const fec = fecOf(element);
      if (!fec) continue;
      const binding = this.localBindings.get(fec.key);
      if (!binding) {
        session.send([{
          kind: 'notification', id: this.nextMessageId(), statusCode: StatusCode.NoRoute, forward: false,
          referencedMessageId: requestId, referencedMessageType: 0x0401,
        }]);
        continue;
      }
      this.advertised.get(peerKey)?.set(fec.key, binding.label);
      session.send([{
        kind: 'label-mapping', id: this.nextMessageId(), fec: [element], label: binding.label, requestMessageId: requestId,
      }]);
    }
  }

  private onWithdraw(
    session: LdpSession, peerKey: string, fecs: readonly FecElement[], label: MplsLabel | undefined, withdrawId: number,
  ): void {
    const table = this.received.get(peerKey);
    if (!table) return;
    for (const element of fecs) {
      if (element.kind === 'wildcard') {
        for (const [key, held] of [...table]) if (!label || held.equals(label)) table.delete(key);
        continue;
      }
      const fec = fecOf(element);
      if (!fec) continue;
      const held = table.get(fec.key);
      if (held && (!label || held.equals(label))) table.delete(fec.key);
    }
    session.send([{ kind: 'label-release', id: this.nextMessageId(), fec: [...fecs], ...(label ? { label } : {}) }]);
    void withdrawId;
    this.reconcile();
  }

  private onRelease(peerKey: string, fecs: readonly FecElement[], label: MplsLabel | undefined): void {
    const table = this.advertised.get(peerKey);
    if (!table) return;
    for (const element of fecs) {
      if (element.kind === 'wildcard') {
        for (const [key, held] of [...table]) if (!label || held.equals(label)) table.delete(key);
        continue;
      }
      const fec = fecOf(element);
      if (!fec) continue;
      const held = table.get(fec.key);
      if (held && (!label || held.equals(label))) table.delete(fec.key);
    }
  }

  private syncAddresses(session: LdpSession, peerKey: string): void {
    const sent = this.advertisedAddresses.get(peerKey);
    if (!sent) return;
    const current = new Map(this.host.interfaces().filter(i => i.up).map(i => [i.address.toString(), i.address] as const));
    const added = [...current].filter(([key]) => !sent.has(key)).map(([, address]) => address);
    const removed = [...sent].filter(key => !current.has(key)).map(key => new IPAddress(key));
    if (added.length > 0) session.send([{ kind: 'address', id: this.nextMessageId(), addresses: added }]);
    if (removed.length > 0) session.send([{ kind: 'address-withdraw', id: this.nextMessageId(), addresses: removed }]);
    sent.clear();
    for (const key of current.keys()) sent.add(key);
  }

  private computeFecs(): Map<string, { fec: LdpFec; route: LdpRoute }> {
    const best = new Map<string, { fec: LdpFec; route: LdpRoute }>();
    for (const route of this.host.routes()) {
      if (route.length === 0) continue;
      const prefix = networkOf(route.prefix, route.length);
      const key = fecKey(prefix, route.length);
      const held = best.get(key);
      if (held && (held.route.distance < route.distance || (held.route.distance === route.distance && held.route.metric <= route.metric))) continue;
      best.set(key, { fec: { key, prefix, length: route.length }, route });
    }
    return best;
  }

  private peerOwning(address: IPAddress, iface: string): { key: string; session: LdpSession } | null {
    for (const [key, session] of this.sessionTable) {
      if (session.state !== 'operational' || !session.peerAddresses.has(address.toString())) continue;
      const onInterface = [...this.adjacencyTable.values()].some(a => a.peer.lsrId.toString() === key && a.iface === iface);
      if (onInterface) return { key, session };
    }
    return null;
  }

  reconcile(): void {
    this.fingerprint = this.routeFingerprint();
    const fecs = this.computeFecs();

    for (const [key, binding] of [...this.localBindings]) {
      if (fecs.has(key)) continue;
      this.localBindings.delete(key);
      this.withdrawEverywhere(binding);
      if (!binding.egress) this.mpls.lfib.releaseLabel(binding.label);
    }
    for (const [key, { fec, route }] of fecs) {
      const existing = this.localBindings.get(key);
      const egress = route.connected;
      if (existing && existing.egress === egress) continue;
      if (existing) {
        this.localBindings.delete(key);
        this.withdrawEverywhere(existing);
        if (!existing.egress) this.mpls.lfib.releaseLabel(existing.label);
      }
      this.localBindings.set(key, {
        fec, label: egress ? MplsLabel.IMPLICIT_NULL : this.mpls.lfib.allocateLabel(), egress, revision: ++this.revisionCounter,
      });
    }

    for (const [peerKey, session] of this.sessionTable) {
      if (session.state !== 'operational') continue;
      this.syncAddresses(session, peerKey);
      this.advertiseTo(session, peerKey, fecs);
    }
    this.install(fecs);
  }

  private withdrawEverywhere(binding: LdpLocalBinding): void {
    for (const [peerKey, session] of this.sessionTable) {
      const table = this.advertised.get(peerKey);
      if (session.state !== 'operational' || !table?.has(binding.fec.key)) continue;
      table.delete(binding.fec.key);
      session.send([{
        kind: 'label-withdraw', id: this.nextMessageId(),
        fec: [{ kind: 'prefix', prefix: binding.fec.prefix, length: binding.fec.length }], label: binding.label,
      }]);
    }
  }

  private advertiseTo(
    session: LdpSession, peerKey: string, fecs: ReadonlyMap<string, { fec: LdpFec; route: LdpRoute }>,
  ): void {
    const table = this.advertised.get(peerKey);
    if (!table) return;
    const outgoing: LdpMessage[] = [];
    for (const [key, binding] of this.localBindings) {
      if (table.get(key)?.equals(binding.label)) continue;
      if (this.config.controlMode === 'ordered' && !binding.egress && !this.hasDownstreamLabel(fecs.get(key))) continue;
      table.set(key, binding.label);
      outgoing.push({
        kind: 'label-mapping', id: this.nextMessageId(),
        fec: [{ kind: 'prefix', prefix: binding.fec.prefix, length: binding.fec.length }], label: binding.label,
      });
    }
    if (outgoing.length > 0) session.send(outgoing);
    for (const [key, label] of [...table]) {
      if (this.localBindings.has(key)) continue;
      table.delete(key);
      const fec = fecs.get(key)?.fec;
      if (!fec) continue;
      session.send([{ kind: 'label-withdraw', id: this.nextMessageId(), fec: [{ kind: 'prefix', prefix: fec.prefix, length: fec.length }], label }]);
    }
  }

  private hasDownstreamLabel(entry: { fec: LdpFec; route: LdpRoute } | undefined): boolean {
    if (!entry?.route.nextHop) return false;
    const owner = this.peerOwning(entry.route.nextHop, entry.route.iface);
    return owner !== null && this.received.get(owner.key)?.has(entry.fec.key) === true;
  }

  private install(fecs: ReadonlyMap<string, { fec: LdpFec; route: LdpRoute }>): void {
    const wantedIlm = new Map<number, true>();
    const wantedFtn = new Map<string, FecInstall>();
    const rows: LdpForwardingRow[] = [];
    for (const [key, { fec, route }] of fecs) {
      const binding = this.localBindings.get(key);
      if (!binding || binding.egress || !route.nextHop) continue;
      if (!this.enabledInterfaces.has(route.iface)) continue;
      const owner = this.peerOwning(route.nextHop, route.iface);
      const remote = owner ? this.received.get(owner.key)?.get(key) : undefined;
      rows.push({ localLabel: binding.label, outgoing: remote ?? 'none', fec, iface: route.iface, nextHop: route.nextHop });
      if (!remote) continue;
      if (remote.isImplicitNull()) {
        this.mpls.lfib.setIlm(binding.label, { kind: 'pop', iface: route.iface, nextHop: route.nextHop });
        wantedIlm.set(binding.label.value, true);
        this.mpls.lfib.setFtn({ prefix: fec.prefix, prefixLength: fec.length, outLabels: [], iface: route.iface, nextHop: route.nextHop });
        wantedFtn.set(key, { prefix: fec.prefix, length: fec.length });
        continue;
      }
      this.mpls.lfib.setIlm(binding.label, { kind: 'swap', outLabels: [remote], iface: route.iface, nextHop: route.nextHop });
      wantedIlm.set(binding.label.value, true);
      this.mpls.lfib.setFtn({ prefix: fec.prefix, prefixLength: fec.length, outLabels: [remote], iface: route.iface, nextHop: route.nextHop });
      wantedFtn.set(key, { prefix: fec.prefix, length: fec.length });
    }
    for (const value of [...this.installedIlm.keys()]) {
      if (!wantedIlm.has(value)) this.mpls.lfib.removeIlm(MplsLabel.of(value));
    }
    for (const [key, entry] of [...this.installedFtn]) {
      if (!wantedFtn.has(key)) this.mpls.lfib.removeFtn(entry.prefix, entry.length);
    }
    this.forwardingTable = rows;
    this.installedIlm.clear();
    for (const [value] of wantedIlm) this.installedIlm.set(value, true);
    this.installedFtn.clear();
    for (const [key, entry] of wantedFtn) this.installedFtn.set(key, entry);
  }

  receiveUdp(inPort: string, source: IPAddress, payload: unknown): void {
    if (payload instanceof Uint8Array) this.receiveHello(inPort, source, payload);
  }

  forwardingRows(): readonly LdpForwardingRow[] {
    return this.forwardingTable;
  }

  setHelloTimers(intervalSeconds: number | null, holdSeconds: number | null): void {
    if (intervalSeconds !== null) this.config.helloIntervalSeconds = intervalSeconds;
    if (holdSeconds !== null) this.config.helloHoldSeconds = holdSeconds;
    if (this.helloTimer !== null) {
      this.getScheduler().clear(this.helloTimer);
      this.helloTimer = this.getScheduler().setInterval(() => this.tick(), this.config.helloIntervalSeconds * 1000);
    }
    for (const iface of this.enabledInterfaces) this.sendHelloOn(iface);
  }

  adjacencies(): readonly LdpAdjacency[] {
    return [...this.adjacencyTable.values()];
  }

  sessions(): readonly LdpSession[] {
    return [...this.sessionTable.values()];
  }

  bindings(): readonly LdpLocalBinding[] {
    return [...this.localBindings.values()];
  }

  remoteBindings(peer: LdpIdentifier): ReadonlyMap<string, MplsLabel> {
    return this.received.get(peer.lsrId.toString()) ?? new Map();
  }
}

interface FecInstall {
  readonly prefix: IPAddress;
  readonly length: number;
}
