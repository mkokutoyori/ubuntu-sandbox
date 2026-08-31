/**
 * Pure logic functions for ConnectionLine rendering.
 * Extracted from the React component for testability.
 */

import type { ConnectionType } from '@/network';
import type { Connection } from '@/store/networkStore';

export interface Point {
  x: number;
  y: number;
}

export interface PathResult {
  path: string;
  points: Point[];
  midX: number;
  midY: number;
  curveFactor: number;
}

export interface BundleSlot {
  index: number;
  size: number;
}

export const NODE_HALF_WIDTH = 30;
export const NODE_HALF_HEIGHT = 30;
export const NODE_CENTER_OFFSET_Y = -10;
export const BUNDLE_SPACING = 13;
export const CORNER_RADIUS = 10;

export function bundleKey(aDeviceId: string, bDeviceId: string): string {
  return aDeviceId < bDeviceId ? `${aDeviceId}|${bDeviceId}` : `${bDeviceId}|${aDeviceId}`;
}

export function computeBundleSlots(
  links: ReadonlyArray<{ id: string; sourceDeviceId: string; targetDeviceId: string }>,
): Map<string, BundleSlot> {
  const groups = new Map<string, string[]>();
  for (const link of links) {
    const key = bundleKey(link.sourceDeviceId, link.targetDeviceId);
    const group = groups.get(key);
    if (group) group.push(link.id);
    else groups.set(key, [link.id]);
  }
  const slots = new Map<string, BundleSlot>();
  for (const ids of groups.values()) {
    const ordered = [...ids].sort();
    ordered.forEach((id, index) => slots.set(id, { index, size: ordered.length }));
  }
  return slots;
}

export function bundleOffset(slot?: BundleSlot): number {
  if (!slot || slot.size < 2) return 0;
  return (slot.index - (slot.size - 1) / 2) * BUNDLE_SPACING;
}

function cardCenter(p: Point): Point {
  return { x: p.x, y: p.y + NODE_CENTER_OFFSET_Y };
}

export function computeOrthogonalPoints(
  source: Point,
  target: Point,
  slot?: BundleSlot,
): Point[] {
  const a = cardCenter(source);
  const b = cardCenter(target);
  const offset = bundleOffset(slot);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    const ax = a.x + dir * NODE_HALF_WIDTH;
    const bx = b.x - dir * NODE_HALF_WIDTH;
    const ay = a.y + offset;
    const by = b.y + offset;
    const corridor = (ax + bx) / 2 + offset;
    return [{ x: ax, y: ay }, { x: corridor, y: ay }, { x: corridor, y: by }, { x: bx, y: by }];
  }

  const dir = dy >= 0 ? 1 : -1;
  const ay = a.y + dir * NODE_HALF_HEIGHT;
  const by = b.y - dir * NODE_HALF_HEIGHT;
  const ax = a.x + offset;
  const bx = b.x + offset;
  const corridor = (ay + by) / 2 + offset;
  return [{ x: ax, y: ay }, { x: ax, y: corridor }, { x: bx, y: corridor }, { x: bx, y: by }];
}

function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function roundedPolylinePath(points: Point[], radius: number = CORNER_RADIUS): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLen = segmentLength(prev, corner);
    const outLen = segmentLength(corner, next);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0.01) continue;
    const enter = {
      x: corner.x + ((prev.x - corner.x) / inLen) * r,
      y: corner.y + ((prev.y - corner.y) / inLen) * r,
    };
    const leave = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };
    d += ` L ${enter.x} ${enter.y} Q ${corner.x} ${corner.y} ${leave.x} ${leave.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

export function pointAlongPolyline(points: Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const clamped = Math.max(0, Math.min(1, t));
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = segmentLength(points[i - 1], points[i]);
    lengths.push(len);
    total += len;
  }
  if (total === 0) return points[0];

  let travelled = clamped * total;
  for (let i = 0; i < lengths.length; i++) {
    if (travelled <= lengths[i] || i === lengths.length - 1) {
      const ratio = lengths[i] === 0 ? 0 : travelled / lengths[i];
      const a = points[i];
      const b = points[i + 1];
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
    }
    travelled -= lengths[i];
  }
  return points[points.length - 1];
}

export const BADGE_STAGGER = 28;

export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += segmentLength(points[i - 1], points[i]);
  return total;
}

export function bundleMidpoint(points: Point[], slot?: BundleSlot): Point {
  const total = polylineLength(points);
  if (total === 0 || !slot || slot.size < 2) return pointAlongPolyline(points, 0.5);
  const shift = (slot.index - (slot.size - 1) / 2) * BADGE_STAGGER;
  return pointAlongPolyline(points, 0.5 + shift / total);
}

export function computeConnectionPath(
  source: Point,
  target: Point,
  slot?: BundleSlot,
): PathResult {
  const points = computeOrthogonalPoints(source, target, slot);
  const mid = bundleMidpoint(points, slot);
  return {
    path: roundedPolylinePath(points),
    points,
    midX: mid.x,
    midY: mid.y,
    curveFactor: 0,
  };
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

/** Colour of a link carrying nothing — the cable's own colour says only what it is. */
export const DEAD_LINK_COLOR = '#ef4444';
/** Dash of a link carrying nothing, so colour is not the only signal. */
export const DEAD_LINK_DASH = '6,6';

/**
 * A drawn cable is not a working link: the far end may be shut down or
 * switched off, and the operator has no other way to see it from the
 * canvas. Down wins over the cable's own type, since the question
 * "does this carry?" outranks "what kind of wire is it?".
 */
export function getLinkAppearance(
  type: ConnectionType,
  operational: boolean,
): { color: string; dash: string } {
  if (operational) return { color: getConnectionColor(type), dash: getConnectionDash(type) };
  return { color: DEAD_LINK_COLOR, dash: DEAD_LINK_DASH };
}

export interface LabelPositions {
  source: Point;
  target: Point;
}

export const LABEL_ANCHOR_DISTANCE = 30;
export const LABEL_ANCHOR_DISTANCE_VERTICAL = 48;
export const LABEL_STAGGER = 21;
export const LABEL_LIFT = 9;

const INTERFACE_ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^TenGigabitEthernet/i, 'Te'],
  [/^GigabitEthernet(\d+\/\d+\/\d+)$/i, 'GE$1'],
  [/^GigabitEthernet/i, 'Gi'],
  [/^FastEthernet/i, 'Fa'],
  [/^Serial/i, 'Se'],
  [/^Loopback/i, 'Lo'],
  [/^Tunnel/i, 'Tu'],
  [/^Vlanif/i, 'Vlanif'],
  [/^Vlan/i, 'Vl'],
  [/^Port-channel/i, 'Po'],
  [/^Eth-Trunk/i, 'Eth-Trunk'],
];

export function abbreviateInterfaceName(name: string): string {
  for (const [pattern, short] of INTERFACE_ABBREVIATIONS) {
    if (pattern.test(name)) return name.replace(pattern, short);
  }
  return name;
}

function labelPoint(from: Point, toward: Point, distance: number): Point {
  const len = Math.hypot(toward.x - from.x, toward.y - from.y);
  if (len === 0) return { x: from.x, y: from.y - LABEL_LIFT };
  const ux = (toward.x - from.x) / len;
  const uy = (toward.y - from.y) / len;
  const reach = Math.min(distance, Math.max(len - 6, 0));
  return {
    x: from.x + ux * reach - uy * LABEL_LIFT,
    y: from.y + uy * reach + ux * LABEL_LIFT - (uy === 0 ? LABEL_LIFT : 0),
  };
}

export function computeInterfaceLabelPositions(
  source: Point,
  target: Point,
  slot?: BundleSlot,
): LabelPositions {
  const points = computeOrthogonalPoints(source, target, slot);
  const stagger = (slot?.size ?? 1) > 1 ? slot!.index * LABEL_STAGGER : 0;
  const vertical = Math.abs(points[1].y - points[0].y) > Math.abs(points[1].x - points[0].x);
  const base = vertical ? LABEL_ANCHOR_DISTANCE_VERTICAL : LABEL_ANCHOR_DISTANCE;
  const distance = base + stagger;
  return {
    source: labelPoint(points[0], points[1], distance),
    target: labelPoint(points[points.length - 1], points[points.length - 2], distance),
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
