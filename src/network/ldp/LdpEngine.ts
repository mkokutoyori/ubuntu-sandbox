import { IPAddress } from '@/network/core/types';
import type { IScheduler } from '@/events/Scheduler';
import type { TcpStack } from '@/network/tcp/TcpStack';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import { decodePdu, encodePdu } from './LdpCodec';
import { LdpIdentifier } from './LdpIdentifier';
import {
  LDP_HOLD_TIME_INFINITE, LDP_LINK_HELLO_DEFAULT_HOLD_SECONDS, LDP_TARGETED_HELLO_DEFAULT_HOLD_SECONDS, LDP_EGRESS_LSP_MTU, LDP_LABEL_BYTES, LDP_PORT, LDP_VERSION, StatusCode,
  type FecElement, type LabelMappingMessage, MessageType, type LdpMessage, type PwFec, isPwFec,
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
  readonly mtu: number;
}

export interface LdpHost {
  routerId(): IPAddress;
  interfaces(): readonly LdpInterfaceAddress[];
  routes(): readonly LdpRoute[];
  sendHello(iface: string, payload: Uint8Array): void;
  sendTargetedHello(destination: IPAddress, payload: Uint8Array): boolean;
  tcp(): TcpStack;
}

export interface LdpPwHandler {
  sessionOperational(peer: LdpIdentifier): void;
  sessionClosed(peer: LdpIdentifier): void;
  mapping(peer: LdpIdentifier, fec: PwFec, label: MplsLabel, pwStatus: number | undefined): void;
  withdraw(peer: LdpIdentifier, fec: PwFec, label: MplsLabel | undefined, status: number | undefined): void;
  release(peer: LdpIdentifier, fec: PwFec, label: MplsLabel | undefined, status: number | undefined): void;
  notification(peer: LdpIdentifier, fec: PwFec, pwStatus: number): void;
  macWithdraw(peer: LdpIdentifier, fec: PwFec, macs: readonly (readonly number[])[]): void;
}

export type LdpControlMode = 'independent' | 'ordered';

export interface LdpConfig {
  helloIntervalSeconds: number;
  helloHoldSeconds: number;
  keepAliveSeconds: number;
  controlMode: LdpControlMode;
  maxPduLength: number;
  targetedHelloIntervalSeconds: number;
  targetedHelloHoldSeconds: number;
  acceptTargetedHellos: boolean;
  loopDetection: boolean;
  pathVectorLimit: number;
  maxHopCount: number;
  advertisementMode: 'unsolicited' | 'on-demand';
  noRouteRetrySeconds: number;
}

interface LabelRequestRecord {
  readonly id: number;
  readonly element: FecElement;
}

interface LoopAttributes {
  readonly hopCount: number;
  readonly pathVector: readonly IPAddress[];
}

export interface LdpAdjacency {
  readonly peer: LdpIdentifier;
  readonly iface: string;
  readonly source: IPAddress;
  readonly transport: IPAddress;
  readonly holdSeconds: number;
  readonly proposedHoldSeconds: number;
  readonly targeted: boolean;
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
    targetedHelloIntervalSeconds: 15, targetedHelloHoldSeconds: LDP_TARGETED_HELLO_DEFAULT_HOLD_SECONDS, acceptTargetedHellos: false,
    loopDetection: false, pathVectorLimit: 16, maxHopCount: 255,
    advertisementMode: 'unsolicited', noRouteRetrySeconds: 60,
  };
  private readonly enabledInterfaces = new Set<string>();
  private readonly adjacencyTable = new Map<string, LdpAdjacency>();
  private readonly sessionTable = new Map<string, LdpSession>();
  private readonly pending = new Set<LdpSession>();
  private readonly localBindings = new Map<string, LdpLocalBinding>();
  private readonly received = new Map<string, Map<string, MplsLabel>>();
  private readonly advertised = new Map<string, Map<string, MplsLabel>>();
  private readonly advertisedAddresses = new Map<string, Set<string>>();
  private readonly receivedElc = new Map<string, Set<string>>();
  private readonly advertisedElc = new Map<string, Set<string>>();
  private readonly receivedMtu = new Map<string, Map<string, number>>();
  private readonly advertisedMtu = new Map<string, Map<string, number>>();
  private readonly receivedLoop = new Map<string, Map<string, LoopAttributes>>();
  private readonly advertisedLoop = new Map<string, Map<string, string>>();
  private sessionUidCounter = 0;
  private readonly peerIndexes = new Map<string, number>();
  private readonly outstandingRequests = new Map<string, Map<string, LabelRequestRecord>>();
  private readonly pendingRequests = new Map<string, Map<string, LabelRequestRecord>>();
  private readonly noRouteAt = new Map<string, number>();
  private readonly installedIlm = new Map<number, true>();
  private readonly installedFtn = new Map<string, FecInstall>();
  private readonly retryHandles = new Map<string, number>();
  private readonly backoff = new Map<string, { until: number; delay: number }>();
  private readonly targetedPeers = new Map<string, { readonly address: IPAddress; readonly configured: boolean }>();
  private readonly targetedNextSendMs = new Map<string, number>();
  private readonly pwHandlers: LdpPwHandler[] = [];
  loopsDetected = 0;
  loopsReported = 0;
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
      keepAliveTimeSeconds: this.config.keepAliveSeconds, advertisementMode: this.config.advertisementMode,
      loopDetection: this.config.loopDetection, pathVectorLimit: this.config.pathVectorLimit, maxPduLength: this.config.maxPduLength,
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
    this.sendTargetedHellos();
    const current = this.routeFingerprint();
    if (current !== this.fingerprint || this.noRouteRetryDue()) this.reconcile();
  }

  private routeFingerprint(): string {
    const routes = this.host.routes().map(r => `${r.prefix}/${r.length}>${r.nextHop ?? '-'}@${r.iface}`).sort().join(';');
    const interfaces = this.host.interfaces().map(i => `${i.name}=${i.address}:${i.up}:${i.mtu}`).sort().join(';');
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
    if (!this.globallyEnabled) return;
    let pdu;
    try { pdu = decodePdu(payload); } catch { return; }
    if (pdu.sender.equals(this.localId) || !pdu.sender.isPlatformWide()) return;
    for (const message of pdu.messages) {
      if (message.kind !== 'hello') continue;
      const transport = message.transportAddress ?? source;
      if (message.targeted) {
        this.receiveTargetedHello(pdu.sender, source, transport, message);
        continue;
      }
      if (!this.enabledInterfaces.has(inPort)) continue;
      const requested = message.holdTimeSeconds === 0 ? LDP_LINK_HELLO_DEFAULT_HOLD_SECONDS : message.holdTimeSeconds;
      const hold = requested === LDP_HOLD_TIME_INFINITE ? requested : Math.min(requested, this.config.helloHoldSeconds);
      this.refreshAdjacency(pdu.sender, inPort, source, transport, hold, false, requested);
    }
  }

  private receiveTargetedHello(
    peer: LdpIdentifier, source: IPAddress, transport: IPAddress,
    message: { readonly holdTimeSeconds: number; readonly requestTargetedHellos: boolean },
  ): void {
    const configured = this.targetedPeers.get(source.toString());
    if (configured === undefined && !this.config.acceptTargetedHellos) return;
    const requested = message.holdTimeSeconds === 0 ? LDP_TARGETED_HELLO_DEFAULT_HOLD_SECONDS : message.holdTimeSeconds;
    const hold = requested === LDP_HOLD_TIME_INFINITE ? requested : Math.min(requested, this.config.targetedHelloHoldSeconds);
    this.refreshAdjacency(peer, `targeted:${source}`, source, transport, hold, true, requested);
    if (message.requestTargetedHellos && configured === undefined) {
      this.targetedPeers.set(source.toString(), { address: source, configured: false });
      this.start();
      this.sendTargetedHello(source, false);
    }
  }

  addTargetedPeer(address: IPAddress): void {
    const existing = this.targetedPeers.get(address.toString());
    if (existing?.configured) return;
    this.targetedPeers.set(address.toString(), { address, configured: true });
    this.configurationSequence++;
    this.start();
    this.sendTargetedHello(address, true);
  }

  removeTargetedPeer(address: IPAddress): void {
    if (!this.targetedPeers.delete(address.toString())) return;
    this.configurationSequence++;
    for (const adjacency of [...this.adjacencyTable.values()]) {
      if (adjacency.targeted && adjacency.source.equals(address)) this.dropAdjacency(adjacency);
    }
    this.reconcile();
  }

  setEntropyLabelCapable(enabled: boolean): void {
    this.mpls.entropyLabelCapable = enabled;
    this.reconcile();
  }

  setAcceptTargetedHellos(accept: boolean): void {
    this.config.acceptTargetedHellos = accept;
    if (accept) { this.start(); return; }
    for (const adjacency of [...this.adjacencyTable.values()]) {
      const entry = this.targetedPeers.get(adjacency.source.toString());
      if (adjacency.targeted && (entry === undefined || !entry.configured)) {
        this.targetedPeers.delete(adjacency.source.toString());
        this.dropAdjacency(adjacency);
      }
    }
    this.reconcile();
  }

  targetedAddresses(): readonly IPAddress[] {
    return [...this.targetedPeers.values()].map(entry => entry.address);
  }

  configuredTargets(): readonly IPAddress[] {
    return [...this.targetedPeers.values()].filter(entry => entry.configured).map(entry => entry.address);
  }

  private sendTargetedHellos(): void {
    if (!this.globallyEnabled) return;
    const now = this.nowMs();
    for (const entry of this.targetedPeers.values()) {
      const key = entry.address.toString();
      if ((this.targetedNextSendMs.get(key) ?? 0) > now) continue;
      this.sendTargetedHello(entry.address, entry.configured);
    }
  }

  private sendTargetedHello(destination: IPAddress, requestReply: boolean): void {
    if (!this.globallyEnabled) return;
    const bytes = encodePdu({
      version: LDP_VERSION, sender: this.localId,
      messages: [{
        kind: 'hello', id: this.nextMessageId(), holdTimeSeconds: this.config.targetedHelloHoldSeconds, targeted: true,
        requestTargetedHellos: requestReply, transportAddress: this.host.routerId(), configurationSequenceNumber: this.configurationSequence,
      }],
    });
    this.host.sendTargetedHello(destination, bytes);
    this.targetedNextSendMs.set(destination.toString(), this.nowMs() + this.config.targetedHelloIntervalSeconds * 1000);
  }

  private refreshAdjacency(peer: LdpIdentifier, iface: string, source: IPAddress, transport: IPAddress, hold: number, targeted: boolean, proposed: number): void {
    const key = `${peer}@${iface}`;
    const existing = this.adjacencyTable.get(key);
    if (existing?.timer != null) this.cancelTimeout(existing.timer);
    const adjacency: LdpAdjacency = { peer, iface, source, transport, holdSeconds: hold, proposedHoldSeconds: proposed, targeted, timer: null };
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
    session.uid = ++this.sessionUidCounter;
    if (!this.peerIndexes.has(peerKey)) this.peerIndexes.set(peerKey, this.peerIndexes.size);
    session.peerIndex = this.peerIndexes.get(peerKey)!;
    this.backoff.delete(peerKey);
    this.received.set(peerKey, new Map());
    this.advertised.set(peerKey, new Map());
    this.receivedElc.set(peerKey, new Set());
    this.advertisedElc.set(peerKey, new Set());
    this.receivedMtu.set(peerKey, new Map());
    this.advertisedMtu.set(peerKey, new Map());
    this.receivedLoop.set(peerKey, new Map());
    this.advertisedLoop.set(peerKey, new Map());
    this.outstandingRequests.set(peerKey, new Map());
    this.pendingRequests.set(peerKey, new Map());
    this.advertisedAddresses.set(peerKey, new Set());
    this.syncAddresses(session, peerKey);
    this.reconcile();
    for (const handler of this.pwHandlers) handler.sessionOperational(session.peer as LdpIdentifier);
  }

  sessionClosed(session: LdpSession, _reason: string, rejected: boolean): void {
    this.pending.delete(session);
    if (!session.peer) return;
    const peerKey = session.peer.lsrId.toString();
    if (this.sessionTable.get(peerKey) === session) this.sessionTable.delete(peerKey);
    this.received.delete(peerKey);
    this.advertised.delete(peerKey);
    this.receivedElc.delete(peerKey);
    this.advertisedElc.delete(peerKey);
    this.receivedMtu.delete(peerKey);
    this.advertisedMtu.delete(peerKey);
    this.receivedLoop.delete(peerKey);
    this.advertisedLoop.delete(peerKey);
    this.outstandingRequests.delete(peerKey);
    this.pendingRequests.delete(peerKey);
    for (const key of [...this.noRouteAt.keys()]) if (key.startsWith(`${peerKey}|`)) this.noRouteAt.delete(key);
    this.advertisedAddresses.delete(peerKey);
    if (rejected && session.role === 'active') {
      const previous = this.backoff.get(peerKey);
      const delay = previous ? Math.min(previous.delay * 2, INIT_BACKOFF_MAX_MS) : INIT_BACKOFF_FIRST_MS;
      this.backoff.set(peerKey, { until: this.getScheduler().now() + delay, delay });
    }
    this.reconcile();
    const adjacency = [...this.adjacencyTable.values()].find(a => a.peer.equals(session.peer as LdpIdentifier));
    if (adjacency) this.ensureSession(adjacency);
    for (const handler of this.pwHandlers) handler.sessionClosed(session.peer);
  }

  addPwHandler(handler: LdpPwHandler): void {
    if (!this.pwHandlers.includes(handler)) this.pwHandlers.push(handler);
  }

  sendToPeer(peerLsrId: IPAddress, messages: readonly LdpMessage[]): boolean {
    const session = this.sessionTable.get(peerLsrId.toString());
    if (session === undefined || session.state !== 'operational') return false;
    session.send(messages);
    return true;
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
        for (const element of message.fec) {
          if (isPwFec(element)) for (const handler of this.pwHandlers) handler.mapping(session.peer as LdpIdentifier, element, message.label, message.pwStatus);
        }
        this.onMapping(session, peerKey, message);
        return;
      case 'notification':
        if (message.referencedMessageType === MessageType.LabelRequest) this.onRequestRefused(peerKey, message.statusCode, message.referencedMessageId);
        if (message.pwStatus !== undefined) {
          for (const element of message.fec ?? []) {
            if (isPwFec(element)) for (const handler of this.pwHandlers) handler.notification(session.peer as LdpIdentifier, element, message.pwStatus);
          }
        }
        return;
      case 'mac-withdraw':
        for (const element of message.fec) {
          if (isPwFec(element)) for (const handler of this.pwHandlers) handler.macWithdraw(session.peer as LdpIdentifier, element, message.macs);
        }
        return;
      case 'label-request':
        this.onRequest(session, peerKey, message.fec, message.id);
        return;
      case 'label-abort-request':
        this.onAbort(session, peerKey, message.fec, message.requestMessageId, message.id);
        return;
      case 'label-withdraw':
        for (const element of message.fec) {
          if (isPwFec(element)) for (const handler of this.pwHandlers) handler.withdraw(session.peer as LdpIdentifier, element, message.label, message.status);
        }
        this.onWithdraw(session, peerKey, message.fec, message.label, message.id);
        return;
      case 'label-release':
        for (const element of message.fec) {
          if (isPwFec(element)) for (const handler of this.pwHandlers) handler.release(session.peer as LdpIdentifier, element, message.label, message.status);
        }
        this.onRelease(peerKey, message.fec, message.label, message.status);
        return;
      default:
        return;
    }
  }

  private onMapping(session: LdpSession, peerKey: string, message: LabelMappingMessage): void {
    const table = this.received.get(peerKey);
    if (!table) return;
    const elc = this.receivedElc.get(peerKey);
    for (const element of message.fec) {
      const fec = fecOf(element);
      if (!fec) continue;
      if (session.negotiated?.loopDetection === true) {
        if (this.looping(message)) {
          this.dropLoopingMapping(session, peerKey, element, fec.key, message.label);
          continue;
        }
        this.receivedLoop.get(peerKey)?.set(fec.key, { hopCount: message.hopCount ?? 0, pathVector: message.pathVector ?? [] });
      }
      this.outstandingRequests.get(peerKey)?.delete(fec.key);
      table.set(fec.key, message.label);
      if (message.entropyLabelCapable === true) elc?.add(fec.key);
      else elc?.delete(fec.key);
      if (message.lspMtu !== undefined) this.receivedMtu.get(peerKey)?.set(fec.key, message.lspMtu);
      else this.receivedMtu.get(peerKey)?.delete(fec.key);
    }
    this.reconcile();
    void session;
  }

  private onRequest(session: LdpSession, peerKey: string, fecs: readonly FecElement[], requestId: number): void {
    const known = this.computeFecs();
    let waiting = false;
    for (const element of fecs) {
      const fec = fecOf(element);
      if (!fec) continue;
      const binding = this.localBindings.get(fec.key);
      if (!binding) {
        this.refuse(session, requestId);
        continue;
      }
      const entry = known.get(fec.key);
      if (this.config.controlMode === 'ordered' && !binding.egress && !this.hasDownstreamLabel(entry)) {
        this.pendingRequests.get(peerKey)?.set(fec.key, { id: requestId, element });
        waiting = true;
        continue;
      }
      const mapping = this.mappingMessage(session, peerKey, fec.key, binding, entry, requestId);
      if (mapping !== null) session.send([mapping]);
    }
    if (waiting) this.reconcile();
  }

  private refuse(session: LdpSession, requestId: number): void {
    session.send([{
      kind: 'notification', id: this.nextMessageId(), statusCode: StatusCode.NoRoute, forward: false,
      referencedMessageId: requestId, referencedMessageType: MessageType.LabelRequest,
    }]);
  }

  private onAbort(
    session: LdpSession, peerKey: string, fecs: readonly FecElement[], requestId: number, abortId: number,
  ): void {
    const pending = this.pendingRequests.get(peerKey);
    for (const element of fecs) {
      const fec = fecOf(element);
      const held = fec === null ? undefined : pending?.get(fec.key);
      if (fec === null || held === undefined || held.id !== requestId) continue;
      pending?.delete(fec.key);
      session.send([{
        kind: 'notification', id: this.nextMessageId(), statusCode: StatusCode.LabelRequestAborted, forward: false,
        referencedMessageId: abortId, referencedMessageType: MessageType.LabelAbortRequest, requestMessageId: requestId,
      }]);
    }
  }

  private onRequestRefused(peerKey: string, statusCode: number, requestId: number): void {
    const requests = this.outstandingRequests.get(peerKey);
    for (const [key, record] of [...requests ?? []]) {
      if (record.id !== requestId) continue;
      requests?.delete(key);
      if (statusCode !== StatusCode.NoRoute) continue;
      this.noRouteAt.set(`${peerKey}|${key}`, this.nowMs());
      for (const [requester, held] of this.pendingRequests) {
        const waiting = held.get(key);
        if (waiting === undefined) continue;
        held.delete(key);
        const session = this.sessionTable.get(requester);
        if (session?.state === 'operational') this.refuse(session, waiting.id);
      }
    }
  }

  private noRouteRetryDue(): boolean {
    const now = this.nowMs();
    return [...this.noRouteAt.values()].some(at => now - at >= this.config.noRouteRetrySeconds * 1000);
  }

  private requestLabels(fecs: ReadonlyMap<string, { fec: LdpFec; route: LdpRoute }>): void {
    for (const [peerKey, requests] of this.outstandingRequests) {
      const session = this.sessionTable.get(peerKey);
      for (const [key, record] of [...requests]) {
        const entry = fecs.get(key);
        const owner = entry?.route.nextHop && !entry.route.connected ? this.peerOwning(entry.route.nextHop, entry.route.iface) : null;
        if (owner?.key === peerKey) continue;
        requests.delete(key);
        if (session?.state === 'operational') {
          session.send([{ kind: 'label-abort-request', id: this.nextMessageId(), fec: [record.element], requestMessageId: record.id }]);
        }
      }
    }
    const now = this.nowMs();
    for (const [key, { fec, route }] of fecs) {
      if (route.connected || !route.nextHop) continue;
      const owner = this.peerOwning(route.nextHop, route.iface);
      if (owner === null || owner.session.state !== 'operational' || owner.session.negotiated?.advertisementMode !== 'on-demand') continue;
      const requests = this.outstandingRequests.get(owner.key);
      if (requests === undefined || requests.has(key) || this.received.get(owner.key)?.has(key)) continue;
      const refusedAt = this.noRouteAt.get(`${owner.key}|${key}`);
      if (refusedAt !== undefined && now - refusedAt < this.config.noRouteRetrySeconds * 1000) continue;
      this.noRouteAt.delete(`${owner.key}|${key}`);
      const element: FecElement = { kind: 'prefix', prefix: fec.prefix, length: fec.length };
      const id = this.nextMessageId();
      requests.set(key, { id, element });
      owner.session.send([{ kind: 'label-request', id, fec: [element] }]);
    }
  }

  private answerPending(fecs: ReadonlyMap<string, { fec: LdpFec; route: LdpRoute }>): void {
    for (const [peerKey, held] of this.pendingRequests) {
      const session = this.sessionTable.get(peerKey);
      if (session?.state !== 'operational') continue;
      for (const [key, record] of [...held]) {
        const binding = this.localBindings.get(key);
        if (binding === undefined) {
          held.delete(key);
          this.refuse(session, record.id);
          continue;
        }
        const entry = fecs.get(key);
        if (!binding.egress && !this.hasDownstreamLabel(entry)) continue;
        held.delete(key);
        const mapping = this.mappingMessage(session, peerKey, key, binding, entry, record.id);
        if (mapping !== null) session.send([mapping]);
      }
    }
  }

  private looping(message: LabelMappingMessage): boolean {
    const hopCount = message.hopCount ?? 0;
    const pathVector = message.pathVector ?? [];
    return hopCount > this.config.maxHopCount
      || pathVector.some(hop => hop.equals(this.localId.lsrId))
      || pathVector.length > this.config.pathVectorLimit;
  }

  private dropLoopingMapping(session: LdpSession, peerKey: string, element: FecElement, key: string, label: MplsLabel): void {
    this.received.get(peerKey)?.delete(key);
    this.receivedElc.get(peerKey)?.delete(key);
    this.receivedMtu.get(peerKey)?.delete(key);
    this.receivedLoop.get(peerKey)?.delete(key);
    this.loopsDetected++;
    session.send([{ kind: 'label-release', id: this.nextMessageId(), fec: [element], label, status: StatusCode.LoopDetected }]);
  }

  private loopAttributes(
    session: LdpSession, key: string, binding: LdpLocalBinding, entry: { fec: LdpFec; route: LdpRoute } | undefined,
  ): LoopAttributes | null | 'exceeded' {
    if (session.negotiated?.loopDetection !== true) return null;
    if (binding.egress) return { hopCount: 1, pathVector: [] };
    const owner = entry?.route.nextHop ? this.peerOwning(entry.route.nextHop, entry.route.iface) : null;
    const learned = owner === null ? undefined : this.receivedLoop.get(owner.key)?.get(key);
    const pathVector = [...(learned?.pathVector ?? []), this.localId.lsrId];
    if (pathVector.length > this.config.pathVectorLimit) return 'exceeded';
    return { hopCount: learned === undefined || learned.hopCount === 0 ? 0 : learned.hopCount + 1, pathVector };
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
      if (held && (!label || held.equals(label))) {
        table.delete(fec.key);
        this.receivedElc.get(peerKey)?.delete(fec.key);
        this.receivedMtu.get(peerKey)?.delete(fec.key);
        this.receivedLoop.get(peerKey)?.delete(fec.key);
      }
    }
    const prefixFecs = fecs.filter(element => !isPwFec(element));
    if (prefixFecs.length > 0) {
      session.send([{ kind: 'label-release', id: this.nextMessageId(), fec: prefixFecs, ...(label ? { label } : {}) }]);
    }
    void withdrawId;
    this.reconcile();
  }

  private onRelease(peerKey: string, fecs: readonly FecElement[], label: MplsLabel | undefined, status?: number): void {
    const table = this.advertised.get(peerKey);
    if (!table) return;
    if (status === StatusCode.LoopDetected) {
      this.loopsReported++;
      return;
    }
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
    this.requestLabels(fecs);
    this.answerPending(fecs);
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
    const onDemand = session.negotiated?.advertisementMode === 'on-demand';
    for (const [key, binding] of this.localBindings) {
      if (onDemand && !table.has(key)) continue;
      const mapping = this.mappingMessage(session, peerKey, key, binding, fecs.get(key));
      if (mapping !== null) outgoing.push(mapping);
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

  private mappingMessage(
    session: LdpSession, peerKey: string, key: string, binding: LdpLocalBinding,
    entry: { fec: LdpFec; route: LdpRoute } | undefined, requestMessageId?: number,
  ): LabelMappingMessage | null {
    const table = this.advertised.get(peerKey);
    if (!table) return null;
    const sentElc = this.advertisedElc.get(peerKey) ?? new Set<string>();
    const sentMtu = this.advertisedMtu.get(peerKey) ?? new Map<string, number>();
    const sentLoop = this.advertisedLoop.get(peerKey) ?? new Map<string, string>();
    const elc = this.entropyCapableFor(key, binding, entry);
    const lspMtu = this.lspMtuFor(key, binding, entry);
    const loop = this.loopAttributes(session, key, binding, entry);
    if (loop === 'exceeded') return null;
    const loopSignature = loop === null ? '' : `${loop.hopCount}|${loop.pathVector.join(',')}`;
    if (requestMessageId === undefined) {
      if (table.get(key)?.equals(binding.label) && sentElc.has(key) === elc && sentMtu.get(key) === lspMtu
        && (sentLoop.get(key) ?? '') === loopSignature) return null;
      if (this.config.controlMode === 'ordered' && !binding.egress && !this.hasDownstreamLabel(entry)) return null;
    }
    table.set(key, binding.label);
    if (elc) sentElc.add(key);
    else sentElc.delete(key);
    sentMtu.set(key, lspMtu);
    sentLoop.set(key, loopSignature);
    return {
      kind: 'label-mapping', id: this.nextMessageId(),
      fec: [{ kind: 'prefix', prefix: binding.fec.prefix, length: binding.fec.length }], label: binding.label,
      ...(requestMessageId === undefined ? {} : { requestMessageId }),
      ...(elc ? { entropyLabelCapable: true } : {}),
      ...(loop === null ? {} : { hopCount: loop.hopCount, ...(loop.pathVector.length > 0 ? { pathVector: loop.pathVector } : {}) }),
      lspMtu,
    };
  }

  private lspMtuFor(key: string, binding: LdpLocalBinding, entry: { fec: LdpFec; route: LdpRoute } | undefined): number {
    if (binding.egress) return LDP_EGRESS_LSP_MTU;
    if (!entry?.route.nextHop) return LDP_EGRESS_LSP_MTU;
    const owner = this.peerOwning(entry.route.nextHop, entry.route.iface);
    const link = this.host.interfaces().find(candidate => candidate.name === entry.route.iface);
    if (owner === null || link === undefined) return LDP_EGRESS_LSP_MTU;
    const downstream = this.received.get(owner.key)?.get(key);
    const hop = downstream?.isImplicitNull() === true ? link.mtu : link.mtu - LDP_LABEL_BYTES;
    return Math.min(hop, this.receivedMtu.get(owner.key)?.get(key) ?? LDP_EGRESS_LSP_MTU);
  }

  private entropyCapableFor(key: string, binding: LdpLocalBinding, entry: { fec: LdpFec; route: LdpRoute } | undefined): boolean {
    if (!this.mpls.entropyLabelCapable) return false;
    if (binding.egress) return true;
    if (!entry?.route.nextHop) return false;
    const owner = this.peerOwning(entry.route.nextHop, entry.route.iface);
    return owner !== null && this.receivedElc.get(owner.key)?.has(key) === true;
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
        this.mpls.lfib.setFtn({
          prefix: fec.prefix, prefixLength: fec.length, outLabels: [], iface: route.iface, nextHop: route.nextHop,
          lspMtu: this.lspMtuFor(key, binding, { fec, route }),
        });
        wantedFtn.set(key, { prefix: fec.prefix, length: fec.length });
        continue;
      }
      this.mpls.lfib.setIlm(binding.label, { kind: 'swap', outLabels: [remote], iface: route.iface, nextHop: route.nextHop });
      wantedIlm.set(binding.label.value, true);
      this.mpls.lfib.setFtn({
        prefix: fec.prefix, prefixLength: fec.length, outLabels: [remote], iface: route.iface, nextHop: route.nextHop,
        entropyLabelCapable: owner !== null && this.receivedElc.get(owner.key)?.has(key) === true,
        lspMtu: this.lspMtuFor(key, binding, { fec, route }),
      });
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

  lastRevisionSent(peer: LdpIdentifier): number {
    const sent = this.advertised.get(peer.lsrId.toString());
    return Math.max(0, ...[...sent?.keys() ?? []].map(key => this.localBindings.get(key)?.revision ?? 0));
  }

  advertisedTo(fecKey: string): readonly LdpIdentifier[] {
    return [...this.sessionTable.values()]
      .filter(session => session.peer !== null && this.advertised.get(session.peer.lsrId.toString())?.has(fecKey) === true)
      .map(session => session.peer as LdpIdentifier);
  }

  backoffParameters(): { readonly initialSeconds: number; readonly maximumSeconds: number } {
    return { initialSeconds: INIT_BACKOFF_FIRST_MS / 1000, maximumSeconds: INIT_BACKOFF_MAX_MS / 1000 };
  }

  backoffEntries(): ReadonlyArray<{ readonly peer: string; readonly backoffSeconds: number; readonly waitingSeconds: number }> {
    const now = this.getScheduler().now();
    return [...this.backoff.entries()].filter(([, wait]) => wait.until > now).map(([peer, wait]) => ({
      peer, backoffSeconds: Math.round(wait.delay / 1000), waitingSeconds: Math.round((now - (wait.until - wait.delay)) / 1000),
    }));
  }

  targetedRole(source: IPAddress): 'active' | 'passive' {
    return this.targetedPeers.get(source.toString())?.configured === true ? 'active' : 'passive';
  }

  installsIlm(label: MplsLabel): boolean {
    return this.installedIlm.has(label.value);
  }

  setAdvertisementMode(mode: 'unsolicited' | 'on-demand'): void {
    this.config.advertisementMode = mode;
    this.resetSessions();
  }

  setLoopDetection(enabled: boolean, pathVectorLimit: number | null = null, maxHopCount: number | null = null): void {
    this.config.loopDetection = enabled;
    if (pathVectorLimit !== null) this.config.pathVectorLimit = pathVectorLimit;
    if (maxHopCount !== null) this.config.maxHopCount = maxHopCount;
    this.resetSessions();
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
