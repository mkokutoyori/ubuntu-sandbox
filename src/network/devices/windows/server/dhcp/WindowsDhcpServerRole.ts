/**
 * WindowsDhcpServerRole — hosts the real DHCP engine (`src/network/dhcp/
 * DHCPServer.ts`) as the "DHCP Server" Windows role (PRD-Windows-Server.md
 * §5 P8): genuine DISCOVER/OFFER/REQUEST/ACK-NAK exchanges over real UDP
 * port 67/68, serving real Windows/Linux clients on the lab network. No
 * lease/allocation logic is reimplemented here (per PRD §4 "réutilisation
 * stricte des moteurs") — this is a thin Windows-flavored façade (scope/
 * exclusion/reservation/option CRUD + wire glue) around that engine, the
 * same pattern `WindowsDnsServerRole` established for the DNS role.
 *
 * Scope, matching the PRD's explicit `DhcpServer` cmdlet surface: IPv4
 * scopes only (no DHCPv6, no failover/split-scope). Exclusion ranges are
 * applied on the engine's single global excluded-address list (mirroring
 * Cisco `ip dhcp excluded-address`'s own global scope) rather than being
 * tracked per-Windows-scope — acceptable for the lab's single-scope-per-
 * server usage this PRD targets. No relay-agent (giaddr) forwarding: this
 * role serves only directly-attached clients on the host's own segments,
 * unlike `Router`'s DHCP relay/helper-address machinery.
 */

import type { EndHost } from '@/network/devices/EndHost';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import type { DHCPBinding } from '@/network/dhcp/types';
import {
  IPAddress, SubnetMask, MACAddress, createIPv4Packet, ETHERTYPE_IPV4, IP_PROTO_UDP,
  type UDPPacket,
} from '@/network/core/types';

export interface DhcpOpResult { ok: boolean; message: string }

export interface DhcpScopeInfo {
  name: string;
  startRange: string;
  endRange: string;
  subnetMask: string;
  leaseDuration: number;
  state: 'Active' | 'Inactive';
}

export interface DhcpLeaseInfo {
  ipAddress: string;
  clientId: string;
  scopeName: string;
  leaseExpiration: number;
  type: 'automatic' | 'manual';
}

const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;

function bindingToLease(binding: DHCPBinding): DhcpLeaseInfo {
  return {
    ipAddress: binding.ipAddress, clientId: binding.clientId,
    scopeName: binding.poolName, leaseExpiration: binding.leaseExpiration,
    type: binding.type,
  };
}

export class WindowsDhcpServerRole {
  private readonly engine = new DHCPServer();
  private readonly scopeRanges = new Map<string, { start: string; end: string }>();
  private readonly scopeState = new Map<string, boolean>();
  private readonly serverOptions = new Map<number, string[]>();
  private readonly scopeOptions = new Map<string, Map<number, string[]>>();
  private running = false;
  private domainExists = false;
  private authorized = false;

  constructor(private readonly host: EndHost) {}

  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.engine.enable();
    this.host.udpBind(DHCP_SERVER_PORT, this.handleDatagram, 'dhcpserver');
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.host.udpClose(DHCP_SERVER_PORT);
    this.engine.disable();
    this.running = false;
  }

  /** Called by `WindowsServer.getDhcpServerRole()` every access, since domain membership can change after the role starts. */
  setDomainContext(domainExists: boolean): void { this.domainExists = domainExists; }

  /** `Add-DhcpServerInDC` — simulated AD authorization (PRD §5 P8: "autorisation AD simulée (flag) quand un domaine existe"). */
  authorizeInDC(): DhcpOpResult {
    this.authorized = true;
    return { ok: true, message: '' };
  }

  /** An unauthorized DHCP server in a domain never leases addresses — real Windows shuts down leasing (Event 1042) rather than refusing the cmdlet calls that configure it. */
  isAuthorizedInDC(): boolean { return !this.domainExists || this.authorized; }

  isRegisteredInDC(): boolean { return this.authorized; }

  revokeInDC(): DhcpOpResult {
    this.authorized = false;
    return { ok: true, message: '' };
  }

  private readonly handleDatagram = (dgram: { inPort: string; udp: UDPPacket }): void => {
    if (!this.isAuthorizedInDC()) return;
    const pkt = dgram.udp.payload;
    if (!(pkt instanceof DHCPPacket) || pkt.op !== 1) return;
    this.serveOnWire(dgram.inPort, pkt);
  };

  private serveOnWire(inPort: string, pkt: DHCPPacket): void {
    const type = pkt.getMessageType();
    let reply: DHCPPacket | null = null;
    if (type === 'DHCPDISCOVER') {
      const localGatewayIP = this.host.getPorts().find(p => p.getName() === inPort)?.getIPAddress()?.toString();
      const offer = this.engine.processDiscover({
        clientMAC: pkt.chaddr, xid: pkt.xid, clientIdentifier: pkt.chaddr,
        parameterRequestList: [], localGatewayIP,
      });
      if (!offer) return;
      reply = DHCPPacket.createOffer(pkt.chaddr, pkt.xid, offer.ip, offer.serverIdentifier, {
        mask: offer.pool.mask ?? '255.255.255.0', router: offer.pool.defaultRouter ?? '0.0.0.0',
        dns: offer.pool.dnsServers, domainName: offer.pool.domainName ?? undefined,
        leaseDuration: offer.pool.leaseDuration ?? 86400,
        renewalTime: offer.renewalTime, rebindingTime: offer.rebindingTime,
      });
    } else if (type === 'DHCPREQUEST') {
      const requested = String(pkt.getOption(50) ?? pkt.ciaddr);
      const serverId = String(pkt.getOption(54) ?? '');
      const result = this.engine.processRequestWithNak({
        clientMAC: pkt.chaddr, xid: pkt.xid,
        requestedIP: requested, clientIdentifier: pkt.chaddr, serverIdentifier: serverId,
      });
      if (!result) return;
      if (result.type === 'NAK' || !result.binding) {
        reply = DHCPPacket.createNak(pkt.chaddr, pkt.xid, result.serverIdentifier,
          result.message ?? 'requested address not available');
      } else {
        const pool = this.engine.getPool(result.binding.poolName);
        reply = DHCPPacket.createAck(pkt.chaddr, pkt.xid, result.binding.ipAddress, result.serverIdentifier, {
          mask: pool?.mask ?? '255.255.255.0', router: pool?.defaultRouter ?? '0.0.0.0',
          dns: pool?.dnsServers ?? [], domainName: pool?.domainName ?? undefined,
          leaseDuration: pool?.leaseDuration ?? 86400,
          renewalTime: pool?.renewalTime, rebindingTime: pool?.rebindingTime,
        });
      }
    } else if (type === 'DHCPDECLINE') {
      this.engine.processDecline({
        clientMAC: pkt.chaddr, declinedIP: String(pkt.getOption(50) ?? ''),
        serverIdentifier: String(pkt.getOption(54) ?? ''), clientIdentifier: pkt.chaddr,
      });
      return;
    } else if (type === 'DHCPRELEASE') {
      this.engine.processRelease({
        clientMAC: pkt.chaddr, clientIP: pkt.ciaddr,
        serverIdentifier: String(pkt.getOption(54) ?? ''), clientIdentifier: pkt.chaddr,
      });
      return;
    }
    if (!reply) return;
    this.sendReply(inPort, reply);
  }

  private sendReply(inPort: string, reply: DHCPPacket): void {
    const port = this.host.getPorts().find(p => p.getName() === inPort);
    const srcIp = port?.getIPAddress();
    if (!port || !srcIp) return;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: DHCP_SERVER_PORT, destinationPort: DHCP_CLIENT_PORT,
      length: 8 + 300, checksum: 0, payload: reply,
    };
    const ipPkt = createIPv4Packet(srcIp, new IPAddress('255.255.255.255'), IP_PROTO_UDP, 64, udp, 8 + 300);
    this.host.sendFrame(inPort, {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });
  }

  // ─── Scopes (Add-DhcpServerv4Scope / Get-DhcpServerv4Scope) ─────────

  addScope(name: string, startRange: string, endRange: string, subnetMask: string, leaseDurationSeconds?: number): DhcpOpResult {
    if (this.engine.getPool(name)) {
      return { ok: false, message: `Add-DhcpServerv4Scope : A scope with the name or ID "${name}" already exists on this DHCP server.` };
    }
    const mask = new SubnetMask(subnetMask);
    const network = new IPAddress(startRange).networkAddress(mask).toString();
    this.engine.createPool(name);
    this.engine.configurePoolNetwork(name, network, subnetMask);
    if (leaseDurationSeconds) this.engine.configurePoolLease(name, leaseDurationSeconds);
    this.scopeRanges.set(name, { start: startRange, end: endRange });
    this.scopeState.set(name, true);
    this.excludeOutsideRange(network, mask, startRange, endRange);
    this.projectOptions();
    return { ok: true, message: '' };
  }

  /** Confines allocation to [startRange, endRange] by excluding the rest of the subnet's host range. */
  private excludeOutsideRange(network: string, mask: SubnetMask, start: string, end: string): void {
    const networkNum = new IPAddress(network).toUint32();
    const broadcastNum = (networkNum | (~mask.toUint32() >>> 0)) >>> 0;
    const startNum = new IPAddress(start).toUint32();
    const endNum = new IPAddress(end).toUint32();
    if (startNum > networkNum + 1) {
      this.engine.addExcludedRange(IPAddress.fromUint32(networkNum + 1).toString(), IPAddress.fromUint32(startNum - 1).toString());
    }
    if (endNum < broadcastNum - 1) {
      this.engine.addExcludedRange(IPAddress.fromUint32(endNum + 1).toString(), IPAddress.fromUint32(broadcastNum - 1).toString());
    }
  }

  getScope(name: string): DhcpScopeInfo | null {
    const pool = this.engine.getPool(name);
    if (!pool) return null;
    const range = this.scopeRanges.get(name);
    return {
      name: pool.name, startRange: range?.start ?? '', endRange: range?.end ?? '',
      subnetMask: pool.mask ?? '', leaseDuration: pool.leaseDuration,
      state: this.scopeState.get(name) === false ? 'Inactive' : 'Active',
    };
  }

  listScopes(): DhcpScopeInfo[] {
    return [...this.engine.getAllPools().keys()]
      .map(name => this.getScope(name))
      .filter((s): s is DhcpScopeInfo => s !== null);
  }

  // ─── Exclusions (Add-DhcpServerv4ExclusionRange) ────────────────────

  addExclusionRange(startRange: string, endRange: string): DhcpOpResult {
    this.engine.addExcludedRange(startRange, endRange);
    return { ok: true, message: '' };
  }

  // ─── Reservations (Add-DhcpServerv4Reservation) ─────────────────────

  addReservation(scopeName: string, ipAddress: string, clientId: string): DhcpOpResult {
    if (!this.engine.getPool(scopeName)) {
      return { ok: false, message: `Add-DhcpServerv4Reservation : ScopeId "${scopeName}" does not exist on this DHCP server.` };
    }
    const result = this.engine.addStaticBinding(scopeName, clientId, ipAddress);
    if (!result.ok) return { ok: false, message: `Add-DhcpServerv4Reservation : ${result.error ?? 'unable to add reservation'}` };
    return { ok: true, message: '' };
  }

  // ─── Options (Set-DhcpServerv4OptionValue) ──────────────────────────

  setOptionValue(scopeName: string | undefined, optionId: number, values: string[]): DhcpOpResult {
    if (scopeName !== undefined && !this.engine.getPool(scopeName)) {
      return { ok: false, message: `Set-DhcpServerv4OptionValue : ScopeId "${scopeName}" does not exist on this DHCP server.` };
    }
    if (!ALL_OPTION_IDS.includes(optionId)) {
      return { ok: false, message: `Set-DhcpServerv4OptionValue : Option ID ${optionId} is not supported.` };
    }
    if (scopeName === undefined) {
      this.serverOptions.set(optionId, values);
    } else {
      const own = this.scopeOptions.get(scopeName) ?? new Map<number, string[]>();
      own.set(optionId, values);
      this.scopeOptions.set(scopeName, own);
    }
    this.projectOptions();
    return { ok: true, message: '' };
  }

  // ─── Leases (Get-DhcpServerv4Lease) ──────────────────────────────────

  getLeases(scopeName?: string): DhcpLeaseInfo[] {
    const all = [...this.engine.getBindings().values()].map(bindingToLease);
    return scopeName ? all.filter(l => l.scopeName === scopeName) : all;
  }

  setScope(
    name: string,
    changes: { newName?: string; leaseDuration?: number; state?: 'Active' | 'Inactive' },
  ): DhcpOpResult {
    if (!this.engine.getPool(name)) {
      return { ok: false, message: `Set-DhcpServerv4Scope : ScopeId "${name}" does not exist on this DHCP server.` };
    }
    if (changes.leaseDuration !== undefined) {
      this.engine.configurePoolLease(name, changes.leaseDuration);
    }
    if (changes.state !== undefined) {
      const active = changes.state === 'Active';
      this.scopeState.set(name, active);
      this.engine.setPoolActive(name, active);
    }
    if (changes.newName !== undefined && changes.newName !== name) {
      const pool = this.engine.getPool(name);
      if (pool) pool.name = changes.newName;
    }
    return { ok: true, message: '' };
  }

  removeScope(name: string): DhcpOpResult {
    if (!this.engine.getPool(name)) {
      return { ok: false, message: `Remove-DhcpServerv4Scope : ScopeId "${name}" does not exist on this DHCP server.` };
    }
    for (const lease of this.getLeases(name)) this.engine.clearBinding(lease.ipAddress);
    this.engine.deletePool(name);
    this.scopeRanges.delete(name);
    this.scopeState.delete(name);
    this.scopeOptions.delete(name);
    return { ok: true, message: '' };
  }

  listExclusionRanges(): Array<{ start: string; end: string }> {
    return this.engine.getExcludedRanges().map(r => ({ start: r.start, end: r.end }));
  }

  removeExclusionRange(startRange: string, endRange: string): DhcpOpResult {
    return this.engine.removeExcludedRange(startRange, endRange)
      ? { ok: true, message: '' }
      : { ok: false, message: `Remove-DhcpServerv4ExclusionRange : The specified exclusion range does not exist.` };
  }

  listReservations(scopeName?: string): Array<{ scopeName: string; ipAddress: string; clientId: string }> {
    const scopes = scopeName ? [scopeName] : [...this.engine.getAllPools().keys()];
    const out: Array<{ scopeName: string; ipAddress: string; clientId: string }> = [];
    for (const scope of scopes) {
      for (const b of this.engine.getStaticBindings(scope)) {
        out.push({ scopeName: scope, ipAddress: b.ipAddress, clientId: b.clientId });
      }
    }
    return out;
  }

  removeReservation(scopeName: string, ipAddress: string): DhcpOpResult {
    if (!this.engine.removeStaticBinding(scopeName, ipAddress)) {
      return { ok: false, message: `Remove-DhcpServerv4Reservation : The reservation ${ipAddress} does not exist.` };
    }
    this.engine.clearBinding(ipAddress);
    return { ok: true, message: '' };
  }

  removeLease(ipAddress: string): DhcpOpResult {
    return this.engine.clearBinding(ipAddress)
      ? { ok: true, message: '' }
      : { ok: false, message: `Remove-DhcpServerv4Lease : The lease ${ipAddress} does not exist.` };
  }

  listOptionValues(scopeName?: string): Array<{ optionId: number; name: string; values: string[] }> {
    const source = scopeName
      ? this.scopeOptions.get(scopeName) ?? new Map<number, string[]>()
      : this.serverOptions;
    const merged = new Map<number, string[]>();
    if (scopeName) for (const [id, v] of this.serverOptions) merged.set(id, v);
    for (const [id, v] of source) merged.set(id, v);
    return [...merged].sort((a, b) => a[0] - b[0])
      .map(([optionId, values]) => ({ optionId, name: OPTION_NAMES[optionId] ?? `Option ${optionId}`, values }));
  }

  removeOptionValue(scopeName: string | undefined, optionId: number): DhcpOpResult {
    const store = scopeName ? this.scopeOptions.get(scopeName) : this.serverOptions;
    if (!store || !store.delete(optionId)) {
      return { ok: false, message: `Remove-DhcpServerv4OptionValue : Option ID ${optionId} is not configured.` };
    }
    this.projectOptions();
    return { ok: true, message: '' };
  }

  scopeStatistics(scopeName: string): { total: number; inUse: number; free: number; percentInUse: number } | null {
    const range = this.scopeRanges.get(scopeName);
    if (!range) return null;
    const start = new IPAddress(range.start).toUint32();
    const end = new IPAddress(range.end).toUint32();
    const total = Math.max(0, end - start + 1);
    const inUse = this.getLeases(scopeName).length;
    const free = Math.max(0, total - inUse);
    return { total, inUse, free, percentInUse: total === 0 ? 0 : Math.round((inUse / total) * 100) };
  }

  serverStatistics(): { scopes: number; totalAddresses: number; inUse: number; free: number } {
    let totalAddresses = 0;
    let inUse = 0;
    for (const name of this.engine.getAllPools().keys()) {
      const s = this.scopeStatistics(name);
      if (!s) continue;
      totalAddresses += s.total;
      inUse += s.inUse;
    }
    return {
      scopes: this.engine.getAllPools().size,
      totalAddresses, inUse, free: Math.max(0, totalAddresses - inUse),
    };
  }

  private projectOptions(): void {
    for (const name of this.engine.getAllPools().keys()) {
      const own = this.scopeOptions.get(name) ?? new Map<number, string[]>();
      for (const id of ALL_OPTION_IDS) {
        const values = own.get(id) ?? this.serverOptions.get(id);
        this.applyOption(name, id, values);
      }
    }
  }

  private applyOption(scope: string, optionId: number, values: string[] | undefined): void {
    switch (optionId) {
      case 3: this.engine.configurePoolRouter(scope, values?.[0] ?? null); break;
      case 6: this.engine.configurePoolDNS(scope, values ?? []); break;
      case 15: this.engine.configurePoolDomain(scope, values?.[0] ?? null); break;
      case 51: if (values?.[0]) this.engine.configurePoolLease(scope, Number(values[0])); break;
    }
  }
}

const OPTION_NAMES: Record<number, string> = {
  3: 'Router', 6: 'DNS Servers', 15: 'DNS Domain Name', 51: 'Lease',
};

const ALL_OPTION_IDS = [3, 6, 15, 51];
