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
  computeCableRoutes,
  laneSpacing,
  pointAlongPolyline,
  abbreviateInterfaceName,
  NODE_HALF_WIDTH,
  NODE_HALF_HEIGHT,
  NODE_CENTER_OFFSET_Y,
} from '@/components/network/connection-line-logic';

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

  describe('cables leaving one device by the same face', () => {
    const centres = (count: number) => [
      { x: 100, y: 100 },
      ...Array.from({ length: count }, (_, i) => ({ x: 500, y: 60 + i * 40 })),
    ];
    const face = (count: number) => Array.from({ length: count }, (_, i) => ({
      id: `c${i}`,
      sourceDeviceId: 'A',
      targetDeviceId: `B${i}`,
      source: { x: 100, y: 100 },
      target: { x: 500, y: 60 + i * 40 },
      sourceInterface: `Gi0/${i}`,
      targetInterface: 'eth0',
    }));

    it('gives a lone cable no lane at all', () => {
      const routes = computeCableRoutes(face(1), centres(1));
      expect(routes.get('c0')!.sourceLane).toBe(0);
      expect(routes.get('c0')!.targetLane).toBe(0);
    });

    it('centres the fan on the direct route', () => {
      const routes = computeCableRoutes(face(4), centres(4));
      const lanes = [0, 1, 2, 3].map(i => routes.get(`c${i}`)!.sourceLane);
      expect(lanes[0]).toBeLessThan(0);
      expect(lanes[3]).toBeGreaterThan(0);
      expect(lanes.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    });

    it('separates every cable of the fan on the wire', () => {
      const routes = computeCableRoutes(face(4), centres(4));
      const ys = [0, 1, 2, 3].map(i => routes.get(`c${i}`)!.points[0].y);
      expect(new Set(ys).size).toBe(4);
    });

    it('keeps a wide fan on the card rather than off it', () => {
      const routes = computeCableRoutes(face(8), centres(8));
      for (let i = 0; i < 8; i++) {
        expect(Math.abs(routes.get(`c${i}`)!.sourceLane)).toBeLessThanOrEqual(NODE_HALF_HEIGHT);
      }
    });

    it('a single cable keeps the direct route', () => {
      const plain = computeConnectionPath({ x: 100, y: 100 }, { x: 500, y: 100 });
      const solo = computeConnectionPath(
        { x: 100, y: 100 }, { x: 500, y: 100 }, { sourceLane: 0, targetLane: 0 });
      expect(solo.path).toBe(plain.path);
    });

    it('narrows the spacing only once the face is full', () => {
      expect(laneSpacing(1, 'right')).toBe(0);
      expect(laneSpacing(3, 'right')).toBe(18);
      expect(laneSpacing(9, 'right')).toBeLessThan(18);
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

});
