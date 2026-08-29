/**
 * WindowsNpsRole — hosts the real RADIUS engine (`src/network/radius/
 * RadiusServerAgent.ts`) as the "NPS" Windows role (PRD-Windows-Server.md
 * §5 P9): genuine Access-Request/Accept/Reject over real UDP 1812/1813,
 * reusing the wire/protocol stack wholesale — the same engine
 * `RadiusdService`/`LinuxServer` already hosts for freeradius. No RADIUS
 * logic is reimplemented here; this is a thin Windows-flavored façade
 * (NAS-client + network-policy CRUD) around that engine.
 *
 * User base: the PRD requires NPS to authenticate against the local SAM
 * or the AD directory — not a dedicated user list (§4 "l'annuaire =
 * source de vérité unique"). `RadiusServerAgent.setUserResolver()` (added
 * for this phase) resolves users live at each Access-Request against
 * whichever store applies (local SAM first, then AD — same order as
 * real Windows identity resolution), matching the user's groups against
 * the configured network policies for the reply attributes (VLAN,
 * Session-Timeout). A user whose groups match no policy is treated as
 * unresolved (access denied), mirroring real NPS's default-deny when no
 * Network Policy grants access.
 *
 * Scope: a single shared RADIUS secret across all NAS clients (mirrors
 * the engine's own limitation, already documented for the Linux
 * freeradius host — see `RadiusdService.ts`); no realm proxying; each
 * policy matches on one Windows/AD group (first match wins), not the
 * fuller condition set real NPS supports (§2.2 "NPS avancé" is
 * explicitly out of scope).
 */

import type { EndHost } from '@/network/devices/EndHost';
import { RadiusServerAgent, type RadiusServerHost, type RadiusUserResolverContext } from '@/network/radius/RadiusServerAgent';
import { attr, type RadiusUser, type RadiusAttribute } from '@/network/radius/types';
import { type IEventBus } from '@/events/EventBus';
import { ownBusProvider } from '@/events/BusHolder';
import { IPAddress } from '@/network/core/types';
import type { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';
import type { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import type { PSEventLogProvider } from '@/network/devices/windows/PSEventLogProvider';
import { NpsSqlAccountingTable } from './NpsSqlAccounting';
import type { ResultSet } from '@/database/engine/executor/ResultSet';

export interface NpsOpResult { ok: boolean; message: string }
export interface NasClientInfo { name: string; ipAddress: string; nasType?: string }
export interface NetworkPolicyInfo { name: string; group: string; vlanId?: number; sessionTimeoutSec?: number }

/**
 * `New-NpsConnectionRequestPolicy` conditions (PRD-Windows-Server-
 * Advanced.md §5 P22, §2.1.21) — a fuller condition set than the single-
 * group `NetworkPolicyInfo` above, evaluated *before* it. `days` uses
 * `Date.getDay()` numbering (0 = Sunday .. 6 = Saturday); `startHour`/
 * `endHour` are 0-23, inclusive-start/exclusive-end.
 */
export interface ConnectionRequestPolicyConditions {
  group?: string;
  nasType?: string;
  clientIpAddress?: string;
  daysAndTimes?: { days: readonly number[]; startHour: number; endHour: number };
}
export interface ConnectionRequestPolicyInfo {
  name: string;
  conditions: ConnectionRequestPolicyConditions;
}

export interface NpsUserStore {
  getUserManager(): WindowsUserManager;
  getDirectoryStore(): DirectoryStore | null;
}

const RADIUS_AUTH_PORT = 1812;
const RADIUS_ACCT_PORT = 1813;
const SECURITY_AUDIT_SOURCE = 'Microsoft-Windows-Security-Auditing';
/** Real NPS Security-log event IDs. */
const EVENT_ID_GRANTED = 6272;
const EVENT_ID_DENIED = 6273;

export class WindowsNpsRole {
  private readonly agent: RadiusServerAgent;
  private readonly nasClients = new Map<string, NasClientInfo>();
  private readonly policies: NetworkPolicyInfo[] = [];
  private readonly connectionRequestPolicies: ConnectionRequestPolicyInfo[] = [];
  private running = false;
  private unsubscribeAuditLog: (() => void) | null = null;
  private unsubscribeAccounting: (() => void) | null = null;
  private sqlAccounting: NpsSqlAccountingTable | null = null;
  private sqlLoggingEnabled = false;

  constructor(
    private readonly host: EndHost,
    private readonly userStore: NpsUserStore,
    private readonly eventLog: PSEventLogProvider,
    private readonly getNow: () => Date = () => new Date(),
    private readonly getHostBus: () => IEventBus = ownBusProvider(),
  ) {
    const radiusHost: RadiusServerHost = {
      id: host.getId(), name: host.getName(),
      getHostname: () => host.getHostname(),
      getPort: (n: string) => host.getPort(n),
      getPorts: () => host.getPorts(),
      sendFrame: (p: string, f) => { host.sendFrame(p, f); },
      sendIpv4FrameArpAware: (p, ipPkt, nextHopIP) =>
        host.sendIpv4FrameArpAware(p, ipPkt, nextHopIP),
      sendUdpDatagram: (request) => host.sendUdpDatagram(request),
      sourceAddressFor: (destination) => host.sourceAddressFor(destination),
    };
    this.agent = new RadiusServerAgent(radiusHost, () => this.getHostBus());
    this.agent.setUserResolver((username, context) => this.resolveUser(username, context));
  }

  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.agent.start();
    this.host.udpBind(RADIUS_AUTH_PORT, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress) this.agent.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, 'IAS');
    this.host.udpBind(RADIUS_ACCT_PORT, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress) this.agent.handleAcctUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, 'IAS');
    this.unsubscribeAuditLog = this.getHostBus().subscribe('radius.packet.sent', (e) => {
      const p = e.payload as { deviceId: string; code: string; username: string | null };
      if (p.deviceId !== this.host.getId()) return;
      if (p.code === 'access-accept') {
        this.eventLog.writeEventLog('Security', SECURITY_AUDIT_SOURCE, EVENT_ID_GRANTED, 'SuccessAudit',
          `Network Policy Server granted access to a user.\n\nUser:\n\tSecurity ID:\t\t${p.username}\n\tAccount Name:\t\t${p.username}`);
      } else if (p.code === 'access-reject') {
        this.eventLog.writeEventLog('Security', SECURITY_AUDIT_SOURCE, EVENT_ID_DENIED, 'FailureAudit',
          `Network Policy Server denied access to a user.\n\nUser:\n\tSecurity ID:\t\t${p.username}\n\tAccount Name:\t\t${p.username}`);
      }
    });
    this.unsubscribeAccounting = this.getHostBus().subscribe('radius.accounting.record', (e) => {
      const p = e.payload as {
        deviceId: string; sessionId: string; username: string; status: string;
        sessionTimeSec: number; inputOctets: number; outputOctets: number;
      };
      if (p.deviceId !== this.host.getId()) return;
      if (!this.sqlLoggingEnabled || !this.sqlAccounting) return;
      this.sqlAccounting.insert({
        sessionId: p.sessionId, username: p.username, status: p.status,
        sessionTimeSec: p.sessionTimeSec, inputOctets: p.inputOctets, outputOctets: p.outputOctets,
      });
    });
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.host.udpClose(RADIUS_AUTH_PORT);
    this.host.udpClose(RADIUS_ACCT_PORT);
    this.agent.stop();
    this.unsubscribeAuditLog?.();
    this.unsubscribeAuditLog = null;
    this.unsubscribeAccounting?.();
    this.unsubscribeAccounting = null;
    this.running = false;
  }

  // ─── SQL accounting (PRD-Windows-Server-Advanced.md §5 P22) ─────────

  /** `Set-NpsAccountingConfiguration -SqlLogging` — redirects the accounting records this role already produces into a simulated SQL table (`NpsSqlAccountingTable`, built on this project's own `OracleDatabase`) instead of a flat file. */
  setSqlAccounting(enabled: boolean): NpsOpResult {
    this.sqlLoggingEnabled = enabled;
    if (enabled && !this.sqlAccounting) this.sqlAccounting = new NpsSqlAccountingTable();
    return { ok: true, message: '' };
  }

  isSqlAccountingEnabled(): boolean { return this.sqlLoggingEnabled; }

  /** Runs a read query against the accounting table (e.g. `SELECT * FROM RADIUS_ACCOUNTING`) — null until SQL logging has been enabled at least once. */
  queryAccounting(sql: string): ResultSet | null {
    return this.sqlAccounting ? this.sqlAccounting.query(sql) : null;
  }

  // ─── NAS clients (New-NpsRadiusClient / netsh nps add client) ───────

  addNasClient(name: string, ipAddress: string, sharedSecret: string, nasType?: string): NpsOpResult {
    if (this.nasClients.has(name)) {
      return { ok: false, message: `New-NpsRadiusClient : A RADIUS client named "${name}" already exists.` };
    }
    this.nasClients.set(name, { name, ipAddress, nasType });
    this.agent.authorizeClient(ipAddress);
    this.agent.setSharedSecret(sharedSecret);
    return { ok: true, message: '' };
  }

  removeNasClient(name: string): NpsOpResult {
    const client = this.nasClients.get(name);
    if (!client) return { ok: false, message: `Remove-NpsRadiusClient : A RADIUS client named "${name}" does not exist.` };
    this.nasClients.delete(name);
    this.agent.revokeClient(client.ipAddress);
    return { ok: true, message: '' };
  }

  getNasClient(name: string): NasClientInfo | null { return this.nasClients.get(name) ?? null; }
  listNasClients(): NasClientInfo[] { return [...this.nasClients.values()]; }

  // ─── Network policies (condition group → accept + VLAN/Session-Timeout) ──

  addNetworkPolicy(name: string, group: string, opts: { vlanId?: number; sessionTimeoutSec?: number } = {}): NpsOpResult {
    if (this.policies.some(p => p.name === name)) {
      return { ok: false, message: `New-NpsNetworkPolicy : A network policy named "${name}" already exists.` };
    }
    this.policies.push({ name, group, vlanId: opts.vlanId, sessionTimeoutSec: opts.sessionTimeoutSec });
    return { ok: true, message: '' };
  }

  removeNetworkPolicy(name: string): NpsOpResult {
    const idx = this.policies.findIndex(p => p.name === name);
    if (idx === -1) return { ok: false, message: `Remove-NpsNetworkPolicy : A network policy named "${name}" does not exist.` };
    this.policies.splice(idx, 1);
    return { ok: true, message: '' };
  }

  listNetworkPolicies(): NetworkPolicyInfo[] { return [...this.policies]; }

  // ─── Connection request policies (PRD-Windows-Server-Advanced.md §5 P22) ──
  // Evaluated in priority order (array/insertion order — same convention
  // `listNetworkPolicies` above already establishes) *before* the network
  // policies: when at least one connection request policy is configured,
  // a request must match one (by every condition it sets) to even reach
  // network-policy evaluation, mirroring real NPS's two-stage pipeline
  // (this simulator has no realm proxying, so "match" always means
  // "authenticate locally").

  addConnectionRequestPolicy(name: string, conditions: ConnectionRequestPolicyConditions): NpsOpResult {
    if (this.connectionRequestPolicies.some(p => p.name === name)) {
      return { ok: false, message: `New-NpsConnectionRequestPolicy : A connection request policy named "${name}" already exists.` };
    }
    this.connectionRequestPolicies.push({ name, conditions });
    return { ok: true, message: '' };
  }

  removeConnectionRequestPolicy(name: string): NpsOpResult {
    const idx = this.connectionRequestPolicies.findIndex(p => p.name === name);
    if (idx === -1) return { ok: false, message: `Remove-NpsConnectionRequestPolicy : A connection request policy named "${name}" does not exist.` };
    this.connectionRequestPolicies.splice(idx, 1);
    return { ok: true, message: '' };
  }

  listConnectionRequestPolicies(): ConnectionRequestPolicyInfo[] { return [...this.connectionRequestPolicies]; }

  private matchesConnectionRequestPolicy(conditions: ConnectionRequestPolicyConditions, groups: string[], nasIp: string | undefined): boolean {
    if (conditions.group !== undefined && !groups.some(g => g.toLowerCase() === conditions.group!.toLowerCase())) return false;
    if (conditions.clientIpAddress !== undefined && conditions.clientIpAddress !== nasIp) return false;
    if (conditions.nasType !== undefined) {
      const nas = nasIp ? [...this.nasClients.values()].find(c => c.ipAddress === nasIp) : undefined;
      if (nas?.nasType !== conditions.nasType) return false;
    }
    if (conditions.daysAndTimes !== undefined) {
      const now = this.getNow();
      const { days, startHour, endHour } = conditions.daysAndTimes;
      if (!days.includes(now.getDay())) return false;
      const hour = now.getHours();
      if (hour < startHour || hour >= endHour) return false;
    }
    return true;
  }

  // ─── User resolution — RadiusServerAgent.setUserResolver hook ───────

  private resolveUser(username: string, context?: RadiusUserResolverContext): RadiusUser | undefined {
    const sam = this.lookupSam(username);
    const found = sam ?? this.lookupAd(username);
    if (!found) return undefined;
    if (this.connectionRequestPolicies.length > 0) {
      const matched = this.connectionRequestPolicies.some(
        p => this.matchesConnectionRequestPolicy(p.conditions, found.groups, context?.nasIp),
      );
      if (!matched) return undefined;
    }
    const policy = this.policies.find(p => found.groups.some(g => g.toLowerCase() === p.group.toLowerCase()));
    if (!policy) return undefined;
    const replyAttributes: RadiusAttribute[] = [];
    if (policy.vlanId !== undefined) {
      replyAttributes.push(
        attr('tunnel-type', 13), attr('tunnel-medium-type', 6),
        attr('tunnel-private-group-id', String(policy.vlanId)),
      );
    }
    if (policy.sessionTimeoutSec !== undefined) {
      replyAttributes.push(attr('session-timeout', policy.sessionTimeoutSec));
    }
    return { username, password: found.password, replyAttributes };
  }

  private lookupSam(username: string): { password: string; groups: string[] } | null {
    const userMgr = this.userStore.getUserManager();
    const password = userMgr.getPlaintextPassword(username);
    if (password === null) return null;
    return { password, groups: userMgr.getGroupsForUser(username).map(g => g.name) };
  }

  private lookupAd(username: string): { password: string; groups: string[] } | null {
    const store = this.userStore.getDirectoryStore();
    if (!store) return null;
    const user = store.getUser(username);
    if (!user) return null;
    return { password: user.password ?? '', groups: user.memberOf };
  }
}
