/**
 * Pure logic functions for ConnectionLine rendering.
 * Extracted from the React component for testability.
 */

import type { ConnectionType } from '@/network';

export interface Point {
  x: number;
  y: number;
}

export interface PathResult {
  path: string;
  points: Point[];
}

export interface CableLanes {
  sourceLane: number;
  targetLane: number;
}

export interface RoutedLink {
  id: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  source: Point;
  target: Point;
  sourceInterface: string;
  targetInterface: string;
}

export interface LabelPlacement {
  at: Point;
  text: string;
  vertical: boolean;
  halfLength: number;
}

export interface CableRoute extends CableLanes, PathResult {
  sourceLabel: LabelPlacement;
  targetLabel: LabelPlacement;
}

export const NODE_HALF_WIDTH = 30;
export const NODE_HALF_HEIGHT = 30;
export const NODE_CENTER_OFFSET_Y = -10;
export const LANE_SPACING = 18;
export const CORNER_RADIUS = 10;

export type CardSide = 'left' | 'right' | 'top' | 'bottom';

export function runIsHorizontal(from: Point, to: Point): boolean {
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
}

export function exitSide(from: Point, to: Point): CardSide {
  if (runIsHorizontal(from, to)) return to.x >= from.x ? 'right' : 'left';
  return to.y >= from.y ? 'bottom' : 'top';
}

function sideHalfExtent(side: CardSide): number {
  return side === 'left' || side === 'right' ? NODE_HALF_HEIGHT : NODE_HALF_WIDTH;
}

function sideSpreadsAlongX(side: CardSide): boolean {
  return side === 'top' || side === 'bottom';
}

export function laneSpacing(count: number, side: CardSide): number {
  if (count < 2) return 0;
  return Math.min(LANE_SPACING, (2 * sideHalfExtent(side)) / (count - 1));
}

interface PortSlot {
  linkId: string;
  end: 'source' | 'target';
  towards: number;
}

export function assignCableLanes(
  links: ReadonlyArray<RoutedLink>,
): Map<string, CableLanes> {
  const faces = new Map<string, { side: CardSide; slots: PortSlot[] }>();

  const enrol = (
    deviceId: string, side: CardSide, linkId: string,
    end: 'source' | 'target', far: Point,
  ) => {
    const key = `${deviceId}|${side}`;
    let face = faces.get(key);
    if (!face) {
      face = { side, slots: [] };
      faces.set(key, face);
    }
    face.slots.push({
      linkId, end,
      towards: sideSpreadsAlongX(side) ? far.x : far.y,
    });
  };

  for (const link of links) {
    enrol(link.sourceDeviceId, exitSide(link.source, link.target),
      link.id, 'source', link.target);
    enrol(link.targetDeviceId, exitSide(link.target, link.source),
      link.id, 'target', link.source);
  }

  const lanes = new Map<string, CableLanes>();
  for (const link of links) lanes.set(link.id, { sourceLane: 0, targetLane: 0 });

  for (const face of faces.values()) {
    const ordered = [...face.slots].sort((a, b) =>
      a.towards - b.towards || (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
    const spacing = laneSpacing(ordered.length, face.side);
    ordered.forEach((slot, index) => {
      const offset = (index - (ordered.length - 1) / 2) * spacing;
      const lane = lanes.get(slot.linkId)!;
      if (slot.end === 'source') lane.sourceLane = offset;
      else lane.targetLane = offset;
    });
  }

  return lanes;
}

function cardCenter(p: Point): Point {
  return { x: p.x, y: p.y + NODE_CENTER_OFFSET_Y };
}

export function computeOrthogonalPoints(
  source: Point,
  target: Point,
  lanes?: CableLanes,
): Point[] {
  const a = cardCenter(source);
  const b = cardCenter(target);
  const sourceLane = lanes?.sourceLane ?? 0;
  const targetLane = lanes?.targetLane ?? 0;
  const corridorLane = (sourceLane + targetLane) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    const ax = a.x + dir * NODE_HALF_WIDTH;
    const bx = b.x - dir * NODE_HALF_WIDTH;
    const ay = a.y + sourceLane;
    const by = b.y + targetLane;
    const corridor = (ax + bx) / 2 + corridorLane;
    return [{ x: ax, y: ay }, { x: corridor, y: ay }, { x: corridor, y: by }, { x: bx, y: by }];
  }

  const dir = dy >= 0 ? 1 : -1;
  const ay = a.y + dir * NODE_HALF_HEIGHT;
  const by = b.y - dir * NODE_HALF_HEIGHT;
  const ax = a.x + sourceLane;
  const bx = b.x + targetLane;
  const corridor = (ay + by) / 2 + corridorLane;
  return [{ x: ax, y: ay }, { x: ax, y: corridor }, { x: bx, y: corridor }, { x: bx, y: by }];
}

function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function roundedPolylinePath(points: ReadonlyArray<Point>, radius: number = CORNER_RADIUS): string {
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

export function pointAlongPolyline(points: ReadonlyArray<Point>, t: number): Point {
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

export function polylineLength(points: ReadonlyArray<Point>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += segmentLength(points[i - 1], points[i]);
  return total;
}

export function distanceToPolyline(p: Point, points: ReadonlyArray<Point>): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const squared = vx * vx + vy * vy;
    const t = squared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / squared));
    const distance = Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
    if (distance < best) best = distance;
  }
  return best;
}

export function computeConnectionPath(
  source: Point,
  target: Point,
  lanes?: CableLanes,
): PathResult {
  const points = computeOrthogonalPoints(source, target, lanes);
  return { path: roundedPolylinePath(points), points };
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

export const CONNECTOR_HALF_LENGTH = 5;
export const TAG_CHAR_WIDTH = 5.42;
export const TAG_PADDING = 7;
export const TAG_MIN_WIDTH = 22;
export const TAG_HEIGHT = 14;

export interface EndpointAnchor {
  point: Point;
  direction: Point;
}

export interface EndpointAnchors {
  source: EndpointAnchor;
  target: EndpointAnchor;
}

export interface ConnectorSegment {
  a: Point;
  b: Point;
}

function unitToward(from: Point, toward: Point): Point {
  const len = Math.hypot(toward.x - from.x, toward.y - from.y);
  if (len === 0) return { x: 1, y: 0 };
  return { x: (toward.x - from.x) / len, y: (toward.y - from.y) / len };
}

export function computeEndpointAnchors(points: ReadonlyArray<Point>): EndpointAnchors {
  const last = points.length - 1;
  return {
    source: { point: points[0], direction: unitToward(points[0], points[1]) },
    target: { point: points[last], direction: unitToward(points[last], points[last - 1]) },
  };
}

export function connectorSegment(anchor: EndpointAnchor): ConnectorSegment {
  const nx = -anchor.direction.y;
  const ny = anchor.direction.x;
  return {
    a: {
      x: anchor.point.x - nx * CONNECTOR_HALF_LENGTH,
      y: anchor.point.y - ny * CONNECTOR_HALF_LENGTH,
    },
    b: {
      x: anchor.point.x + nx * CONNECTOR_HALF_LENGTH,
      y: anchor.point.y + ny * CONNECTOR_HALF_LENGTH,
    },
  };
}

export function interfaceTagWidth(label: string): number {
  return Math.max(TAG_MIN_WIDTH, label.length * TAG_CHAR_WIDTH + TAG_PADDING * 2);
}

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

export const LABEL_END_MARGIN = 10;
export const DEVICE_BADGE_TOP = 33;
export const DEVICE_BADGE_BOTTOM = 51;
export const DEVICE_BADGE_HALF_WIDTH = 40;
export const LABEL_SAMPLES = 25;
export const LABEL_CLEARANCE_MIN = 2;
export const LABEL_MIN_ZOOM = 0.7;

export function shouldShowPortLabels(zoom: number): boolean {
  return zoom >= LABEL_MIN_ZOOM;
}

interface LabelBox {
  at: Point;
  halfWidth: number;
  halfHeight: number;
}

function boxClearance(box: LabelBox, other: LabelBox): number {
  return Math.max(
    Math.abs(box.at.x - other.at.x) - (box.halfWidth + other.halfWidth),
    Math.abs(box.at.y - other.at.y) - (box.halfHeight + other.halfHeight),
  );
}

interface LabelRange {
  from: number;
  to: number;
  vertical: boolean;
}

function segmentIsVertical(from: Point, to: Point): boolean {
  return Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
}

function labelRanges(points: ReadonlyArray<Point>, halfLength: number): LabelRange[] {
  const total = polylineLength(points);
  const whole = total;
  const first = LABEL_END_MARGIN + halfLength;
  const last = total - LABEL_END_MARGIN - halfLength;
  const ranges: LabelRange[] = [];
  let at = 0;
  for (let i = 1; i < points.length; i++) {
    const length = segmentLength(points[i - 1], points[i]);
    const from = Math.max(first, at + halfLength);
    const to = Math.min(last, at + length - halfLength);
    if (to >= from) {
      ranges.push({ from, to, vertical: segmentIsVertical(points[i - 1], points[i]) });
    }
    at += length;
  }
  if (ranges.length === 0) {
    return [{ from: 0, to: whole, vertical: longestSegmentIsVertical(points) }];
  }
  return ranges;
}

function longestSegmentIsVertical(points: ReadonlyArray<Point>): boolean {
  let vertical = false;
  let bestLength = -1;
  for (let i = 1; i < points.length; i++) {
    const length = segmentLength(points[i - 1], points[i]);
    if (length > bestLength) {
      bestLength = length;
      vertical = segmentIsVertical(points[i - 1], points[i]);
    }
  }
  return vertical;
}

function boxAlong(
  at: Point, vertical: boolean, halfLength: number, halfThickness: number,
): LabelBox {
  return {
    at,
    halfWidth: vertical ? halfThickness : halfLength,
    halfHeight: vertical ? halfLength : halfThickness,
  };
}

export function deviceObstacles(centre: Point): LabelBox[] {
  const card = cardCenter(centre);
  return [
    { at: card, halfWidth: NODE_HALF_WIDTH, halfHeight: NODE_HALF_HEIGHT },
    {
      at: { x: card.x, y: card.y + (DEVICE_BADGE_TOP + DEVICE_BADGE_BOTTOM) / 2 },
      halfWidth: DEVICE_BADGE_HALF_WIDTH,
      halfHeight: (DEVICE_BADGE_BOTTOM - DEVICE_BADGE_TOP) / 2,
    },
  ];
}

function placeEndLabel(
  points: ReadonlyArray<Point>,
  ranges: ReadonlyArray<LabelRange>,
  nearStart: boolean,
  others: ReadonlyArray<ReadonlyArray<Point>>,
  obstacles: ReadonlyArray<LabelBox>,
  halfLength: number,
  halfThickness: number,
): { box: LabelBox; vertical: boolean } {
  const total = polylineLength(points);
  const room = ranges.reduce((sum, range) => sum + (range.to - range.from), 0);

  let best = {
    box: boxAlong(points[0], ranges[0].vertical, halfLength, halfThickness),
    vertical: ranges[0].vertical,
  };
  let bestClearance = -Infinity;
  let bestProximity = -Infinity;
  let cleared = false;

  for (let i = 0; i < LABEL_SAMPLES; i++) {
    let walk = room === 0 ? 0 : (room * i) / (LABEL_SAMPLES - 1);
    let range = ranges[ranges.length - 1];
    let along = range.to;
    for (const candidate of ranges) {
      const span = candidate.to - candidate.from;
      if (walk <= span) {
        range = candidate;
        along = candidate.from + walk;
        break;
      }
      walk -= span;
    }
    const box = boxAlong(
      pointAlongPolyline(points, total === 0 ? 0 : along / total),
      range.vertical, halfLength, halfThickness);
    let clearance = Infinity;
    for (const other of others) clearance = Math.min(clearance, distanceToPolyline(box.at, other));
    for (const taken of obstacles) clearance = Math.min(clearance, boxClearance(box, taken));
    const proximity = nearStart ? -along : along - total;
    const clears = clearance >= LABEL_CLEARANCE_MIN;
    const better = clears
      ? !cleared || proximity > bestProximity
      : !cleared && (clearance > bestClearance
        || (clearance === bestClearance && proximity > bestProximity));
    if (better) {
      best = { box, vertical: range.vertical };
      bestClearance = clearance;
      bestProximity = proximity;
      cleared = cleared || clears;
    }
  }
  return best;
}

export function computeCableRoutes(
  links: ReadonlyArray<RoutedLink>,
  devices: ReadonlyArray<Point>,
  zoom = 1,
): Map<string, CableRoute> {
  const lanes = assignCableLanes(links);
  const ordered = [...links].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const drawn = new Map<string, PathResult>();
  for (const link of ordered) {
    drawn.set(link.id, computeConnectionPath(link.source, link.target, lanes.get(link.id)));
  }

  const routes = new Map<string, CableRoute>();
  const obstacles: LabelBox[] = devices.flatMap(deviceObstacles);

  for (const link of ordered) {
    const { path, points } = drawn.get(link.id)!;
    const others = ordered
      .filter(other => other.id !== link.id)
      .map(other => drawn.get(other.id)!.points);

    const place = (name: string, nearStart: boolean): LabelPlacement => {
      const text = abbreviateInterfaceName(name);
      const halfLength = interfaceTagWidth(text) / (2 * zoom);
      const halfThickness = TAG_HEIGHT / (2 * zoom);
      const placed = placeEndLabel(
        points, labelRanges(points, halfLength), nearStart, others, obstacles,
        halfLength, halfThickness);
      obstacles.push(placed.box);
      return { at: placed.box.at, text, vertical: placed.vertical, halfLength };
    };

    routes.set(link.id, {
      ...lanes.get(link.id)!,
      path,
      points,
      sourceLabel: place(link.sourceInterface, true),
      targetLabel: place(link.targetInterface, false),
    });
  }

  return routes;
}
