import { memo, useMemo } from 'react';
import { Connection, isConnectionActive } from '@/store/networkStore';
import { NetworkDeviceUI, useNetworkStore } from '@/store/networkStore';
import {
  getLinkAppearance,
  computeEndpointAnchors,
  connectorSegment,
  interfaceTagWidth,
  TAG_HEIGHT,
  type CableRoute,
  type EndpointAnchor,
  type LabelPlacement,
} from './connection-line-logic';
import { cn } from '@/lib/utils';

interface ConnectionLineProps {
  connection: Connection;
  devices: NetworkDeviceUI[];
  route: CableRoute;
}

function ConnectionLineImpl({ connection, devices, route }: ConnectionLineProps) {
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

  const path = route.path;
  const anchors = computeEndpointAnchors(route.points);

  // The state belongs in the label, not only in the colour: a red line
  // says nothing to a screen reader, and nothing to a colour-blind
  // operator either.
  const connectionLabel =
    `${connection.type} cable: ${sourceDevice.name} ${connection.sourceInterfaceId} ` +
    `to ${targetDevice.name} ${connection.targetInterfaceId}` +
    `, ${isOperational ? 'link up' : 'link down'}` +
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
      className="group outline-none"
      role="button"
      tabIndex={0}
      aria-label={connectionLabel}
      aria-pressed={isSelected}
      data-connection-id={connection.id}
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

    </g>
  );
}

export function ConnectionLabel({ connection, devices, route }: ConnectionLineProps) {
  const selectedConnectionId = useNetworkStore(s => s.selectedConnectionId);
  const selectConnection = useNetworkStore(s => s.selectConnection);
  const removeConnection = useNetworkStore(s => s.removeConnection);

  const isSelected = selectedConnectionId === connection.id;

  const { sourceDevice, targetDevice } = useMemo(() => ({
    sourceDevice: devices.find(d => d.id === connection.sourceDeviceId),
    targetDevice: devices.find(d => d.id === connection.targetDeviceId)
  }), [devices, connection]);

  if (!sourceDevice || !targetDevice) return null;

  const sourceIface = sourceDevice.interfaces.find(i => i.id === connection.sourceInterfaceId);
  const targetIface = targetDevice.interfaces.find(i => i.id === connection.targetInterfaceId);
  const isOperational = (sourceIface?.isOperational ?? true) && (targetIface?.isOperational ?? true);
  const { color } = getLinkAppearance(connection.type, isOperational);

  const removeAt = route.targetLabel;
  const removeOffset = removeAt.vertical
    ? TAG_HEIGHT / 2
    : interfaceTagWidth(removeAt.text) / 2;

  return (
    <g data-label-for={connection.id}>
      <PortTag
        placement={route.sourceLabel}
        color={color}
        emphasised={isSelected}
        onSelect={() => selectConnection(connection.id)}
      />
      <PortTag
        placement={route.targetLabel}
        color={color}
        emphasised={isSelected}
        onSelect={() => selectConnection(connection.id)}
      />

      {isSelected && (
        <g
          transform={`translate(${removeAt.at.x + removeOffset + 12}, ${removeAt.at.y})`}
          className="cursor-pointer"
          onClick={() => removeConnection(connection.id)}
        >
          <circle r={9} fill="#ef4444" className="hover:fill-red-600 transition-colors" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fill="white"
            fontSize={11}
            fontWeight="bold"
            className="pointer-events-none select-none"
          >
            x
          </text>
        </g>
      )}
    </g>
  );
}

function PortTag(
  { placement, color, emphasised, onSelect }: {
    placement: LabelPlacement;
    color: string;
    emphasised: boolean;
    onSelect: () => void;
  },
) {
  const width = interfaceTagWidth(placement.text);
  const { x, y } = placement.at;
  return (
    <g
      className="cursor-pointer select-none"
      data-port-label=""
      transform={placement.vertical ? `rotate(90 ${x} ${y})` : undefined}
      onClick={onSelect}
    >
      <rect
        x={x - width / 2}
        y={y - TAG_HEIGHT / 2}
        width={width}
        height={TAG_HEIGHT}
        rx={TAG_HEIGHT / 2}
        fill="rgba(2,6,23,0.92)"
        stroke={color}
        strokeWidth={emphasised ? 1.8 : 1.1}
      />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        fontSize={9}
        fontWeight="600"
        fontFamily="monospace"
        className="pointer-events-none"
      >
        {placement.text}
      </text>
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

export const ConnectionLine = memo(ConnectionLineImpl);
