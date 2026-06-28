import { useEffect, useState } from 'react';
import { getDefaultEventBus } from '@/events/EventBus';
import type { Equipment } from '@/network';
import type { Port } from '@/network/hardware/Port';
import type { Connection } from '@/store/networkStore';

export interface ConnectionPerf {
  bandwidthKbps: number;
  delayUs: number;
  resolved: boolean;
  bandwidthLabel: string;
  latencyLabel: string;
}

function fmtBandwidth(kbps: number): string {
  if (kbps <= 0) return 'N/A';
  if (kbps >= 1_000_000) return `${(kbps / 1_000_000).toFixed(0)} Gbps`;
  if (kbps >= 10_000) return `${Math.round(kbps / 1_000)} Mbps`;
  if (kbps >= 1_000) return `${(kbps / 1_000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} Kbps`;
}

function fmtLatency(us: number): string {
  if (us <= 0) return 'N/A';
  const ms = us / 1000;
  if (ms < 0.1) return '< 0.1 ms';
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(1)} ms`;
}

function readPorts(
  conn: Connection,
  resolve: (id: string) => Equipment | undefined,
): { source: Port | null; target: Port | null } {
  const sourceDev = resolve(conn.sourceDeviceId);
  const targetDev = resolve(conn.targetDeviceId);
  const source = sourceDev?.getPort?.(conn.sourceInterfaceId) ?? null;
  const target = targetDev?.getPort?.(conn.targetInterfaceId) ?? null;
  return { source, target };
}

function computePerf(
  conn: Connection,
  resolve: (id: string) => Equipment | undefined,
): ConnectionPerf {
  if (conn.type === 'console') {
    return {
      bandwidthKbps: 0, delayUs: 0, resolved: true,
      bandwidthLabel: 'N/A', latencyLabel: 'N/A',
    };
  }
  const { source, target } = readPorts(conn, resolve);
  if (!source || !target) {
    return {
      bandwidthKbps: 0, delayUs: 0, resolved: false,
      bandwidthLabel: 'N/A', latencyLabel: 'N/A',
    };
  }
  // Read configured speed (not the negotiated cache) so a CLI `speed N`
  // is reflected immediately.
  const bw = Math.min(source.getSpeed(), target.getSpeed()) * 1000;
  const delay = Math.max(source.getDelayUs(), target.getDelayUs());
  return {
    bandwidthKbps: bw,
    delayUs: delay,
    resolved: true,
    bandwidthLabel: fmtBandwidth(bw),
    latencyLabel: fmtLatency(delay),
  };
}

export function useConnectionPerf(
  connection: Connection | null,
  resolveDevice: (id: string) => Equipment | undefined,
): ConnectionPerf {
  const [, setVersion] = useState(0);
  const srcDev = connection?.sourceDeviceId ?? null;
  const tgtDev = connection?.targetDeviceId ?? null;
  const srcIf = connection?.sourceInterfaceId ?? null;
  const tgtIf = connection?.targetInterfaceId ?? null;

  useEffect(() => {
    if (!connection || connection.type === 'console') return;
    const bus = getDefaultEventBus();
    const matches = (payload: unknown): boolean => {
      const p = payload as { deviceId?: string; portName?: string };
      return (p.deviceId === srcDev && p.portName === srcIf)
        || (p.deviceId === tgtDev && p.portName === tgtIf);
    };
    const subs = [
      bus.subscribe('port.config.speed-changed', (e) => {
        if (matches(e.payload)) setVersion(v => v + 1);
      }),
      bus.subscribe('port.config.duplex-changed', (e) => {
        if (matches(e.payload)) setVersion(v => v + 1);
      }),
      bus.subscribe('port.link.up', (e) => {
        if (matches(e.payload)) setVersion(v => v + 1);
      }),
      bus.subscribe('port.link.down', (e) => {
        if (matches(e.payload)) setVersion(v => v + 1);
      }),
    ];
    return () => { for (const off of subs) off(); };
  }, [connection, srcDev, srcIf, tgtDev, tgtIf]);

  if (!connection) {
    return {
      bandwidthKbps: 0, delayUs: 0, resolved: false,
      bandwidthLabel: 'N/A', latencyLabel: 'N/A',
    };
  }
  return computePerf(connection, resolveDevice);
}

export const __test__ = { computePerf, fmtBandwidth, fmtLatency };
