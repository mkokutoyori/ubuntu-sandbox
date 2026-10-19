import { readFileSync } from 'fs';
import { join } from 'path';
import {
  computeCableRoutes, deviceObstacles, TAG_HEIGHT, type CableRoute, type Point, type RoutedLink,
} from '@/components/network/connection-line-logic';

interface ExportedDevice { id: string; type: string; name: string; x: number; y: number }
interface ExportedConnection {
  sourceDeviceId: string; sourceInterfaceId: string; targetDeviceId: string; targetInterfaceId: string;
}

export interface ImportedLab {
  readonly name: string;
  readonly devices: readonly ExportedDevice[];
  readonly links: readonly RoutedLink[];
}

export type { ExportedDevice };
export const LAB_FILES = ['SSH_TP_LAN.topology (7).json', 'SSH_TP_LAN.topology (8).json', 'lan_with_firewall_fortigate.topology (1).json'] as const;

export function importLab(file: string): ImportedLab {
  const raw = JSON.parse(readFileSync(join(__dirname, '../../new_firewall', file), 'utf8')) as {
    devices: ExportedDevice[]; connections: ExportedConnection[];
  };
  const byId = new Map(raw.devices.map((device) => [device.id, device]));
  const links = raw.connections.map((connection, index): RoutedLink => {
    const source = byId.get(connection.sourceDeviceId)!;
    const target = byId.get(connection.targetDeviceId)!;
    return {
      id: `c${index}`, sourceDeviceId: source.id, targetDeviceId: target.id,
      source: { x: source.x, y: source.y }, target: { x: target.x, y: target.y },
      sourceInterface: connection.sourceInterfaceId, targetInterface: connection.targetInterfaceId,
    };
  });
  return { name: file, devices: raw.devices, links };
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

const rectOf = (box: { at: Point; halfWidth: number; halfHeight: number }): Rect => ({
  x0: box.at.x - box.halfWidth, y0: box.at.y - box.halfHeight, x1: box.at.x + box.halfWidth, y1: box.at.y + box.halfHeight,
});

const overlaps = (a: Rect, b: Rect, margin = 0): boolean =>
  a.x0 < b.x1 - margin && a.x1 > b.x0 + margin && a.y0 < b.y1 - margin && a.y1 > b.y0 + margin;

function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return x0 < rect.x1 && x1 > rect.x0 && y0 < rect.y1 && y1 > rect.y0;
}

function properCrossing(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const aHorizontal = a0.y === a1.y;
  const bHorizontal = b0.y === b1.y;
  if (aHorizontal === bHorizontal) return false;
  const [h0, h1, v0, v1] = aHorizontal ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
  const x = v0.x, y = h0.y;
  const eps = 0.5;
  return x > Math.min(h0.x, h1.x) + eps && x < Math.max(h0.x, h1.x) - eps
    && y > Math.min(v0.y, v1.y) + eps && y < Math.max(v0.y, v1.y) - eps;
}

function collinearOverlap(a0: Point, a1: Point, b0: Point, b1: Point): number {
  const eps = 0.5;
  if (Math.abs(a0.y - a1.y) < eps && Math.abs(b0.y - b1.y) < eps && Math.abs(a0.y - b0.y) < 3) {
    return Math.max(0, Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)));
  }
  if (Math.abs(a0.x - a1.x) < eps && Math.abs(b0.x - b1.x) < eps && Math.abs(a0.x - b0.x) < 3) {
    return Math.max(0, Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) - Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y)));
  }
  return 0;
}

export interface LayoutMetrics {
  readonly cables: number;
  readonly throughDevices: number;
  readonly crossings: number;
  readonly overlapPixels: number;
  readonly hiddenTags: number;
  readonly tagOnTag: number;
  readonly tagOnDevice: number;
  readonly tagOnCable: number;
  readonly bends: number;
  readonly length: number;
}

export function measure(lab: ImportedLab, routes: ReadonlyMap<string, CableRoute>, zoom = 1): LayoutMetrics {
  const deviceRects = lab.devices.map((device) => ({
    id: device.id, rects: deviceObstacles({ x: device.x, y: device.y }).map(rectOf),
  }));
  let throughDevices = 0, crossings = 0, overlapPixels = 0, bends = 0, length = 0;
  const ids = lab.links.map((link) => link.id);
  const linkById = new Map(lab.links.map((link) => [link.id, link]));
  for (const id of ids) {
    const link = linkById.get(id)!;
    const points = routes.get(id)!.points;
    bends += Math.max(0, points.length - 2);
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    for (const device of deviceRects) {
      if (device.id === link.sourceDeviceId || device.id === link.targetDeviceId) continue;
      let hit = false;
      for (let i = 1; i < points.length && !hit; i++) {
        hit = device.rects.some((rect) => segmentHitsRect(points[i - 1], points[i], rect));
      }
      if (hit) throughDevices++;
    }
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = routes.get(ids[i])!.points;
      const b = routes.get(ids[j])!.points;
      for (let p = 1; p < a.length; p++) {
        for (let q = 1; q < b.length; q++) {
          if (properCrossing(a[p - 1], a[p], b[q - 1], b[q])) crossings++;
          overlapPixels += collinearOverlap(a[p - 1], a[p], b[q - 1], b[q]);
        }
      }
    }
  }
  const tags: Array<{ rect: Rect; owner: string }> = [];
  let hiddenTags = 0;
  for (const id of ids) {
    const route = routes.get(id)!;
    for (const label of [route.sourceLabel, route.targetLabel]) {
      if (!label.shown) { hiddenTags++; continue; }
      const halfWidth = label.vertical ? TAG_HEIGHT / (2 * zoom) : label.halfLength;
      const halfHeight = label.vertical ? label.halfLength : TAG_HEIGHT / (2 * zoom);
      tags.push({ rect: rectOf({ at: label.at, halfWidth, halfHeight }), owner: id });
    }
  }
  let tagOnTag = 0, tagOnDevice = 0, tagOnCable = 0;
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) if (overlaps(tags[i].rect, tags[j].rect)) tagOnTag++;
    for (const device of deviceRects) if (device.rects.some((rect) => overlaps(tags[i].rect, rect))) tagOnDevice++;
    for (const id of ids) {
      if (id === tags[i].owner) continue;
      const points = routes.get(id)!.points;
      for (let p = 1; p < points.length; p++) {
        if (segmentHitsRect(points[p - 1], points[p], tags[i].rect)) { tagOnCable++; break; }
      }
    }
  }
  return {
    cables: ids.length, throughDevices, crossings, overlapPixels: Math.round(overlapPixels),
    hiddenTags, tagOnTag, tagOnDevice, tagOnCable, bends, length: Math.round(length),
  };
}

export function routeLab(
  lab: ImportedLab, zoom = 1, previous?: ReadonlyMap<string, CableRoute>, refine = true,
): Map<string, CableRoute> {
  return computeCableRoutes(lab.links, lab.devices.map((device) => ({ x: device.x, y: device.y })), zoom, previous, refine);
}

export function moveDevice(lab: ImportedLab, id: string, x: number, y: number): ImportedLab {
  const devices = lab.devices.map((device) => (device.id === id ? { ...device, x, y } : device));
  const at = new Map(devices.map((device) => [device.id, device]));
  const links = lab.links.map((link) => ({
    ...link,
    source: { x: at.get(link.sourceDeviceId)!.x, y: at.get(link.sourceDeviceId)!.y },
    target: { x: at.get(link.targetDeviceId)!.x, y: at.get(link.targetDeviceId)!.y },
  }));
  return { ...lab, devices, links };
}
