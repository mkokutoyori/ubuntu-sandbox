/**
 * ConnectionLine - SVG line connecting two devices
 *
 * Renders an orthogonal run between source and target devices, with
 * interface labels at each endpoint and a type indicator at the midpoint.
 * Several cables between the same pair share a bundle and are drawn on
 * parallel lanes, each carrying its rank.
 */

import { memo, useMemo } from 'react';
import { Connection, isConnectionActive } from '@/store/networkStore';
import { NetworkDeviceUI, useNetworkStore } from '@/store/networkStore';
import {
  computeConnectionPath,
  getLinkAppearance,
  computeInterfaceLabelPositions,
  getConnectionMidpointInfo,
  abbreviateInterfaceName,
  type BundleSlot,
} from './connection-line-logic';
import { cn } from '@/lib/utils';

interface ConnectionLineProps {
  connection: Connection;
  devices: NetworkDeviceUI[];
  slot?: BundleSlot;
}

function ConnectionLineImpl({ connection, devices, slot }: ConnectionLineProps) {
  // Scoped selectors, not a bare useNetworkStore() — this component
  // shouldn't re-render just because the user panned, zoomed, or moved
  // an unrelated device (rapport 09 audit, §1).
  const selectedConnectionId = useNetworkStore(s => s.selectedConnectionId);
  const selectConnection = useNetworkStore(s => s.selectConnection);
  const removeConnection = useNetworkStore(s => s.removeConnection);

  const isSelected = selectedConnectionId === connection.id;

  const { sourceDevice, targetDevice } = useMemo(() => ({
    sourceDevice: devices.find(d => d.id === connection.sourceDeviceId),
    targetDevice: devices.find(d => d.id === connection.targetDeviceId)
  }), [devices, connection]);

  if (!sourceDevice || !targetDevice) return null;

  // Either end tells the same story — a link carries or it does not —
  // so one missing carrier is enough to call the whole link down.
  const sourceIface = sourceDevice.interfaces.find(i => i.id === connection.sourceInterfaceId);
  const targetIface = targetDevice.interfaces.find(i => i.id === connection.targetInterfaceId);
  const isOperational = (sourceIface?.isOperational ?? true) && (targetIface?.isOperational ?? true);

  const { color, dash } = getLinkAppearance(connection.type, isOperational);

  const { path, midX, midY } = computeConnectionPath(
    { x: sourceDevice.x, y: sourceDevice.y },
    { x: targetDevice.x, y: targetDevice.y },
    slot,
  );

  const labelPositions = computeInterfaceLabelPositions(
    { x: sourceDevice.x, y: sourceDevice.y },
    { x: targetDevice.x, y: targetDevice.y },
    slot,
  );

  const midpointInfo = getConnectionMidpointInfo(connection);
  const adjustedMidY = midY;
  const inBundle = (slot?.size ?? 1) > 1;

  // The state belongs in the label, not only in the colour: a red line
  // says nothing to a screen reader, and nothing to a colour-blind
  // operator either.
  const connectionLabel =
    `${connection.type} cable: ${sourceDevice.name} ${connection.sourceInterfaceId} ` +
    `to ${targetDevice.name} ${connection.targetInterfaceId}` +
    `, ${isOperational ? 'link up' : 'link down'}` +
    (inBundle ? `, link ${slot!.index + 1} of ${slot!.size} in bundle` : '') +
    `${isSelected ? ', selected' : ''}`;

  // A plain SVG shape has no way to receive keyboard focus or announce
  // itself to a screen reader, so a cable could only be selected/deleted
  // by clicking (rapport 09 audit). tabIndex + role make the whole <g> a
  // real focus stop; Enter selects (same as click) and Delete/Backspace
  // removes it, mirroring NetworkDevice's keyboard handling.
  const handleKeyDown = (e: React.KeyboardEvent<SVGGElement>) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        selectConnection(connection.id);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        removeConnection(connection.id);
        break;
      default:
        break;
    }
  };

  return (
    <g
      className="group focus-visible:outline-none"
      role="button"
      tabIndex={0}
      aria-label={connectionLabel}
      aria-pressed={isSelected}
      data-link-state={isOperational ? 'up' : 'down'}
      onFocus={() => selectConnection(connection.id)}
      onKeyDown={handleKeyDown}
    >
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

      <path
        d={path}
        fill="none"
        stroke="rgba(2,6,23,0.55)"
        strokeWidth={isSelected ? 7 : 5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none"
      />

      {/* Main connection line */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={isSelected ? 3.5 : 2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dash}
        className={cn(
          "transition-all cursor-pointer",
          !isConnectionActive(connection) && "opacity-30",
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
        stroke="rgba(2,6,23,0.85)"
        strokeWidth={2.5}
        paintOrder="stroke"
        opacity={isSelected ? 1 : 0.75}
        className="pointer-events-none select-none transition-opacity group-hover:opacity-90"
        fontFamily="monospace"
      >
        {abbreviateInterfaceName(connection.sourceInterfaceId)}
      </text>

      {/* Target interface label */}
      <text
        x={labelPositions.target.x}
        y={labelPositions.target.y}
        textAnchor="middle"
        fill="white"
        fontSize={9}
        stroke="rgba(2,6,23,0.85)"
        strokeWidth={2.5}
        paintOrder="stroke"
        opacity={isSelected ? 1 : 0.75}
        className="pointer-events-none select-none transition-opacity group-hover:opacity-90"
        fontFamily="monospace"
      >
        {abbreviateInterfaceName(connection.targetInterfaceId)}
      </text>

      {/* Connection type indicator at midpoint */}
      {inBundle ? (
        <g
          className="cursor-pointer"
          onClick={() => selectConnection(connection.id)}
        >
          <rect
            x={midX - 15}
            y={adjustedMidY - 8}
            width={30}
            height={16}
            rx={8}
            fill="rgba(2,6,23,0.85)"
            stroke={color}
            strokeWidth={isSelected ? 2 : 1.25}
          />
          <text
            x={midX}
            y={adjustedMidY}
            textAnchor="middle"
            dominantBaseline="central"
            fill={color}
            fontSize={9}
            fontWeight="700"
            fontFamily="monospace"
            className="pointer-events-none select-none"
          >
            {slot!.index + 1}/{slot!.size}
          </text>
        </g>
      ) : (
        <circle
          cx={midX}
          cy={adjustedMidY}
          r={isSelected ? 6 : 4}
          fill={color}
          stroke="rgba(2,6,23,0.75)"
          strokeWidth={1.5}
          className="transition-all cursor-pointer"
          onClick={() => selectConnection(connection.id)}
        />
      )}

      {/* Type label below midpoint (visible on hover or selection) */}
      <text
        x={midX}
        y={adjustedMidY + (inBundle ? 20 : (isSelected ? 16 : 14))}
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
          transform={`translate(${midX + (inBundle ? 24 : 15)}, ${adjustedMidY - 15})`}
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

// `devices`/`connection` are referentially stable across renders while
// nothing they represent actually changed (networkStore.ts's snapshot
// cache) — memoizing skips the per-frame re-render every ConnectionLine
// otherwise took from NetworkCanvas re-rendering on packet animation
// ticks alone (rapport 09 audit).
export const ConnectionLine = memo(ConnectionLineImpl);
