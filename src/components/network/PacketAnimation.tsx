/**
 * PacketAnimation - Visual representation of packets traveling on network cables
 */

import { useMemo } from 'react';
import { ActivePacket } from '@/hooks/useNetworkSimulator';
import { NetworkDeviceUI } from '@/store/networkStore';
import { Connection } from '@/devices/common/types';

interface PacketAnimationProps {
  packet: ActivePacket;
  connection: Connection;
  devices: NetworkDeviceUI[];
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

export function PacketAnimation({ packet, connection, devices }: PacketAnimationProps) {
  const { sourceDevice, targetDevice, position } = useMemo(() => {
    const source = devices.find(d => d.id === connection.sourceDeviceId);
    const target = devices.find(d => d.id === connection.targetDeviceId);

    if (!source || !target) {
      return { sourceDevice: null, targetDevice: null, position: { x: 0, y: 0 } };
    }

    // Calculate path similar to ConnectionLine
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const curveFactor = Math.min(distance * 0.3, 50);
    const midX = (source.x + target.x) / 2;
    const midY = (source.y + target.y) / 2 - curveFactor * 0.2;

    // Calculate position along quadratic bezier curve
    const progress = packet.direction === 'forward' ? packet.progress : (1 - packet.progress);
    const t = progress;

    // Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
    const x = Math.pow(1 - t, 2) * source.x + 2 * (1 - t) * t * midX + Math.pow(t, 2) * target.x;
    const y = Math.pow(1 - t, 2) * source.y + 2 * (1 - t) * t * (midY + curveFactor * 0.2) + Math.pow(t, 2) * target.y;

    return {
      sourceDevice: source,
      targetDevice: target,
      position: { x, y }
    };
  }, [packet, connection, devices]);

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
