import { memo, useMemo } from 'react';
import { Connection, isConnectionActive } from '@/store/networkStore';
import { NetworkDeviceUI, useNetworkStore } from '@/store/networkStore';
import {
  computeConnectionPath,
  getLinkAppearance,
  computeInterfaceLabelPositions,
  computeEndpointAnchors,
  connectorSegment,
  interfaceTagWidth,
  linkSummaryLabel,
  abbreviateInterfaceName,
  TAG_HEIGHT,
  type BundleSlot,
  type EndpointAnchor,
  type Point,
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

  const anchors = computeEndpointAnchors(
    { x: sourceDevice.x, y: sourceDevice.y },
    { x: targetDevice.x, y: targetDevice.y },
    slot,
  );

  const summary = linkSummaryLabel(
    connection.sourceInterfaceId, connection.targetInterfaceId);
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

      <Connector anchor={anchors.source} color={color} />
      <Connector anchor={anchors.target} color={color} />

      <PortTag
        at={labelPositions.source}
        name={connection.sourceInterfaceId}
        color={color}
        emphasised={isSelected}
      />
      <PortTag
        at={labelPositions.target}
        name={connection.targetInterfaceId}
        color={color}
        emphasised={isSelected}
      />

      {inBundle ? (
        <g
          className="cursor-pointer"
          onClick={() => selectConnection(connection.id)}
        >
          <rect
            x={midX - 15}
            y={midY - 8}
            width={30}
            height={16}
            rx={8}
            fill="rgba(2,6,23,0.85)"
            stroke={color}
            strokeWidth={isSelected ? 2 : 1.25}
          />
          <text
            x={midX}
            y={midY}
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
          cy={midY}
          r={isSelected ? 6 : 4}
          fill={color}
          stroke="rgba(2,6,23,0.75)"
          strokeWidth={1.5}
          className="transition-all cursor-pointer"
          onClick={() => selectConnection(connection.id)}
        />
      )}

      <g
        opacity={isSelected ? 1 : 0}
        className="pointer-events-none select-none transition-opacity group-hover:opacity-100"
      >
        <rect
          x={midX - interfaceTagWidth(summary) / 2}
          y={midY + (inBundle ? 12 : 8)}
          width={interfaceTagWidth(summary)}
          height={TAG_HEIGHT}
          rx={TAG_HEIGHT / 2}
          fill="rgba(2,6,23,0.92)"
          stroke={color}
          strokeWidth={1.25}
        />
        <text
          x={midX}
          y={midY + (inBundle ? 12 : 8) + TAG_HEIGHT / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontSize={9}
          fontWeight="600"
          fontFamily="monospace"
        >
          {summary}
        </text>
      </g>

      {/* Delete button when selected */}
      {isSelected && (
        <g
          transform={`translate(${midX + (inBundle ? 24 : 15)}, ${midY - 15})`}
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

function Connector({ anchor, color }: { anchor: EndpointAnchor; color: string }) {
  const { a, b } = connectorSegment(anchor);
  return (
    <g className="pointer-events-none">
      <line
        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
        stroke="rgba(2,6,23,0.85)"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <line
        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
      />
    </g>
  );
}

function PortTag(
  { at, name, color, emphasised }:
  { at: Point; name: string; color: string; emphasised: boolean },
) {
  const label = abbreviateInterfaceName(name);
  const width = interfaceTagWidth(label);
  return (
    <g
      className="pointer-events-none select-none transition-opacity group-hover:opacity-100"
      opacity={emphasised ? 1 : 0.92}
    >
      <rect
        x={at.x - width / 2}
        y={at.y - TAG_HEIGHT / 2}
        width={width}
        height={TAG_HEIGHT}
        rx={TAG_HEIGHT / 2}
        fill="rgba(2,6,23,0.92)"
        stroke={color}
        strokeWidth={emphasised ? 1.6 : 1.1}
      />
      <text
        x={at.x}
        y={at.y}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        fontSize={9}
        fontWeight="600"
        fontFamily="monospace"
      >
        {label}
      </text>
    </g>
  );
}

// `devices`/`connection` are referentially stable across renders while
// nothing they represent actually changed (networkStore.ts's snapshot
// cache) — memoizing skips the per-frame re-render every ConnectionLine
// otherwise took from NetworkCanvas re-rendering on packet animation
// ticks alone (rapport 09 audit).
export const ConnectionLine = memo(ConnectionLineImpl);
