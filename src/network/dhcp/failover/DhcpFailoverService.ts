import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { IEventBus } from '@/events/EventBus';
import type { DhcpAdmissionPolicy } from '@/network/dhcp/types';
import { DHCP_FAILOVER_PORT } from '@/network/core/WellKnownPorts';
import { IPAddress } from '@/network/core/types';
import {
  CONTACT_INTERVAL_MS, CONTACT_TIMEOUT_MS, partnerOf,
  type FailoverBinding, type FailoverConfig, type FailoverInfo, type FailoverOpResult,
  type FailoverScopeData, type FailoverState,
} from './types';
import {
  decodeMessage, sendFailoverMessage, signMessage, verifyMessage,
  type FailoverMessage, type FailoverMessageType, type FailoverReply,
} from './FailoverWire';

export interface FailoverHost {
  now(): number;
  tcp(): TcpStack;
  bus(): IEventBus;
  deviceId(): string;
  hostName(): string;
  ownAddresses(): string[];
  scopeRange(scope: string): { start: string; end: string } | null;
  exportScopes(names: readonly string[]): FailoverScopeData[];
  importScopes(data: readonly FailoverScopeData[], overwrite: boolean): FailoverOpResult;
  exportBindings(scopes: readonly string[]): FailoverBinding[];
  importBinding(binding: FailoverBinding): void;
  dropBinding(ip: string): void;
  adminApReqFor(peerName: string): Uint8Array | null;
  verifyAdministrator(apReq: Uint8Array): boolean;
  isAuthorized(): boolean;
}

interface Relationship {
  config: FailoverConfig;
  state: FailoverState;
  lastAttemptMs: number;
  lastSuccessMs: number;
  interruptedAtMs: number | null;
  partnerDownAtMs: number | null;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const ADMIN_MESSAGES: readonly FailoverMessageType[] = ['SETUP', 'UPDATE', 'SCOPESYNC', 'REMOVE'];

export class DhcpFailoverService {
  private readonly relationships = new Map<string, Relationship>();
  private listening = false;
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly host: FailoverHost) {}

  readonly policy: DhcpAdmissionPolicy = {
    mayServe: (mac, pool) => this.mayServe(mac, pool),
    addressAllowed: (ip, pool) => this.addressAllowed(ip, pool),
    leaseSeconds: (pool, configured) => this.leaseSeconds(pool, configured),
  };

  start(): void {
    if (this.listening) return;
    this.host.tcp().listen(DHCP_FAILOVER_PORT, {
      identity: { pid: 1220, processName: 'svchost.exe' },
      onAccept: (socket: TcpSocket) => this.accept(socket),
    });
    this.unsubscribers = [
      this.host.bus().subscribe('dhcp.pool.lease-allocated', (event) => this.leaseChanged(event.payload as { deviceId: string; pool: string; ip: string }, false)),
      this.host.bus().subscribe('dhcp.pool.lease-released', (event) => {
        const payload = event.payload as { deviceId: string; pool: string; ip: string; reason: string };
        if (payload.reason !== 'expired') this.leaseChanged(payload, true);
      }),
    ];
    this.listening = true;
    for (const rel of this.relationships.values()) {
      rel.state = 'Startup';
      rel.lastSuccessMs = this.host.now();
      rel.lastAttemptMs = 0;
    }
  }

  stop(): void {
    if (!this.listening) return;
    this.host.tcp().closeListener(DHCP_FAILOVER_PORT);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listening = false;
  }

  list(): FailoverInfo[] {
    return [...this.relationships.values()].map(rel => this.info(rel));
  }

  get(name: string): FailoverInfo | null {
    const rel = this.relationships.get(name.toLowerCase());
    return rel ? this.info(rel) : null;
  }

  relationshipOfScope(scope: string): string | null {
    for (const rel of this.relationships.values()) {
      if (rel.config.scopes.includes(scope)) return rel.config.name;
    }
    return null;
  }

  private info(rel: Relationship): FailoverInfo {
    const partner = partnerOf(rel.config);
    return {
      ...rel.config, scopes: [...rel.config.scopes], state: rel.state,
      partnerAddress: partner.address, partnerName: partner.name, lastContactMs: rel.lastSuccessMs,
    };
  }

  create(config: FailoverConfig, force: boolean): FailoverOpResult {
    const key = config.name.toLowerCase();
    const problem = this.validate(config);
    if (problem) return { ok: false, message: problem };
    if (this.relationships.has(key)) return { ok: false, message: `A failover relationship named "${config.name}" already exists.` };
    for (const scope of config.scopes) {
      const owner = this.relationshipOfScope(scope);
      if (owner) return { ok: false, message: `The scope "${scope}" already belongs to the failover relationship "${owner}".` };
    }
    const partner = partnerOf(config);
    const reply = this.sendAdmin('SETUP', { ...config, localIsPrimary: !config.localIsPrimary },
      partner, config.name, {
        scopes: this.host.exportScopes(config.scopes), bindings: this.host.exportBindings(config.scopes), force,
      });
    if (!reply.ok) return { ok: false, message: reply.message ?? 'The partner server refused the relationship.' };
    const secondaryName = String(reply.partnerName ?? config.secondaryName);
    this.register({ ...config, secondaryName: config.localIsPrimary ? secondaryName : config.secondaryName });
    return { ok: true, message: '' };
  }

  update(name: string, changes: Partial<Omit<FailoverConfig, 'name' | 'localIsPrimary'>>): FailoverOpResult {
    const rel = this.relationships.get(name.toLowerCase());
    if (!rel) return { ok: false, message: `The failover relationship "${name}" does not exist.` };
    const next: FailoverConfig = { ...rel.config, ...changes };
    const problem = this.validate(next);
    if (problem) return { ok: false, message: problem };
    const gained = next.scopes.filter(scope => !rel.config.scopes.includes(scope));
    for (const scope of gained) {
      const owner = this.relationshipOfScope(scope);
      if (owner) return { ok: false, message: `The scope "${scope}" already belongs to the failover relationship "${owner}".` };
    }
    const partner = partnerOf(next);
    const reply = this.sendAdmin('UPDATE', { ...next, localIsPrimary: !next.localIsPrimary }, partner, next.name, {
      scopes: this.host.exportScopes(gained), bindings: this.host.exportBindings(gained),
    });
    if (!reply.ok) return { ok: false, message: reply.message ?? 'The partner server refused the change.' };
    rel.config = next;
    return { ok: true, message: '' };
  }

  replicate(name: string, scopes: readonly string[] | undefined, force: boolean): FailoverOpResult {
    const rel = this.relationships.get(name.toLowerCase());
    if (!rel) return { ok: false, message: `The failover relationship "${name}" does not exist.` };
    const wanted = scopes ?? rel.config.scopes;
    const stranger = wanted.find(scope => !rel.config.scopes.includes(scope));
    if (stranger) return { ok: false, message: `The scope "${stranger}" is not part of the failover relationship "${name}".` };
    const reply = this.sendAdmin('SCOPESYNC', rel.config, partnerOf(rel.config), rel.config.name, {
      scopes: this.host.exportScopes(wanted), force,
    });
    return reply.ok ? { ok: true, message: '' } : { ok: false, message: reply.message ?? 'The partner server refused the replication.' };
  }

  remove(name: string, force: boolean): FailoverOpResult {
    const rel = this.relationships.get(name.toLowerCase());
    if (!rel) return { ok: false, message: `The failover relationship "${name}" does not exist.` };
    const reply = this.sendAdmin('REMOVE', rel.config, partnerOf(rel.config), rel.config.name, {});
    if (!reply.ok && !force) return { ok: false, message: reply.message ?? 'The partner server could not be reached; use -Force to remove only the local half.' };
    this.relationships.delete(name.toLowerCase());
    return { ok: true, message: '' };
  }

  declarePartnerDown(name: string): FailoverOpResult {
    const rel = this.relationships.get(name.toLowerCase());
    if (!rel) return { ok: false, message: `The failover relationship "${name}" does not exist.` };
    if (rel.state !== 'CommunicationInterrupted') {
      return { ok: false, message: `The relationship "${name}" is in the ${rel.state} state; PartnerDown can only be declared from CommunicationInterrupted.` };
    }
    this.setState(rel, 'PartnerDown');
    return { ok: true, message: '' };
  }

  tick(): void {
    if (!this.listening) return;
    const at = this.host.now();
    for (const rel of this.relationships.values()) {
      if (at - rel.lastAttemptMs < CONTACT_INTERVAL_MS) continue;
      rel.lastAttemptMs = at;
      const reply = this.send(rel, 'CONTACT', { state: rel.state });
      if (reply?.ok) this.contactSucceeded(rel, at);
      else this.contactFailed(rel, at);
    }
  }

  validate(config: FailoverConfig): string | null {
    if (config.loadBalancePercent < 1 || config.loadBalancePercent > 99) return 'LoadBalancePercent must be between 1 and 99.';
    if (config.reservePercent < 0 || config.reservePercent > 100) return 'ReservePercent must be between 0 and 100.';
    if (config.maxClientLeadTimeSeconds < 60) return 'MaxClientLeadTime must be at least one minute.';
    if (config.stateSwitchIntervalSeconds < 60) return 'StateSwitchInterval must be at least one minute.';
    return null;
  }

  private register(config: FailoverConfig): Relationship {
    const at = this.host.now();
    const rel: Relationship = {
      config, state: 'Normal', lastAttemptMs: at, lastSuccessMs: at, interruptedAtMs: null, partnerDownAtMs: null,
    };
    this.relationships.set(config.name.toLowerCase(), rel);
    return rel;
  }

  private setState(rel: Relationship, next: FailoverState): void {
    if (rel.state === next) return;
    const previous = rel.state;
    rel.state = next;
    const at = this.host.now();
    if (next === 'CommunicationInterrupted') rel.interruptedAtMs = at;
    if (next === 'PartnerDown') rel.partnerDownAtMs = at;
    if (next === 'Normal') { rel.interruptedAtMs = null; rel.partnerDownAtMs = null; }
    this.host.bus().publish({
      topic: 'dhcp.failover.state-changed',
      payload: { deviceId: this.host.deviceId(), hostname: this.host.hostName(), relationship: rel.config.name, from: previous, to: next },
    });
  }

  private contactSucceeded(rel: Relationship, at: number): void {
    rel.lastSuccessMs = at;
    if (rel.state === 'Normal') return;
    this.setState(rel, 'Recover');
    this.synchronise(rel);
    this.setState(rel, 'Normal');
  }

  private contactFailed(rel: Relationship, at: number): void {
    if ((rel.state === 'Normal' || rel.state === 'Startup' || rel.state === 'Recover' || rel.state === 'RecoverWait')
      && at - rel.lastSuccessMs >= CONTACT_TIMEOUT_MS) {
      this.setState(rel, 'CommunicationInterrupted');
    }
    if (rel.state === 'CommunicationInterrupted' && rel.config.autoStateTransition && rel.interruptedAtMs !== null
      && at - rel.interruptedAtMs >= rel.config.stateSwitchIntervalSeconds * 1000) {
      this.setState(rel, 'PartnerDown');
    }
  }

  private synchronise(rel: Relationship): void {
    const reply = this.send(rel, 'SYNC', { bindings: this.host.exportBindings(rel.config.scopes) });
    for (const binding of (reply?.bindings as FailoverBinding[] | undefined) ?? []) this.mergeBinding(binding);
  }

  private mergeBinding(binding: FailoverBinding): void {
    const known = this.host.exportBindings([binding.scope]).find(b => b.ip === binding.ip);
    if (!known || known.leaseStart < binding.leaseStart) this.host.importBinding(binding);
  }

  private leaseChanged(payload: { deviceId: string; pool: string; ip: string }, released: boolean): void {
    if (payload.deviceId !== this.host.deviceId()) return;
    const owner = this.relationshipOfScope(payload.pool);
    const rel = owner ? this.relationships.get(owner.toLowerCase()) : undefined;
    if (!rel) return;
    setTimeout(() => this.replicateLease(rel, payload.pool, payload.ip, released), 0);
  }

  private replicateLease(rel: Relationship, scope: string, ip: string, released: boolean): void {
    const binding = released ? null : this.host.exportBindings([scope]).find(b => b.ip === ip) ?? null;
    if (!released && !binding) return;
    const reply = this.send(rel, 'BNDUPD', { ip, scope, released, binding });
    if (!reply?.ok) this.setState(rel, rel.state === 'PartnerDown' ? 'PartnerDown' : 'CommunicationInterrupted');
  }

  private send(rel: Relationship, type: FailoverMessageType, body: Record<string, unknown>): FailoverReply | null {
    const partner = partnerOf(rel.config);
    const message = signMessage({ type, relationship: rel.config.name, from: this.host.hostName(), body }, rel.config.sharedSecret);
    return sendFailoverMessage(this.host.tcp(), partner.address, message);
  }

  private sendAdmin(
    type: FailoverMessageType, config: FailoverConfig, partner: { address: string; name: string },
    name: string, extra: Record<string, unknown>,
  ): FailoverReply {
    const apReq = this.host.adminApReqFor(partner.name);
    if (!apReq) return { ok: false, message: 'Access is denied: no Kerberos identity is available to administer the partner server.' };
    const message: FailoverMessage = {
      type, relationship: name, from: this.host.hostName(), body: { config, ...extra }, apReq: base64(apReq),
    };
    const reply = sendFailoverMessage(this.host.tcp(), partner.address, message);
    return reply ?? { ok: false, message: `The partner server ${partner.name} could not be reached on TCP ${DHCP_FAILOVER_PORT}.` };
  }

  private accept(socket: TcpSocket): void {
    socket.onData((data) => {
      const message = decodeMessage(String(data));
      const reply = message ? this.handle(message, socket.remoteIp) : { ok: false, message: 'Malformed failover message.' };
      socket.write(JSON.stringify(reply));
    });
  }

  private handle(message: FailoverMessage, sourceIp: string): FailoverReply {
    if (!this.host.isAuthorized()) return { ok: false, message: 'This DHCP server is not authorized.' };
    if (ADMIN_MESSAGES.includes(message.type)) return this.handleAdmin(message);
    const rel = this.relationships.get(message.relationship.toLowerCase());
    if (!rel) return { ok: false, message: 'Unknown failover relationship.' };
    if (sourceIp !== partnerOf(rel.config).address) return { ok: false, message: 'The sender is not the partner of this relationship.' };
    if (!verifyMessage(message, rel.config.sharedSecret)) return { ok: false, message: 'Message authentication failed.' };
    switch (message.type) {
      case 'CONTACT': {
        const at = this.host.now();
        if (rel.state === 'Normal') rel.lastSuccessMs = at;
        else setTimeout(() => this.contactSucceeded(rel, at), 0);
        return { ok: true, state: rel.state };
      }
      case 'BNDUPD': return this.applyBindingUpdate(rel, message.body);
      case 'SYNC': {
        for (const binding of (message.body.bindings as FailoverBinding[] | undefined) ?? []) this.mergeBinding(binding);
        return { ok: true, bindings: this.host.exportBindings(rel.config.scopes) };
      }
      default: return { ok: false, message: 'Unsupported message.' };
    }
  }

  private applyBindingUpdate(rel: Relationship, body: Record<string, unknown>): FailoverReply {
    const scope = String(body.scope ?? '');
    if (!rel.config.scopes.includes(scope)) return { ok: false, message: 'The scope is not part of the relationship.' };
    if (body.released === true) this.host.dropBinding(String(body.ip ?? ''));
    else if (body.binding) this.mergeBinding(body.binding as FailoverBinding);
    return { ok: true };
  }

  private handleAdmin(message: FailoverMessage): FailoverReply {
    if (!message.apReq || !this.host.verifyAdministrator(fromBase64(message.apReq))) {
      return { ok: false, message: 'Access is denied.' };
    }
    const config = message.body.config as FailoverConfig;
    const scopes = (message.body.scopes as FailoverScopeData[] | undefined) ?? [];
    const force = message.body.force === true;
    const key = message.relationship.toLowerCase();
    switch (message.type) {
      case 'SETUP': {
        if (this.relationships.has(key)) return { ok: false, message: `A failover relationship named "${config.name}" already exists on ${this.host.hostName()}.` };
        const imported = this.host.importScopes(scopes, force);
        if (!imported.ok) return imported;
        const rel = this.register(config);
        for (const binding of (message.body.bindings as FailoverBinding[] | undefined) ?? []) this.host.importBinding(binding);
        rel.state = 'Normal';
        return { ok: true, partnerName: this.host.hostName() };
      }
      case 'UPDATE': {
        const rel = this.relationships.get(key);
        if (!rel) return { ok: false, message: `The failover relationship "${message.relationship}" does not exist on ${this.host.hostName()}.` };
        if (scopes.length > 0) {
          const imported = this.host.importScopes(scopes, true);
          if (!imported.ok) return imported;
          for (const binding of (message.body.bindings as FailoverBinding[] | undefined) ?? []) this.host.importBinding(binding);
        }
        rel.config = config;
        return { ok: true };
      }
      case 'SCOPESYNC': {
        if (!this.relationships.has(key)) return { ok: false, message: `The failover relationship "${message.relationship}" does not exist on ${this.host.hostName()}.` };
        return this.host.importScopes(scopes, force);
      }
      default: {
        this.relationships.delete(key);
        return { ok: true };
      }
    }
  }

  private relationshipFor(scope: string): Relationship | null {
    const owner = this.relationshipOfScope(scope);
    return owner ? this.relationships.get(owner.toLowerCase()) ?? null : null;
  }

  private ownsClientBucket(rel: Relationship, mac: string): boolean {
    const bucket = fnv1a(mac.toLowerCase().replace(/[^0-9a-f]/g, '')) % 100;
    return rel.config.localIsPrimary ? bucket < rel.config.loadBalancePercent : bucket >= rel.config.loadBalancePercent;
  }

  private localIsActive(rel: Relationship): boolean {
    return rel.config.localIsPrimary === (rel.config.primaryRole === 'Active');
  }

  private mayServe(mac: string, pool: string): boolean {
    const rel = this.relationshipFor(pool);
    if (!rel) return true;
    switch (rel.state) {
      case 'Startup': return false;
      case 'Normal': {
        if (rel.config.mode === 'HotStandby') return this.localIsActive(rel);
        return this.ownsClientBucket(rel, mac);
      }
      default: return true;
    }
  }

  private addressAllowed(ip: string, pool: string): boolean {
    const rel = this.relationshipFor(pool);
    if (!rel || rel.state === 'PartnerDown') return true;
    const range = this.host.scopeRange(pool);
    if (!range) return true;
    const start = new IPAddress(range.start).toUint32();
    const size = new IPAddress(range.end).toUint32() - start + 1;
    const index = new IPAddress(ip).toUint32() - start;
    if (rel.config.mode === 'LoadBalance') {
      const primaryPortion = Math.floor((size * rel.config.loadBalancePercent) / 100);
      return rel.config.localIsPrimary ? index < primaryPortion : index >= primaryPortion;
    }
    const activePortion = size - Math.ceil((size * rel.config.reservePercent) / 100);
    return this.localIsActive(rel) ? index < activePortion : index >= activePortion;
  }

  private leaseSeconds(pool: string, configured: number): number {
    const rel = this.relationshipFor(pool);
    if (!rel || rel.state === 'Normal') return configured;
    const mclt = rel.config.maxClientLeadTimeSeconds;
    if (rel.state === 'PartnerDown' && rel.partnerDownAtMs !== null && this.host.now() - rel.partnerDownAtMs >= mclt * 1000) {
      return configured;
    }
    return Math.min(configured, mclt);
  }
}
