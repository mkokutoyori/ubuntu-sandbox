/**
 * PacketAnimation - Visual representation of packets traveling on network cables
 */

import { memo, useMemo } from 'react';
import { NetworkDeviceUI, Connection } from '@/store/networkStore';
import { computeOrthogonalPoints, pointAlongPolyline, type BundleSlot } from './connection-line-logic';

export type PacketKind = 'arp' | 'icmp' | 'broadcast' | 'data';

export interface ActivePacket {
  id: string;
  connectionId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  progress: number;
  type: PacketKind;
  startTime?: number;
}

interface PacketAnimationProps {
  packet: ActivePacket;
  connection: Connection;
  devices: NetworkDeviceUI[];
  slot?: BundleSlot;
}

// Colors for different packet types
const PACKET_COLORS = {
  arp: '#f59e0b',      // amber - ARP requests/replies
  icmp: '#22c55e',     // green - ICMP ping
  broadcast: '#a855f7', // purple - broadcast frames
  data: '#3b82f6'      // blue - regular data
};

// Glow colors (lighter versions)
const PACKET_GLOWS = {
  arp: 'rgba(245, 158, 11, 0.6)',
  icmp: 'rgba(34, 197, 94, 0.6)',
  broadcast: 'rgba(168, 85, 247, 0.6)',
  data: 'rgba(59, 130, 246, 0.6)'
};

function PacketAnimationImpl({ packet, connection, devices, slot }: PacketAnimationProps) {
  const { sourceDevice, targetDevice, position } = useMemo(() => {
    const source = devices.find(d => d.id === connection.sourceDeviceId);
    const target = devices.find(d => d.id === connection.targetDeviceId);

    if (!source || !target) {
      return { sourceDevice: null, targetDevice: null, position: { x: 0, y: 0 } };
    }

    const points = computeOrthogonalPoints(
      { x: source.x, y: source.y },
      { x: target.x, y: target.y },
      slot,
    );
    const direction = packet.sourceDeviceId === source.id ? 'forward' : 'reverse';
    const t = direction === 'forward' ? packet.progress : (1 - packet.progress);

    return {
      sourceDevice: source,
      targetDevice: target,
      position: pointAlongPolyline(points, t),
    };
  }, [packet, connection, devices, slot]);

  if (!sourceDevice || !targetDevice) return null;

  const color = PACKET_COLORS[packet.type];
  const glow = PACKET_GLOWS[packet.type];

  // Size varies slightly based on packet type
  const size = packet.type === 'broadcast' ? 8 : 6;

  return (
    <g className="pointer-events-none">
      {/* Outer glow */}
      <circle
        cx={position.x}
        cy={position.y}
        r={size + 4}
        fill={glow}
        opacity={0.5}
      />
      {/* Inner packet */}
      <circle
        cx={position.x}
        cy={position.y}
        r={size}
        fill={color}
        stroke="white"
        strokeWidth={1}
      />
      {/* Small icon in center based on type */}
      {packet.type === 'icmp' && (
        <text
          x={position.x}
          y={position.y}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize={8}
          fontWeight="bold"
        >
          P
        </text>
      )}
      {packet.type === 'arp' && (
        <text
          x={position.x}
          y={position.y}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize={7}
          fontWeight="bold"
        >
          A
        </text>
      )}
      {packet.type === 'broadcast' && (
        <text
          x={position.x}
          y={position.y}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize={8}
          fontWeight="bold"
        >
          *
        </text>
      )}
    </g>
  );
}

// A moving packet's own `progress` prop changes every rAF frame by
// design, so memoizing this doesn't skip its own animation — it just
// avoids recomputing when NetworkCanvas re-renders for an unrelated
// reason (rapport 09 audit) and this particular packet's props didn't.
export const PacketAnimation = memo(PacketAnimationImpl);

interface PacketLegendProps {
  className?: string;
}

export function PacketLegend({ className }: PacketLegendProps) {
  return (
    <div className={`flex items-center gap-4 text-xs ${className}`}>
      <div className="flex items-center gap-1">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: PACKET_COLORS.icmp }} />
        <span className="text-white/60">Ping</span>
      </div>
      <div className="flex items-center gap-1">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: PACKET_COLORS.arp }} />
        <span className="text-white/60">ARP</span>
      </div>
      <div className="flex items-center gap-1">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: PACKET_COLORS.broadcast }} />
        <span className="text-white/60">Broadcast</span>
      </div>
      <div className="flex items-center gap-1">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: PACKET_COLORS.data }} />
        <span className="text-white/60">Data</span>
      </div>
    </div>
  );
}
