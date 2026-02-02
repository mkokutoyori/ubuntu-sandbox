/**
 * Pure logic functions for ConnectionLine rendering.
 * Extracted from the React component for testability.
 */

import { Connection, ConnectionType } from '@/domain/devices/types';

export interface Point {
  x: number;
  y: number;
}

export interface PathResult {
  path: string;
  midX: number;
  midY: number;
  curveFactor: number;
}

/**
 * Computes a quadratic Bezier SVG path between two device positions.
 */
export function computeConnectionPath(source: Point, target: Point): PathResult {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const curveFactor = Math.min(distance * 0.3, 50);

  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2 - curveFactor * 0.2;

  const path = `M ${source.x} ${source.y} Q ${midX} ${midY} ${target.x} ${target.y}`;

  return { path, midX, midY, curveFactor };
}

/**
 * Returns the stroke color for a connection type.
 */
export function getConnectionColor(type: ConnectionType): string {
  switch (type) {
    case 'ethernet': return '#3b82f6'; // blue
    case 'serial': return '#f97316';   // orange
    case 'console': return '#64748b';  // gray
    default: return '#64748b';
  }
}

/**
 * Returns the stroke dash pattern for a connection type.
 */
export function getConnectionDash(type: ConnectionType): string {
  switch (type) {
    case 'serial': return '10,5';
    case 'console': return '4,4';
    case 'ethernet':
    default: return '';
  }
}

export interface LabelPositions {
  source: Point;
  target: Point;
}

/**
 * Computes positions for interface labels near each endpoint.
 * Labels are placed ~20% along the line from each endpoint,
 * offset vertically so they don't overlap the line.
 */
export function computeInterfaceLabelPositions(source: Point, target: Point): LabelPositions {
  const offsetFactor = 0.2;
  const verticalOffset = -12;

  return {
    source: {
      x: source.x + (target.x - source.x) * offsetFactor,
      y: source.y + (target.y - source.y) * offsetFactor + verticalOffset
    },
    target: {
      x: target.x - (target.x - source.x) * offsetFactor,
      y: target.y - (target.y - source.y) * offsetFactor + verticalOffset
    }
  };
}

export interface MidpointInfo {
  typeLabel: string;
  color: string;
}

/**
 * Returns display info for the connection midpoint badge.
 */
export function getConnectionMidpointInfo(connection: Connection): MidpointInfo {
  const labels: Record<string, string> = {
    ethernet: 'Ethernet',
    serial: 'Serial',
    console: 'Console'
  };

  return {
    typeLabel: labels[connection.type] || connection.type,
    color: getConnectionColor(connection.type)
  };
}
