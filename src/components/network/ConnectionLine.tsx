/**
 * ConnectionLine - SVG line connecting two devices
 */

import { useMemo } from 'react';
import { Connection, ConnectionType } from '@/domain/devices';
import { NetworkDeviceUI, useNetworkStore } from '@/store/networkStore';
import { cn } from '@/lib/utils';

interface ConnectionLineProps {
  connection: Connection;
  devices: NetworkDeviceUI[];
}

function getConnectionColor(type: ConnectionType): string {
  switch (type) {
    case 'ethernet': return '#3b82f6'; // blue
    case 'fiber': return '#a855f7'; // purple
    case 'wifi': return '#22c55e'; // green
    case 'serial': return '#f97316'; // orange
    default: return '#64748b';
  }
}

function getConnectionDash(type: ConnectionType): string {
  switch (type) {
    case 'wifi': return '5,5';
    case 'serial': return '10,5';
    default: return '';
  }
}

export function ConnectionLine({ connection, devices }: ConnectionLineProps) {
  const { selectedConnectionId, selectConnection, removeConnection } = useNetworkStore();

  const isSelected = selectedConnectionId === connection.id;

  const { sourceDevice, targetDevice } = useMemo(() => ({
    sourceDevice: devices.find(d => d.id === connection.sourceDeviceId),
    targetDevice: devices.find(d => d.id === connection.targetDeviceId)
  }), [devices, connection]);

  if (!sourceDevice || !targetDevice) return null;

  const color = getConnectionColor(connection.type);
  const dash = getConnectionDash(connection.type);

  // Calculate control points for a smooth curve
  const dx = targetDevice.x - sourceDevice.x;
  const dy = targetDevice.y - sourceDevice.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Curve factor based on distance
  const curveFactor = Math.min(distance * 0.3, 50);

  // Create a slightly curved path
  const midX = (sourceDevice.x + targetDevice.x) / 2;
  const midY = (sourceDevice.y + targetDevice.y) / 2 - curveFactor * 0.2;

  const path = `M ${sourceDevice.x} ${sourceDevice.y} Q ${midX} ${midY} ${targetDevice.x} ${targetDevice.y}`;

  return (
    <g className="group">
      {/* Invisible wider path for easier clicking */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="cursor-pointer"
        onClick={() => selectConnection(connection.id)}
      />

      {/* Glow effect for selected */}
      {isSelected && (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          opacity={0.3}
          className="animate-pulse"
        />
      )}

      {/* Main connection line */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={isSelected ? 3 : 2}
        strokeLinecap="round"
        strokeDasharray={dash}
        className={cn(
          "transition-all cursor-pointer",
          !connection.isActive && "opacity-30",
          "group-hover:stroke-[3px]"
        )}
        onClick={() => selectConnection(connection.id)}
      />

      {/* Connection type indicator at midpoint */}
      <circle
        cx={midX}
        cy={midY + curveFactor * 0.2}
        r={isSelected ? 6 : 4}
        fill={color}
        className="transition-all"
      />

      {/* Delete button when selected */}
      {isSelected && (
        <g
          transform={`translate(${midX + 15}, ${midY + curveFactor * 0.2 - 15})`}
          className="cursor-pointer"
          onClick={() => removeConnection(connection.id)}
        >
          <circle r={10} fill="#ef4444" className="hover:fill-red-600 transition-colors" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fill="white"
            fontSize={12}
            fontWeight="bold"
          >
            x
          </text>
        </g>
      )}
    </g>
  );
}
