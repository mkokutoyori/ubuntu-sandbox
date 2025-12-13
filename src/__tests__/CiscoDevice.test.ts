/**
 * CiscoDevice Unit Tests
 * Tests Cisco router and switch device creation and positioning
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoDevice, createCiscoRouter, createCiscoSwitch } from '../devices/cisco/CiscoDevice';

describe('CiscoDevice', () => {
  describe('Cisco Router', () => {
    let router: CiscoDevice;

    beforeEach(() => {
      router = createCiscoRouter({
        id: 'test-router-1',
        name: 'Router1',
        x: 100,
        y: 200
      });
    });

    describe('Device Properties', () => {
      it('should have correct OS type', () => {
        expect(router.getOSType()).toBe('cisco-ios');
      });

      it('should have correct device type', () => {
        expect(router.getDeviceType()).toBe('router-cisco');
      });

      it('should have correct hostname', () => {
        expect(router.getHostname()).toBe('router1');
      });

      it('should be powered on by default', () => {
        expect(router.getIsPoweredOn()).toBe(true);
      });
    });

    describe('Positioning', () => {
      it('should be created at specified position', () => {
        const position = router.getPosition();
        expect(position.x).toBe(100);
        expect(position.y).toBe(200);
      });

      it('should default to (0, 0) when no position provided', () => {
        const defaultRouter = createCiscoRouter({
          id: 'test-router-2',
          name: 'Router2'
        });
        const position = defaultRouter.getPosition();
        expect(position.x).toBe(0);
        expect(position.y).toBe(0);
      });

      it('should update position correctly', () => {
        router.setPosition(300, 400);
        const position = router.getPosition();
        expect(position.x).toBe(300);
        expect(position.y).toBe(400);
      });

      it('should handle decimal positions', () => {
        const decimalRouter = createCiscoRouter({
          id: 'test-router-3',
          name: 'Router3',
          x: 123.456,
          y: 789.012
        });
        const position = decimalRouter.getPosition();
        expect(position.x).toBe(123.456);
        expect(position.y).toBe(789.012);
      });
    });

    describe('CLI Prompt', () => {
      it('should return user mode prompt', () => {
        const prompt = router.getPrompt();
        // Prompt uses lowercase hostname
        expect(prompt).toBe('router1>');
      });
    });

    describe('Basic Commands', () => {
      it('should reject invalid commands', () => {
        const result = router.executeCommand('invalidcommand');
        expect(result.exitCode).not.toBe(0);
      });

      it('should handle help command', () => {
        const result = router.executeCommand('?');
        // Help command should work in user mode
        expect(result.output).toBeDefined();
      });

      it('should execute ping (returns message about requiring terminal)', () => {
        const result = router.executeCommand('ping 192.168.1.1');
        // Ping requires terminal for interactive output
        expect(result).toBeDefined();
      });
    });
  });

  describe('Cisco Switch', () => {
    let switchDevice: CiscoDevice;

    beforeEach(() => {
      switchDevice = createCiscoSwitch({
        id: 'test-switch-1',
        name: 'Switch1',
        x: 150,
        y: 250
      });
    });

    describe('Device Properties', () => {
      it('should have correct OS type', () => {
        expect(switchDevice.getOSType()).toBe('cisco-ios');
      });

      it('should have correct device type', () => {
        expect(switchDevice.getDeviceType()).toBe('switch-cisco');
      });

      it('should have correct hostname', () => {
        expect(switchDevice.getHostname()).toBe('switch1');
      });
    });

    describe('Positioning', () => {
      it('should be created at specified position', () => {
        const position = switchDevice.getPosition();
        expect(position.x).toBe(150);
        expect(position.y).toBe(250);
      });

      it('should default to (0, 0) when no position provided', () => {
        const defaultSwitch = createCiscoSwitch({
          id: 'test-switch-2',
          name: 'Switch2'
        });
        const position = defaultSwitch.getPosition();
        expect(position.x).toBe(0);
        expect(position.y).toBe(0);
      });

      it('should update position correctly', () => {
        switchDevice.setPosition(500, 600);
        const position = switchDevice.getPosition();
        expect(position.x).toBe(500);
        expect(position.y).toBe(600);
      });
    });

    describe('Switch-specific Commands', () => {
      it('should execute show vlan', () => {
        switchDevice.executeCommand('enable');
        const result = switchDevice.executeCommand('show vlan');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('VLAN');
      });

      it('should execute show mac address-table', () => {
        switchDevice.executeCommand('enable');
        const result = switchDevice.executeCommand('show mac address-table');
        expect(result.exitCode).toBe(0);
      });
    });
  });

  describe('Device Creation Comparison', () => {
    it('router and switch should be at different positions when specified', () => {
      const router = createCiscoRouter({
        id: 'router-test',
        name: 'RouterTest',
        x: 100,
        y: 100
      });

      const switchDevice = createCiscoSwitch({
        id: 'switch-test',
        name: 'SwitchTest',
        x: 200,
        y: 200
      });

      const routerPos = router.getPosition();
      const switchPos = switchDevice.getPosition();

      expect(routerPos.x).not.toBe(switchPos.x);
      expect(routerPos.y).not.toBe(switchPos.y);
    });

    it('should create unique device IDs', () => {
      const router1 = createCiscoRouter({ id: 'router-1', name: 'Router1' });
      const router2 = createCiscoRouter({ id: 'router-2', name: 'Router2' });

      expect(router1.getId()).toBe('router-1');
      expect(router2.getId()).toBe('router-2');
      expect(router1.getId()).not.toBe(router2.getId());
    });
  });
});
