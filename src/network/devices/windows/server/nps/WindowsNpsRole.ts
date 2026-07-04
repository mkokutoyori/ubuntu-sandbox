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
import { RadiusServerAgent, type RadiusServerHost } from '@/network/radius/RadiusServerAgent';
import { attr, type RadiusUser, type RadiusAttribute } from '@/network/radius/types';
import { getDefaultEventBus } from '@/events/EventBus';
import { IPAddress } from '@/network/core/types';
import type { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';
import type { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import type { PSEventLogProvider } from '@/network/devices/windows/PSEventLogProvider';

export interface NpsOpResult { ok: boolean; message: string }
export interface NasClientInfo { name: string; ipAddress: string }
export interface NetworkPolicyInfo { name: string; group: string; vlanId?: number; sessionTimeoutSec?: number }

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
  private running = false;
  private unsubscribeAuditLog: (() => void) | null = null;

  constructor(
    private readonly host: EndHost,
    private readonly userStore: NpsUserStore,
    private readonly eventLog: PSEventLogProvider,
  ) {
    const radiusHost: RadiusServerHost = {
      id: host.getId(), name: host.getName(),
      getHostname: () => host.getHostname(),
      getPort: (n: string) => host.getPort(n),
      getPorts: () => host.getPorts(),
      sendFrame: (p: string, f) => { host.sendFrame(p, f); },
    };
    this.agent = new RadiusServerAgent(radiusHost, () => getDefaultEventBus());
    this.agent.setUserResolver((username) => this.resolveUser(username));
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
    this.unsubscribeAuditLog = getDefaultEventBus().subscribe('radius.packet.sent', (e) => {
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
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.host.udpClose(RADIUS_AUTH_PORT);
    this.host.udpClose(RADIUS_ACCT_PORT);
    this.agent.stop();
    this.unsubscribeAuditLog?.();
    this.unsubscribeAuditLog = null;
    this.running = false;
  }

  // ─── NAS clients (New-NpsRadiusClient / netsh nps add client) ───────

  addNasClient(name: string, ipAddress: string, sharedSecret: string): NpsOpResult {
    if (this.nasClients.has(name)) {
      return { ok: false, message: `New-NpsRadiusClient : A RADIUS client named "${name}" already exists.` };
    }
    this.nasClients.set(name, { name, ipAddress });
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

  // ─── User resolution — RadiusServerAgent.setUserResolver hook ───────

  private resolveUser(username: string): RadiusUser | undefined {
    const sam = this.lookupSam(username);
    const found = sam ?? this.lookupAd(username);
    if (!found) return undefined;
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
