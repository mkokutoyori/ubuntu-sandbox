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
  getConnectionMidpointInfo
} from '@/components/network/connection-line-logic';
import type { Connection } from '@/store/networkStore';

describe('connection-line-logic', () => {
  // ── computeConnectionPath ───────────────────────────────────────────

  describe('computeConnectionPath', () => {
    it('should compute a valid SVG path between two points', () => {
      const result = computeConnectionPath(
        { x: 100, y: 100 },
        { x: 400, y: 100 }
      );

      expect(result.path).toMatch(/^M\s/); // Starts with M (moveto)
      expect(result.path).toContain('Q');   // Contains Q (quadratic bezier)
      expect(result.midX).toBe(250);        // Midpoint X
    });

    it('should apply curve factor based on distance', () => {
      const shortResult = computeConnectionPath(
        { x: 100, y: 100 },
        { x: 150, y: 100 }
      );
      const longResult = computeConnectionPath(
        { x: 100, y: 100 },
        { x: 600, y: 100 }
      );

      // Longer connections should have more curve
      expect(longResult.curveFactor).toBeGreaterThanOrEqual(shortResult.curveFactor);
    });

    it('should cap curve factor at maximum value', () => {
      const result = computeConnectionPath(
        { x: 0, y: 0 },
        { x: 10000, y: 0 }
      );

      expect(result.curveFactor).toBeLessThanOrEqual(50);
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
        isActive: true
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
        isActive: true
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
        isActive: true
      };

      const info = getConnectionMidpointInfo(connection);
      expect(info.typeLabel).toBe('Console');
      expect(info.color).toBe('#64748b');
    });
  });
});
