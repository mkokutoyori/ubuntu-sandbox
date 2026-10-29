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

import { useLocale } from '@/i18n/useLocale';
import { useMemo } from 'react';
import {
  useDevice,
  useArpTable, useNdpTable, useHostRoutingTable,
  useTcpListeners, useTcpConnections, useHostStats,
  useOspfNeighbors, useOspfRuntime,
  useIPSecStats, useNatStats,
  useDhcpClientStats, useDhcpServerStats,
} from '@/react/hooks';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

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
  const { t } = useLocale();
  return (
    <div className="rounded border border-white/10 bg-black/30 p-2">
      <div className="text-xs font-semibold uppercase tracking-wider text-white/60">
        {title}
      </div>
      {empty ? (
        <div className="mt-1 text-xs text-white/40">{t('live.empty')}</div>
      ) : (
        <div className="mt-1 text-xs text-white/90">{children}</div>
      )}
    </div>
  );
}

export function LiveDeviceStats({ deviceId, className }: LiveDeviceStatsProps) {
  const { t } = useLocale();
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
    () => arp.map((e) => `${padToWidth(e.ip, 15)} ${e.mac} ${e.iface}`),
    [arp],
  );
  const routeRows = useMemo(
    () => routes.map((r) => `${r.destination}/${r.mask} via ${r.gateway ?? t('live.direct')} dev ${r.iface}`),
    [routes, t],
  );

  if (!device) {
    return (
      <div className={className ?? ''}>
        <div className="text-sm text-white/70">{t('live.noDevice')}</div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 text-white ${className ?? ''}`}>
      <div>
        <div className="text-sm font-medium">{device.name}</div>
        <div className="text-xs text-white/50">
          {device.type} · {device.poweredOn ? t('live.on') : t('live.off')}
        </div>
      </div>

      <Section title={t('live.hostStats')}>
        {t('live.hostCounts', { arp: hostStats.arpCacheSize, ndp: hostStats.ndpCacheSize, routes: hostStats.routeCount })}
        <br />
        {t('live.icmp', {
          sent: hostStats.icmpEchosSent, received: hostStats.icmpEchosReceived, timeouts: hostStats.icmpTimeouts,
        })}
      </Section>

      <Section title={t('live.arpTable')} empty={arp.length === 0}>
        <pre className="whitespace-pre font-mono leading-tight">
          {arpRows.join('\n')}
        </pre>
      </Section>

      <Section title={t('live.ndpCache')} empty={ndp.length === 0}>
        <pre className="whitespace-pre font-mono leading-tight">
          {ndp.map((e) => `${e.ip} ${e.mac} ${e.iface}`).join('\n')}
        </pre>
      </Section>

      <Section title={t('live.routingTable')} empty={routes.length === 0}>
        <pre className="whitespace-pre font-mono leading-tight">
          {routeRows.join('\n')}
        </pre>
      </Section>

      <Section title={t('live.tcpListeners', { count: listeners.length })} empty={listeners.length === 0}>
        {listeners.map((l) => `${l.ip}:${l.port}`).join(', ')}
      </Section>

      <Section title={t('live.tcpConnections', { count: conns.length })} empty={conns.length === 0}>
        {conns.map((c) => `${c.localIp}:${c.localPort}↔${c.remoteIp}:${c.remotePort} (${c.side})`).join('\n')}
      </Section>

      <Section title="OSPF" empty={!ospfRuntime.running}>
        {t('live.ospfRuns', { runs: ospfRuntime.spfRuns, changes: ospfRuntime.neighborChanges })}
        <br />
        {t('live.ospfNeighbors', { count: ospfNeighbors.length })}
      </Section>

      <Section title="IPSec" empty={!ipsec.running}>
        {t('live.ipsecSas', { ike: ipsec.activeIkeSAs, ipsec: ipsec.activeIPSecSAs })}
        <br />
        {t('live.ipsecTraffic', {
          inOk: ipsec.inboundProcessed, inDrop: ipsec.inboundDropped,
          outOk: ipsec.outboundProcessed, outDrop: ipsec.outboundDropped,
        })}
      </Section>

      <Section title="NAT" empty={nat.sessionCount === 0}>
        {t('live.natSessions', { count: nat.sessionCount, established: nat.tcpEstablished })}
        <br />
        {t('live.natCounters', { hits: nat.hits, misses: nat.misses, expired: nat.expired })}
      </Section>

      <Section title="DHCP client" empty={!dhcpClient.running}>
        {t('live.dhcpClientBound', { bound: dhcpClient.boundCount, interfaces: dhcpClient.ifaceCount })}
        <br />
        {t('live.dhcpClientCounters', {
          discover: dhcpClient.discoversSent, offer: dhcpClient.offersReceived,
          request: dhcpClient.requestsSent, ack: dhcpClient.acksReceived,
        })}
      </Section>

      <Section title="DHCP server" empty={!dhcpServer.running}>
        {t('live.dhcpServer', {
          pools: dhcpServer.poolCount, leases: dhcpServer.activeLeases, reservations: dhcpServer.reservationsCount,
        })}
      </Section>
    </div>
  );
}
