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
 * server usage this PRD targets.
 */

import type { EndHost } from '@/network/devices/EndHost';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPPacket, DHCP_OPTION } from '@/network/dhcp/DHCPPacket';
import { buildDhcpServerReply } from '@/network/dhcp/DhcpServerExchange';
import type { DHCPBinding } from '@/network/dhcp/types';
import type { DhcidRecordData } from '@/network/dns/wire/ResourceRecord';
import { RRType } from '@/network/dns/wire/RRType';
import {
  dhcidIdentityFromChaddr, dhcidIdentityFromClientId, dhcidMatches,
  DHCID_DIGEST_SHA256, computeDhcidDigest, type DhcidIdentity,
} from '@/network/dns/wire/Dhcid';
import {
  IPAddress, SubnetMask, MACAddress, createIPv4Packet, ETHERTYPE_IPV4, IP_PROTO_UDP,
  type UDPPacket,
} from '@/network/core/types';

export interface DhcpOpResult { ok: boolean; message: string }

export interface DhcpScopeInfo {
  scopeId: string;
  name: string;
  startRange: string;
  endRange: string;
  subnetMask: string;
  leaseDuration: number;
  state: 'Active' | 'Inactive';
}

export type DhcpDynamicUpdatePolicy = 'Always' | 'Never' | 'OnClientRequest';

export interface DhcpDnsSettings {
  dynamicUpdates: DhcpDynamicUpdatePolicy;
  deleteDnsRRonLeaseExpiry: boolean;
  updateDnsRRForOlderClients: boolean;
  nameProtection: boolean;
}

export interface DhcpDnsRegistrar {
  applyDynamicARecord(zoneName: string, fqdnName: string, ipv4: string, ttl?: number): { ok: boolean; message: string };
  applyDynamicPtrRecord(ipv4: string, fqdnName: string, ttl?: number): { ok: boolean; message: string };
  removeDynamicPtrRecord(ipv4: string): { ok: boolean; message: string };
  removeDynamicRecord(zoneName: string, fqdnName: string, type: string): { ok: boolean; message: string };
  readDhcid(zoneName: string, fqdnName: string): DhcidRecordData | null;
  writeDhcid(zoneName: string, fqdnName: string, data: DhcidRecordData, ttl?: number): { ok: boolean; message: string };
}

export interface DhcpLeaseInfo {
  ipAddress: string;
  clientId: string;
  scopeName: string;
  scopeId: string;
  leaseExpiration: number;
  type: 'automatic' | 'manual';
}

const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;

function bindingToLease(binding: DHCPBinding, scopeId: string): DhcpLeaseInfo {
  return {
    ipAddress: binding.ipAddress, clientId: binding.clientId,
    scopeName: binding.poolName, scopeId, leaseExpiration: binding.leaseExpiration,
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
  private registeredDnsName: string | null = null;
  private dnsRegistrar: DhcpDnsRegistrar | null = null;
  private dnsSettings: DhcpDnsSettings = {
    dynamicUpdates: 'OnClientRequest',
    deleteDnsRRonLeaseExpiry: true,
    updateDnsRRForOlderClients: false,
    nameProtection: false,
  };
  private readonly registeredRecords = new Map<string, { zone: string; fqdn: string; forward: boolean; reverse: boolean }>();
  private registeredIpAddress: string | null = null;

  constructor(private readonly host: EndHost) {
    this.engine.setPingPacketCount(0);
    this.engine.setEventBus(host.getBus());
  }

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
  authorizeInDC(dnsName?: string, ipAddress?: string): DhcpOpResult {
    this.authorized = true;
    if (dnsName) this.registeredDnsName = dnsName;
    if (ipAddress) this.registeredIpAddress = ipAddress;
    return { ok: true, message: '' };
  }

  attachDnsRegistrar(registrar: DhcpDnsRegistrar | null): void {
    this.dnsRegistrar = registrar;
  }

  getConflictDetectionAttempts(): number { return this.engine.getPingPacketCount(); }

  setConflictDetectionAttempts(attempts: number): DhcpOpResult {
    if (!Number.isInteger(attempts) || attempts < 0 || attempts > 6) {
      return {
        ok: false,
        message: "Cannot validate argument on parameter 'ConflictDetectionAttempts'. "
          + `The ${attempts} argument is greater than the maximum allowed range of 6. `
          + 'Supply an argument that is less than or equal to 6 and then try the command again.',
      };
    }
    this.engine.setPingPacketCount(attempts);
    return { ok: true, message: '' };
  }

  getDnsSettings(): DhcpDnsSettings {
    return { ...this.dnsSettings };
  }

  setDnsSettings(changes: Partial<DhcpDnsSettings>): DhcpOpResult {
    const next = { ...this.dnsSettings, ...changes };
    if (next.dynamicUpdates === 'Never' && changes.deleteDnsRRonLeaseExpiry === true) {
      return {
        ok: false,
        message: 'DeleteDnsRROnLeaseExpiry can only be set when DynamicUpdates is Always or OnClientRequest.',
      };
    }
    this.dnsSettings = next;
    return { ok: true, message: '' };
  }

  registeredIdentity(): { dnsName: string | null; ipAddress: string | null } {
    return { dnsName: this.registeredDnsName, ipAddress: this.registeredIpAddress };
  }

  /** An unauthorized DHCP server in a domain never leases addresses — real Windows shuts down leasing (Event 1042) rather than refusing the cmdlet calls that configure it. */
  isAuthorizedInDC(): boolean { return !this.domainExists || this.authorized; }

  isRegisteredInDC(): boolean { return this.authorized; }

  revokeInDC(): DhcpOpResult {
    this.authorized = false;
    this.registeredDnsName = null;
    this.registeredIpAddress = null;
    return { ok: true, message: '' };
  }

  private readonly handleDatagram = (dgram: { inPort: string; udp: UDPPacket }): void => {
    if (!this.isAuthorizedInDC()) return;
    const pkt = dgram.udp.payload;
    if (!(pkt instanceof DHCPPacket) || pkt.op !== 1) return;
    this.serveOnWire(dgram.inPort, pkt);
  };

  private adoptServerIdentifierOf(inPort: string): void {
    const own = this.host.getPorts().find(p => p.getName() === inPort)?.getIPAddress()?.toString();
    if (own && own !== '0.0.0.0') this.engine.setServerIdentifier(own);
  }

  listBindings(): Array<{ interfaceAlias: string; ipAddress: string; subnetMask: string; bindingState: boolean }> {
    return this.host.getPorts()
      .filter(p => !!p.getIPAddress())
      .map(p => ({
        interfaceAlias: p.getName(),
        ipAddress: p.getIPAddress()!.toString(),
        subnetMask: p.getSubnetMask()?.toString() ?? '',
        bindingState: !p.isAdminDown() && this.running,
      }));
  }

  private ownAddresses(): string[] {
    return this.host.getPorts()
      .map(p => p.getIPAddress()?.toString())
      .filter((ip): ip is string => !!ip);
  }

  private serveOnWire(inPort: string, pkt: DHCPPacket): void {
    this.adoptServerIdentifierOf(inPort);
    this.engine.setServerOwnedAddresses(this.ownAddresses());
    if (pkt.getMessageType() === 'DHCPRELEASE') this.withdrawDnsFor(pkt.ciaddr);
    const relayAgent = pkt.giaddr !== '0.0.0.0' ? pkt.giaddr : undefined;
    const reply = buildDhcpServerReply(pkt, {
      server: this.engine,
      localGatewayIP: this.host.getPorts().find(p => p.getName() === inPort)?.getIPAddress()?.toString(),
      isAddressInUse: (ip) => this.host.addressAnswersOnLink(inPort, new IPAddress(ip)),
    });
    if (!reply) return;
    this.syncDnsForExchange(pkt, reply);
    reply.giaddr = pkt.giaddr;
    if (relayAgent) this.sendReplyToRelay(relayAgent, reply);
    else this.sendReply(inPort, reply);
  }

  private zoneForLeasedAddress(ip: string): string | null {
    const poolName = this.engine.getBindings().get(ip)?.poolName;
    if (!poolName) return null;
    const domain = this.engine.getPool(poolName)?.domainName;
    return domain ? domain : null;
  }

  private clientDhcidIdentity(request: DHCPPacket): DhcidIdentity {
    const clientId = request.getOption(DHCP_OPTION.CLIENT_IDENTIFIER);
    if (typeof clientId === 'string' && clientId.length > 0) {
      return dhcidIdentityFromClientId(clientId);
    }
    return dhcidIdentityFromChaddr(request.chaddr);
  }

  private nameIsProtectedFromClient(
    zone: string, fqdn: string, identity: DhcidIdentity,
  ): boolean {
    if (!this.dnsSettings.nameProtection || !this.dnsRegistrar) return false;
    const held = this.dnsRegistrar.readDhcid(zone, fqdn);
    if (!held) return false;
    const mine: DhcidRecordData = {
      type: held.type, identifierType: identity.identifierType,
      digestType: DHCID_DIGEST_SHA256, digest: computeDhcidDigest(identity, fqdn),
    };
    return !dhcidMatches(held, mine);
  }

  private syncDnsForExchange(request: DHCPPacket, reply: DHCPPacket): void {
    if (!this.dnsRegistrar) return;
    if (reply.getMessageType() !== 'DHCPACK') return;
    if (this.dnsSettings.dynamicUpdates === 'Never') return;

    const fqdnOption = request.getOption(DHCP_OPTION.CLIENT_FQDN) as
      { flags: number; name: string } | undefined;
    if (fqdnOption && (fqdnOption.flags & 0x08) !== 0) return;
    if (!fqdnOption && !this.dnsSettings.updateDnsRRForOlderClients) return;

    const declaredName = String(
      request.getOption(DHCP_OPTION.HOST_NAME) ?? fqdnOption?.name ?? '',
    ).trim();
    if (!declaredName) return;

    const zone = this.zoneForLeasedAddress(reply.yiaddr);
    if (!zone) return;
    const label = declaredName.split('.')[0];
    const fqdn = `${label}.${zone}`;

    const identity = this.clientDhcidIdentity(request);
    if (this.nameIsProtectedFromClient(zone, fqdn, identity)) return;

    const clientKeepsItsOwnForward = !!fqdnOption && (fqdnOption.flags & 0x01) === 0;
    const updatesForward = this.dnsSettings.dynamicUpdates === 'Always'
      || !clientKeepsItsOwnForward;

    let forward = false;
    if (updatesForward && this.dnsRegistrar.applyDynamicARecord(zone, fqdn, reply.yiaddr).ok) {
      forward = true;
      if (this.dnsSettings.nameProtection) {
        this.dnsRegistrar.writeDhcid(zone, fqdn, {
          type: RRType.DHCID, identifierType: identity.identifierType,
          digestType: DHCID_DIGEST_SHA256, digest: computeDhcidDigest(identity, fqdn),
        });
      }
    }
    const reverse = this.dnsRegistrar.applyDynamicPtrRecord(reply.yiaddr, fqdn).ok;

    if (forward || reverse) {
      this.registeredRecords.set(reply.yiaddr, { zone, fqdn, forward, reverse });
    }
  }

  private withdrawDnsFor(ip: string): void {
    if (!this.dnsSettings.deleteDnsRRonLeaseExpiry) return;
    const record = this.registeredRecords.get(ip);
    if (!record || !this.dnsRegistrar) return;
    if (record.forward) {
      this.dnsRegistrar.removeDynamicRecord(record.zone, record.fqdn, 'A');
      if (this.dnsSettings.nameProtection) {
        this.dnsRegistrar.removeDynamicRecord(record.zone, record.fqdn, 'DHCID');
      }
    }
    if (record.reverse) this.dnsRegistrar.removeDynamicPtrRecord(ip);
    this.registeredRecords.delete(ip);
  }

  private sendReplyToRelay(relayAgent: string, reply: DHCPPacket): void {
    const sent = this.host.sendUdpDatagram(
      new IPAddress(relayAgent), DHCP_SERVER_PORT, DHCP_SERVER_PORT, reply, 300,
    );
    if (sent) return;
    this.host.getBus().publish({
      topic: 'dhcp.server.reply-undeliverable',
      payload: {
        deviceId: this.host.getId(), hostname: this.host.getHostname(),
        relayAgent, clientMac: reply.chaddr, offeredIp: reply.yiaddr,
        reason: 'no-route-to-relay',
      },
    });
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

  private resolveScopeKey(idOrName: string): string {
    if (this.engine.getPool(idOrName)) return idOrName;
    for (const [poolName, pool] of this.engine.getAllPools()) {
      if (pool.network === idOrName) return poolName;
    }
    return idOrName;
  }

  private scopeIdOfPool(poolName: string): string {
    return this.engine.getPool(poolName)?.network ?? '';
  }

  getScope(idOrName: string): DhcpScopeInfo | null {
    const name = this.resolveScopeKey(idOrName);
    const pool = this.engine.getPool(name);
    if (!pool) return null;
    const range = this.scopeRanges.get(name);
    return {
      scopeId: pool.network ?? '',
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

  addReservation(scopeIdOrName: string, ipAddress: string, clientId: string): DhcpOpResult {
    const scopeName = this.resolveScopeKey(scopeIdOrName);
    if (!this.engine.getPool(scopeName)) {
      return { ok: false, message: `Add-DhcpServerv4Reservation : ScopeId "${scopeName}" does not exist on this DHCP server.` };
    }
    const result = this.engine.addStaticBinding(scopeName, clientId, ipAddress);
    if (!result.ok) return { ok: false, message: `Add-DhcpServerv4Reservation : ${result.error ?? 'unable to add reservation'}` };
    return { ok: true, message: '' };
  }

  // ─── Options (Set-DhcpServerv4OptionValue) ──────────────────────────

  setOptionValue(scopeIdOrName: string | undefined, optionId: number, values: string[]): DhcpOpResult {
    const scopeName = scopeIdOrName === undefined ? undefined : this.resolveScopeKey(scopeIdOrName);
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

  getLeases(scopeIdOrName?: string): DhcpLeaseInfo[] {
    const scopeName = scopeIdOrName === undefined ? undefined : this.resolveScopeKey(scopeIdOrName);
    const all = [...this.engine.getBindings().values()]
      .map(b => bindingToLease(b, this.scopeIdOfPool(b.poolName)));
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

  listReservations(scopeIdOrName?: string): Array<{ scopeName: string; ipAddress: string; clientId: string }> {
    const scopeName = scopeIdOrName === undefined ? undefined : this.resolveScopeKey(scopeIdOrName);
    const scopes = scopeName ? [scopeName] : [...this.engine.getAllPools().keys()];
    const out: Array<{ scopeName: string; ipAddress: string; clientId: string }> = [];
    for (const scope of scopes) {
      for (const b of this.engine.getStaticBindings(scope)) {
        out.push({ scopeName: scope, ipAddress: b.ipAddress, clientId: b.clientId });
      }
    }
    return out;
  }

  removeReservation(scopeIdOrName: string, ipAddress: string): DhcpOpResult {
    const scopeName = this.resolveScopeKey(scopeIdOrName);
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

  hasScope(scopeIdOrName: string): boolean {
    return this.engine.getPool(this.resolveScopeKey(scopeIdOrName)) !== undefined;
  }

  listOptionValues(scopeIdOrName?: string): Array<{ optionId: number; name: string; values: string[] }> {
    const scopeName = scopeIdOrName === undefined ? undefined : this.resolveScopeKey(scopeIdOrName);
    const source = scopeName
      ? this.scopeOptions.get(scopeName) ?? new Map<number, string[]>()
      : this.serverOptions;
    const merged = new Map<number, string[]>();
    if (scopeName) for (const [id, v] of this.serverOptions) merged.set(id, v);
    for (const [id, v] of source) merged.set(id, v);
    return [...merged].sort((a, b) => a[0] - b[0])
      .map(([optionId, values]) => ({ optionId, name: OPTION_NAMES[optionId] ?? `Option ${optionId}`, values }));
  }

  removeOptionValue(scopeIdOrName: string | undefined, optionId: number): DhcpOpResult {
    const scopeName = scopeIdOrName === undefined ? undefined : this.resolveScopeKey(scopeIdOrName);
    const store = scopeName ? this.scopeOptions.get(scopeName) : this.serverOptions;
    if (!store || !store.delete(optionId)) {
      return { ok: false, message: `Remove-DhcpServerv4OptionValue : Option ID ${optionId} is not configured.` };
    }
    this.projectOptions();
    return { ok: true, message: '' };
  }

  scopeStatistics(scopeIdOrName: string): { total: number; inUse: number; free: number; percentInUse: number } | null {
    const scopeName = this.resolveScopeKey(scopeIdOrName);
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
