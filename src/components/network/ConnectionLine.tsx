/**
 * ConnectionLine - SVG line connecting two devices
 *
 * Renders a styled Bezier curve between source and target devices,
 * with interface labels at each endpoint and a type indicator at the midpoint.
 */

import { useMemo } from 'react';
import { Connection } from '@/store/networkStore';
import { NetworkDeviceUI, useNetworkStore } from '@/store/networkStore';
import {
  computeConnectionPath,
  getConnectionColor,
  getConnectionDash,
  computeInterfaceLabelPositions,
  getConnectionMidpointInfo
} from './connection-line-logic';
import { cn } from '@/lib/utils';

interface ConnectionLineProps {
  connection: Connection;
  devices: NetworkDeviceUI[];
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

  const { path, midX, midY, curveFactor } = computeConnectionPath(
    { x: sourceDevice.x, y: sourceDevice.y },
    { x: targetDevice.x, y: targetDevice.y }
  );

  const labelPositions = computeInterfaceLabelPositions(
    { x: sourceDevice.x, y: sourceDevice.y },
    { x: targetDevice.x, y: targetDevice.y }
  );

  const midpointInfo = getConnectionMidpointInfo(connection);
  const adjustedMidY = midY + curveFactor * 0.2;

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

      {/* Source interface label */}
      <text
        x={labelPositions.source.x}
        y={labelPositions.source.y}
        textAnchor="middle"
        fill="white"
        fontSize={9}
        opacity={isSelected ? 0.9 : 0.5}
        className="pointer-events-none select-none transition-opacity group-hover:opacity-90"
        fontFamily="monospace"
      >
        {connection.sourceInterfaceId}
      </text>

      {/* Target interface label */}
      <text
        x={labelPositions.target.x}
        y={labelPositions.target.y}
        textAnchor="middle"
        fill="white"
        fontSize={9}
        opacity={isSelected ? 0.9 : 0.5}
        className="pointer-events-none select-none transition-opacity group-hover:opacity-90"
        fontFamily="monospace"
      >
        {connection.targetInterfaceId}
      </text>

      {/* Connection type indicator at midpoint */}
      <circle
        cx={midX}
        cy={adjustedMidY}
        r={isSelected ? 6 : 4}
        fill={color}
        className="transition-all"
      />

      {/* Type label below midpoint (visible on hover or selection) */}
      <text
        x={midX}
        y={adjustedMidY + (isSelected ? 16 : 14)}
        textAnchor="middle"
        fill={color}
        fontSize={8}
        fontWeight="600"
        opacity={isSelected ? 1 : 0}
        className="pointer-events-none select-none transition-opacity group-hover:opacity-80"
      >
        {midpointInfo.typeLabel}
      </text>

      {/* Delete button when selected */}
      {isSelected && (
        <g
          transform={`translate(${midX + 15}, ${adjustedMidY - 15})`}
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
