/**
 * TDD RED Phase - Tests for ConnectionLine logic
 *
 * Tests the pure computation functions extracted from ConnectionLine:
 * - Path calculation (bezier curve)
 * - Color and dash pattern by type
 * - Interface label positioning
 * - Connection midpoint info (type label, bandwidth)
 */

import { describe, it, expect } from 'vitest';
import {
  computeConnectionPath,
  getConnectionColor,
  getConnectionDash,
  computeInterfaceLabelPositions,
  getConnectionMidpointInfo,
  computeBundleSlots,
  bundleOffset,
  pointAlongPolyline,
  abbreviateInterfaceName,
  NODE_HALF_WIDTH,
  NODE_HALF_HEIGHT,
  NODE_CENTER_OFFSET_Y,
} from '@/components/network/connection-line-logic';
import type { Connection } from '@/store/networkStore';

describe('connection-line-logic', () => {
  // ── computeConnectionPath ───────────────────────────────────────────

  describe('computeConnectionPath', () => {
    it('routes with horizontal and vertical runs only', () => {
      const { points } = computeConnectionPath({ x: 100, y: 100 }, { x: 400, y: 300 });
      expect(points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < points.length; i++) {
        const dx = Math.abs(points[i].x - points[i - 1].x);
        const dy = Math.abs(points[i].y - points[i - 1].y);
        expect(dx < 0.001 || dy < 0.001).toBe(true);
      }
    });

    it('leaves sideways when the run is mostly horizontal', () => {
      const { points } = computeConnectionPath({ x: 100, y: 100 }, { x: 500, y: 140 });
      expect(points[0].y).toBeCloseTo(points[1].y, 6);
      expect(points[0].x).toBe(100 + NODE_HALF_WIDTH);
    });

    it('leaves vertically when the run is mostly vertical', () => {
      const { points } = computeConnectionPath({ x: 100, y: 100 }, { x: 140, y: 500 });
      expect(points[0].x).toBeCloseTo(points[1].x, 6);
      expect(points[0].y).toBe(100 + NODE_CENTER_OFFSET_Y + NODE_HALF_HEIGHT);
    });

    it('rounds its corners', () => {
      const { path } = computeConnectionPath({ x: 100, y: 100 }, { x: 400, y: 300 });
      expect(path).toMatch(/^M\s/);
      expect(path).toContain('Q');
    });

    it('draws a straight run with no corner at all', () => {
      const { path } = computeConnectionPath({ x: 100, y: 100 }, { x: 400, y: 100 });
      expect(path).not.toContain('Q');
    });
  });

  describe('bundles between the same two devices', () => {
    const links = [
      { id: 'c3', sourceDeviceId: 'A', targetDeviceId: 'B' },
      { id: 'c1', sourceDeviceId: 'B', targetDeviceId: 'A' },
      { id: 'c2', sourceDeviceId: 'A', targetDeviceId: 'B' },
      { id: 'solo', sourceDeviceId: 'A', targetDeviceId: 'C' },
    ];

    it('groups both directions into one bundle', () => {
      const slots = computeBundleSlots(links);
      expect(slots.get('c1')).toEqual({ index: 0, size: 3 });
      expect(slots.get('c2')).toEqual({ index: 1, size: 3 });
      expect(slots.get('c3')).toEqual({ index: 2, size: 3 });
      expect(slots.get('solo')).toEqual({ index: 0, size: 1 });
    });

    it('gives a lone cable no offset at all', () => {
      expect(bundleOffset({ index: 0, size: 1 })).toBe(0);
      expect(bundleOffset(undefined)).toBe(0);
    });

    it('centres the bundle on the direct route', () => {
      const offsets = [0, 1, 2, 3].map(i => bundleOffset({ index: i, size: 4 }));
      expect(offsets[0]).toBeLessThan(0);
      expect(offsets[3]).toBeGreaterThan(0);
      expect(offsets.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    });

    it('separates every cable of a bundle on the wire', () => {
      const a = { x: 100, y: 100 };
      const b = { x: 500, y: 100 };
      const ys = [0, 1, 2, 3].map(
        i => computeConnectionPath(a, b, { index: i, size: 4 }).points[0].y);
      expect(new Set(ys).size).toBe(4);
    });

    it('a single cable keeps the direct route', () => {
      const plain = computeConnectionPath({ x: 100, y: 100 }, { x: 500, y: 100 });
      const solo = computeConnectionPath(
        { x: 100, y: 100 }, { x: 500, y: 100 }, { index: 0, size: 1 });
      expect(solo.path).toBe(plain.path);
    });
  });

  describe('the packet follows the cable', () => {
    it('samples the very path the cable draws', () => {
      const { points } = computeConnectionPath({ x: 100, y: 100 }, { x: 400, y: 300 });
      expect(pointAlongPolyline(points, 0)).toEqual(points[0]);
      expect(pointAlongPolyline(points, 1)).toEqual(points[points.length - 1]);
      const mid = pointAlongPolyline(points, 0.5);
      const onSomeSegment = points.slice(1).some((p, i) => {
        const q = points[i];
        const horizontal = Math.abs(p.y - q.y) < 0.001 && Math.abs(mid.y - p.y) < 0.001;
        const vertical = Math.abs(p.x - q.x) < 0.001 && Math.abs(mid.x - p.x) < 0.001;
        return horizontal || vertical;
      });
      expect(onSomeSegment).toBe(true);
    });

    it('clamps outside the run instead of extrapolating', () => {
      const { points } = computeConnectionPath({ x: 0, y: 0 }, { x: 300, y: 0 });
      expect(pointAlongPolyline(points, -5)).toEqual(points[0]);
      expect(pointAlongPolyline(points, 5)).toEqual(points[points.length - 1]);
    });
  });

  describe('abbreviateInterfaceName', () => {
    it('shortens the vendor spellings an operator reads', () => {
      expect(abbreviateInterfaceName('FastEthernet0/1')).toBe('Fa0/1');
      expect(abbreviateInterfaceName('GigabitEthernet0/0')).toBe('Gi0/0');
      expect(abbreviateInterfaceName('GigabitEthernet0/0/1')).toBe('GE0/0/1');
      expect(abbreviateInterfaceName('TenGigabitEthernet1/1')).toBe('Te1/1');
      expect(abbreviateInterfaceName('Serial0/0/0')).toBe('Se0/0/0');
      expect(abbreviateInterfaceName('Loopback0')).toBe('Lo0');
    });

    it('leaves alone a name that is already short', () => {
      expect(abbreviateInterfaceName('eth0')).toBe('eth0');
      expect(abbreviateInterfaceName('Vlanif10')).toBe('Vlanif10');
      expect(abbreviateInterfaceName('Eth-Trunk1')).toBe('Eth-Trunk1');
    });
  });

  // ── getConnectionColor ──────────────────────────────────────────────

  describe('getConnectionColor', () => {
    it('should return blue for ethernet', () => {
      expect(getConnectionColor('ethernet')).toBe('#3b82f6');
    });

    it('should return orange for serial', () => {
      expect(getConnectionColor('serial')).toBe('#f97316');
    });

    it('should return gray for console', () => {
      expect(getConnectionColor('console')).toBe('#64748b');
    });
  });

  // ── getConnectionDash ──────────────────────────────────────────────

  describe('getConnectionDash', () => {
    it('should return solid line for ethernet', () => {
      expect(getConnectionDash('ethernet')).toBe('');
    });

    it('should return dashed for serial', () => {
      expect(getConnectionDash('serial')).toBe('10,5');
    });

    it('should return dotted-dash for console', () => {
      const dash = getConnectionDash('console');
      expect(dash).toBeTruthy(); // Console should have a dash pattern
    });
  });

  // ── computeInterfaceLabelPositions ──────────────────────────────────

  describe('computeInterfaceLabelPositions', () => {
    it('should compute label positions near source and target', () => {
      const positions = computeInterfaceLabelPositions(
        { x: 100, y: 100 },
        { x: 400, y: 100 }
      );

      // Source label should be near source point
      expect(positions.source.x).toBeGreaterThan(100);
      expect(positions.source.x).toBeLessThan(250); // Before midpoint

      // Target label should be near target point
      expect(positions.target.x).toBeGreaterThan(250); // After midpoint
      expect(positions.target.x).toBeLessThan(400);
    });

    it('should offset labels vertically to avoid overlap with line', () => {
      const positions = computeInterfaceLabelPositions(
        { x: 100, y: 200 },
        { x: 400, y: 200 }
      );

      // Labels should be offset from the line
      expect(positions.source.y).not.toBe(200);
      expect(positions.target.y).not.toBe(200);
    });
  });

  // ── getConnectionMidpointInfo ───────────────────────────────────────

  describe('getConnectionMidpointInfo', () => {
    it('should return type label and bandwidth for ethernet connection', () => {
      const connection: Connection = {
        id: 'conn-1', type: 'ethernet',
        sourceDeviceId: 'dev-1', sourceInterfaceId: 'eth0',
        targetDeviceId: 'dev-2', targetInterfaceId: 'eth0',
        cable: {} as Connection['cable']
              };

      const info = getConnectionMidpointInfo(connection);
      expect(info.typeLabel).toBe('Ethernet');
      expect(info.color).toBe('#3b82f6');
    });

    it('should return serial info for serial connection', () => {
      const connection: Connection = {
        id: 'conn-1', type: 'serial',
        sourceDeviceId: 'dev-1', sourceInterfaceId: 'serial0/0',
        targetDeviceId: 'dev-2', targetInterfaceId: 'serial0/0',
        cable: {} as Connection['cable']
              };

      const info = getConnectionMidpointInfo(connection);
      expect(info.typeLabel).toBe('Serial');
      expect(info.color).toBe('#f97316');
    });

    it('should return console info for console connection', () => {
      const connection: Connection = {
        id: 'conn-1', type: 'console',
        sourceDeviceId: 'dev-1', sourceInterfaceId: 'console0',
        targetDeviceId: 'dev-2', targetInterfaceId: 'console0',
        cable: {} as Connection['cable']
              };

      const info = getConnectionMidpointInfo(connection);
      expect(info.typeLabel).toBe('Console');
      expect(info.color).toBe('#64748b');
    });
  });
});
