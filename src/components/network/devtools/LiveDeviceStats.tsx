/**
 * LiveDeviceStats — a developer panel that displays the reactive state of
 * the selected device live, sourced from the Phase 5 / Phase 6 hooks.
 *
 * Demonstrates that the read-model architecture works end-to-end: a single
 * React component pulls data from EndHost + Router + OSPF + IPSec + NAT +
 * DHCP via the bus-driven signal store, without ever touching `Equipment`
 * instances directly.
 *
 * Intentionally untouched by the existing UI — this is opt-in for now
 * (Phase 6 §6.7.5 progressive migration).
 */

import { useMemo } from 'react';
import {
  useDevice,
  useArpTable, useNdpTable, useHostRoutingTable,
  useTcpListeners, useTcpConnections, useHostStats,
  useOspfNeighbors, useOspfRuntime,
  useIPSecStats, useNatStats,
  useDhcpClientStats, useDhcpServerStats,
} from '@/react/hooks';

interface LiveDeviceStatsProps {
  /** id of the device whose state to display. */
  deviceId: string;
  /** Optional className for outer container. */
  className?: string;
}

interface SectionProps {
  title: string;
  empty?: boolean;
  children: React.ReactNode;
}

function Section({ title, empty, children }: SectionProps) {
  return (
    <div className="rounded border border-white/10 bg-black/30 p-2">
      <div className="text-xs font-semibold uppercase tracking-wider text-white/60">
        {title}
      </div>
      {empty ? (
        <div className="mt-1 text-xs text-white/40">(empty)</div>
      ) : (
        <div className="mt-1 text-xs text-white/90">{children}</div>
      )}
    </div>
  );
}

export function LiveDeviceStats({ deviceId, className }: LiveDeviceStatsProps) {
  const device = useDevice(deviceId);

  // Host-side signals (LinuxPC / WindowsPC / LinuxServer)
  const arp = useArpTable(deviceId);
  const ndp = useNdpTable(deviceId);
  const routes = useHostRoutingTable(deviceId);
  const listeners = useTcpListeners(deviceId);
  const conns = useTcpConnections(deviceId);
  const hostStats = useHostStats(deviceId);

  // Router-side engine signals — these return their EMPTY fallback when
  // the device is an EndHost or when the engine isn't configured.
  const ospfNeighbors = useOspfNeighbors(deviceId);
  const ospfRuntime = useOspfRuntime(deviceId);
  const ipsec = useIPSecStats(deviceId);
  const nat = useNatStats(deviceId);

  // DHCP works on both ends — client for hosts, server for routers.
  const dhcpClient = useDhcpClientStats(deviceId);
  const dhcpServer = useDhcpServerStats(deviceId);

  const arpRows = useMemo(
    () => arp.map((e) => `${e.ip.padEnd(15)} ${e.mac} ${e.iface}`),
    [arp],
  );
  const routeRows = useMemo(
    () => routes.map((r) => `${r.destination}/${r.mask} via ${r.gateway ?? 'direct'} dev ${r.iface}`),
    [routes],
  );

  if (!device) {
    return (
      <div className={className ?? ''}>
        <div className="text-sm text-white/70">No device selected.</div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 text-white ${className ?? ''}`}>
      <div>
        <div className="text-sm font-medium">{device.name}</div>
        <div className="text-xs text-white/50">
          {device.type} · {device.poweredOn ? 'on' : 'off'}
        </div>
      </div>

      <Section title="Host stats">
        ARP cache: {hostStats.arpCacheSize} · NDP: {hostStats.ndpCacheSize}
        {' '}· Routes: {hostStats.routeCount}
        <br />
        ICMP sent: {hostStats.icmpEchosSent} · recv: {hostStats.icmpEchosReceived}
        {' '}· timeouts: {hostStats.icmpTimeouts}
      </Section>

      <Section title="ARP table" empty={arp.length === 0}>
        <pre className="whitespace-pre font-mono leading-tight">
          {arpRows.join('\n')}
        </pre>
      </Section>

      <Section title="NDP cache" empty={ndp.length === 0}>
        <pre className="whitespace-pre font-mono leading-tight">
          {ndp.map((e) => `${e.ip} ${e.mac} ${e.iface}`).join('\n')}
        </pre>
      </Section>

      <Section title="Routing table" empty={routes.length === 0}>
        <pre className="whitespace-pre font-mono leading-tight">
          {routeRows.join('\n')}
        </pre>
      </Section>

      <Section title={`TCP listeners (${listeners.length})`} empty={listeners.length === 0}>
        {listeners.map((l) => `${l.ip}:${l.port}`).join(', ')}
      </Section>

      <Section title={`TCP connections (${conns.length})`} empty={conns.length === 0}>
        {conns.map((c) => `${c.localIp}:${c.localPort}↔${c.remoteIp}:${c.remotePort} (${c.side})`).join('\n')}
      </Section>

      <Section title="OSPF" empty={!ospfRuntime.running}>
        SPF runs: {ospfRuntime.spfRuns} · neighbor changes: {ospfRuntime.neighborChanges}
        <br />
        Neighbors: {ospfNeighbors.length}
      </Section>

      <Section title="IPSec" empty={!ipsec.running}>
        IKE SAs: {ipsec.activeIkeSAs} · IPSec SAs: {ipsec.activeIPSecSAs}
        <br />
        in OK/drop: {ipsec.inboundProcessed}/{ipsec.inboundDropped}
        {' '}· out OK/drop: {ipsec.outboundProcessed}/{ipsec.outboundDropped}
      </Section>

      <Section title="NAT" empty={nat.sessionCount === 0}>
        Sessions: {nat.sessionCount} (TCP est {nat.tcpEstablished})
        <br />
        hits: {nat.hits} · misses: {nat.misses} · expired: {nat.expired}
      </Section>

      <Section title="DHCP client" empty={!dhcpClient.running}>
        Bound: {dhcpClient.boundCount}/{dhcpClient.ifaceCount}
        <br />
        DISCOVER {dhcpClient.discoversSent} · OFFER {dhcpClient.offersReceived}
        {' '}· REQUEST {dhcpClient.requestsSent} · ACK {dhcpClient.acksReceived}
      </Section>

      <Section title="DHCP server" empty={!dhcpServer.running}>
        Pools: {dhcpServer.poolCount} · active leases: {dhcpServer.activeLeases}
        {' '}· reservations: {dhcpServer.reservationsCount}
      </Section>
    </div>
  );
}
