/**
 * TDD Tests for Linux `ip` command (iproute2)
 *
 * Tests the ip command handler in isolation using a mock IpNetworkContext.
 * Covers: ip addr, ip link, ip route, ip neigh, ip help
 *
 * Realistic error messages matching iproute2 output.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeIpCommand,
  type IpNetworkContext,
  type IpInterfaceInfo,
  type IpRouteEntry,
  type IpNeighborEntry,
} from '@/network/devices/linux/LinuxIpCommand';

// ─── Mock IpNetworkContext ──────────────────────────────────────────────

function createMockContext(overrides: Partial<IpNetworkContext> = {}): IpNetworkContext {
  const interfaces: Map<string, IpInterfaceInfo> = new Map([
    ['lo', {
      name: 'lo',
      mac: '00:00:00:00:00:00',
      ip: '127.0.0.1',
      mask: '255.0.0.0',
      cidr: 8,
      mtu: 65536,
      isUp: true,
      isConnected: true,
      isDHCP: false,
      counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
    }],
    ['eth0', {
      name: 'eth0',
      mac: 'aa:bb:cc:dd:ee:01',
      ip: '192.168.1.10',
      mask: '255.255.255.0',
      cidr: 24,
      mtu: 1500,
      isUp: true,
      isConnected: true,
      isDHCP: false,
      counters: { framesIn: 100, framesOut: 50, bytesIn: 10240, bytesOut: 5120 },
    }],
    ['eth1', {
      name: 'eth1',
      mac: 'aa:bb:cc:dd:ee:02',
      ip: null,
      mask: null,
      cidr: null,
      mtu: 1500,
      isUp: true,
      isConnected: false,
      isDHCP: false,
      counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
    }],
  ]);

  const routes: IpRouteEntry[] = [];
  const neighbors: IpNeighborEntry[] = [];

  return {
    getInterfaceNames: () => [...interfaces.keys()],
    getInterfaceInfo: (name: string) => interfaces.get(name) || null,
    configureInterface: (ifName: string, ip: string, cidr: number) => {
      const iface = interfaces.get(ifName);
      if (!iface) return `Cannot find device "${ifName}"`;
      iface.ip = ip;
      iface.cidr = cidr;
      // Simple mask computation for /24
      const maskBits = (0xFFFFFFFF << (32 - cidr)) >>> 0;
      iface.mask = [
        (maskBits >>> 24) & 0xFF,
        (maskBits >>> 16) & 0xFF,
        (maskBits >>> 8) & 0xFF,
        maskBits & 0xFF,
      ].join('.');
      return '';
    },
    removeInterfaceIP: (ifName: string) => {
      const iface = interfaces.get(ifName);
      if (!iface) return `Cannot find device "${ifName}"`;
      iface.ip = null;
      iface.mask = null;
      iface.cidr = null;
      return '';
    },
    getRoutingTable: () => routes,
    addDefaultRoute: (gateway: string) => {
      routes.push({
        network: '0.0.0.0',
        cidr: 0,
        nextHop: gateway,
        iface: 'eth0',
        type: 'default',
        metric: 0,
        isDHCP: false,
      });
      return '';
    },
    addStaticRoute: (network: string, cidr: number, gateway: string, metric?: number) => {
      routes.push({
        network,
        cidr,
        nextHop: gateway,
        iface: 'eth0',
        type: 'static',
        metric: metric ?? 100,
        isDHCP: false,
      });
      return '';
    },
    deleteDefaultRoute: () => {
      const idx = routes.findIndex(r => r.type === 'default');
      if (idx === -1) return 'RTNETLINK answers: No such process';
      routes.splice(idx, 1);
      return '';
    },
    deleteRoute: (network: string, cidr: number) => {
      const idx = routes.findIndex(r => r.network === network && r.cidr === cidr && r.type === 'static');
      if (idx === -1) return 'RTNETLINK answers: No such process';
      routes.splice(idx, 1);
      return '';
    },
    getNeighborTable: () => neighbors,
    setInterfaceUp: (ifName: string) => {
      const iface = interfaces.get(ifName);
      if (!iface) return `Cannot find device "${ifName}"`;
      iface.isUp = true;
      return '';
    },
    setInterfaceDown: (ifName: string) => {
      const iface = interfaces.get(ifName);
      if (!iface) return `Cannot find device "${ifName}"`;
      iface.isUp = false;
      return '';
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: ip help / unknown subcommands
// ═══════════════════════════════════════════════════════════════════

describe('ip command', () => {

  describe('IP-01: Help and unknown subcommands', () => {
    let ctx: IpNetworkContext;
    beforeEach(() => { ctx = createMockContext(); });

    it('should display help when called with no arguments', () => {
      const output = executeIpCommand(ctx, []);
      expect(output).toContain('Usage: ip [ OPTIONS ] OBJECT');
      expect(output).toContain('addr');
      expect(output).toContain('route');
      expect(output).toContain('link');
      expect(output).toContain('neigh');
    });

    it('should display help with "ip help"', () => {
      const output = executeIpCommand(ctx, ['help']);
      expect(output).toContain('Usage: ip [ OPTIONS ] OBJECT');
    });

    it('should display help with "ip -h"', () => {
      const output = executeIpCommand(ctx, ['-h']);
      expect(output).toContain('Usage: ip [ OPTIONS ] OBJECT');
    });

    it('should return error for unknown object', () => {
      const output = executeIpCommand(ctx, ['xyz']);
      expect(output).toContain('Object "xyz" is unknown, try "ip help".');
    });

    it('should return error for another unknown object', () => {
      const output = executeIpCommand(ctx, ['foobar']);
      expect(output).toContain('Object "foobar" is unknown, try "ip help".');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 2: ip addr
  // ═══════════════════════════════════════════════════════════════════

  describe('IP-02: ip addr', () => {
    let ctx: IpNetworkContext;
    beforeEach(() => { ctx = createMockContext(); });

    it('should show all interfaces with "ip addr" (no args)', () => {
      const output = executeIpCommand(ctx, ['addr']);
      // Should list lo, eth0, eth1
      expect(output).toContain('lo');
      expect(output).toContain('eth0');
      expect(output).toContain('eth1');
      // eth0 should have its IP
      expect(output).toContain('192.168.1.10/24');
      // eth0 should show MAC
      expect(output).toContain('aa:bb:cc:dd:ee:01');
      // lo should show 127.0.0.1
      expect(output).toContain('127.0.0.1/8');
    });

    it('should show all interfaces with "ip address" alias', () => {
      const output = executeIpCommand(ctx, ['address']);
      expect(output).toContain('eth0');
      expect(output).toContain('192.168.1.10/24');
    });

    it('should show all interfaces with "ip a" alias', () => {
      const output = executeIpCommand(ctx, ['a']);
      expect(output).toContain('eth0');
    });

    it('should show all interfaces with "ip addr show"', () => {
      const output = executeIpCommand(ctx, ['addr', 'show']);
      expect(output).toContain('eth0');
      expect(output).toContain('192.168.1.10/24');
    });

    it('should filter by device with "ip addr show dev eth0"', () => {
      const output = executeIpCommand(ctx, ['addr', 'show', 'dev', 'eth0']);
      expect(output).toContain('eth0');
      expect(output).toContain('192.168.1.10/24');
      expect(output).not.toContain('eth1');
      // Should not contain lo as a separate interface line
      expect(output).not.toMatch(/^\d+:\s+lo:/m);
    });

    it('should show interface state (UP/DOWN)', () => {
      const output = executeIpCommand(ctx, ['addr', 'show', 'dev', 'eth0']);
      // Connected interface should show UP
      expect(output).toMatch(/UP/);
      expect(output).toContain('state UP');
    });

    it('should show DOWN state for disconnected interface', () => {
      const output = executeIpCommand(ctx, ['addr', 'show', 'dev', 'eth1']);
      expect(output).toContain('state DOWN');
    });

    it('should show no inet line for interface without IP', () => {
      const output = executeIpCommand(ctx, ['addr', 'show', 'dev', 'eth1']);
      expect(output).not.toContain('inet ');
    });

    it('should return error for nonexistent device', () => {
      const output = executeIpCommand(ctx, ['addr', 'show', 'dev', 'wlan0']);
      expect(output).toContain('Device "wlan0" does not exist.');
    });

    it('should add IP address to interface', () => {
      const output = executeIpCommand(ctx, ['addr', 'add', '10.0.0.5/24', 'dev', 'eth1']);
      expect(output).toBe('');
      // Verify it was configured
      const info = ctx.getInterfaceInfo('eth1');
      expect(info?.ip).toBe('10.0.0.5');
      expect(info?.cidr).toBe(24);
    });

    it('should return error when adding IP without CIDR', () => {
      const output = executeIpCommand(ctx, ['addr', 'add', '10.0.0.5', 'dev', 'eth1']);
      expect(output).toContain('Error: either "local" or "peer" address is required.');
    });

    it('should return error when adding IP without dev', () => {
      const output = executeIpCommand(ctx, ['addr', 'add', '10.0.0.5/24']);
      expect(output).toContain('Not enough information: "dev" argument is required.');
    });

    it('should return error when adding IP to nonexistent device', () => {
      const output = executeIpCommand(ctx, ['addr', 'add', '10.0.0.5/24', 'dev', 'wlan0']);
      expect(output).toContain('Cannot find device "wlan0"');
    });

    it('should delete IP address from interface', () => {
      const output = executeIpCommand(ctx, ['addr', 'del', '192.168.1.10/24', 'dev', 'eth0']);
      expect(output).toBe('');
      // Verify IP was removed
      const info = ctx.getInterfaceInfo('eth0');
      expect(info?.ip).toBeNull();
    });

    it('should return error when deleting IP from nonexistent device', () => {
      const output = executeIpCommand(ctx, ['addr', 'del', '10.0.0.5/24', 'dev', 'wlan0']);
      expect(output).toContain('Cannot find device "wlan0"');
    });

    it('should show "dynamic" flag for DHCP-configured interface', () => {
      const ctx2 = createMockContext({
        getInterfaceInfo: (name: string) => {
          if (name === 'eth0') return {
            name: 'eth0', mac: 'aa:bb:cc:dd:ee:01',
            ip: '192.168.1.50', mask: '255.255.255.0', cidr: 24,
            mtu: 1500, isUp: true, isConnected: true, isDHCP: true,
            counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
          };
          return null;
        },
        getInterfaceNames: () => ['eth0'],
      });
      const output = executeIpCommand(ctx2, ['addr', 'show', 'dev', 'eth0']);
      expect(output).toContain('dynamic');
    });

    it('should show broadcast address', () => {
      const output = executeIpCommand(ctx, ['addr', 'show', 'dev', 'eth0']);
      expect(output).toContain('brd');
    });

    it('should display mtu in link line', () => {
      const output = executeIpCommand(ctx, ['addr', 'show', 'dev', 'eth0']);
      expect(output).toContain('mtu 1500');
    });

    it('should return error for unknown addr subcommand', () => {
      const output = executeIpCommand(ctx, ['addr', 'foobar']);
      expect(output).toContain('Command "foobar" is unknown, try "ip addr help".');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 3: ip link
  // ═══════════════════════════════════════════════════════════════════

  describe('IP-03: ip link', () => {
    let ctx: IpNetworkContext;
    beforeEach(() => { ctx = createMockContext(); });

    it('should show all interfaces with "ip link show"', () => {
      const output = executeIpCommand(ctx, ['link', 'show']);
      expect(output).toContain('lo');
      expect(output).toContain('eth0');
      expect(output).toContain('eth1');
      // Should show MAC addresses
      expect(output).toContain('aa:bb:cc:dd:ee:01');
    });

    it('should show all interfaces with "ip link" (no subcommand)', () => {
      const output = executeIpCommand(ctx, ['link']);
      expect(output).toContain('eth0');
    });

    it('should show all interfaces with "ip l" alias', () => {
      const output = executeIpCommand(ctx, ['l']);
      expect(output).toContain('eth0');
    });

    it('should filter by device with "ip link show dev eth0"', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'eth0']);
      expect(output).toContain('eth0');
      expect(output).not.toContain('eth1');
      expect(output).not.toContain('lo');
    });

    it('should return error for nonexistent device', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'wlan0']);
      expect(output).toContain('Device "wlan0" does not exist.');
    });

    it('should show link state flags (UP, LOWER_UP, etc.)', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'eth0']);
      expect(output).toContain('UP');
      expect(output).toContain('BROADCAST');
      expect(output).toContain('MULTICAST');
    });

    it('should show LOWER_UP for connected interface', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'eth0']);
      expect(output).toContain('LOWER_UP');
    });

    it('should NOT show LOWER_UP for disconnected interface', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'eth1']);
      expect(output).not.toContain('LOWER_UP');
    });

    it('should bring interface down with "ip link set eth0 down"', () => {
      const output = executeIpCommand(ctx, ['link', 'set', 'eth0', 'down']);
      expect(output).toBe('');
      // Verify state changed
      const info = ctx.getInterfaceInfo('eth0');
      expect(info?.isUp).toBe(false);
    });

    it('should bring interface up with "ip link set eth0 up"', () => {
      // First bring down
      executeIpCommand(ctx, ['link', 'set', 'eth0', 'down']);
      // Then bring up
      const output = executeIpCommand(ctx, ['link', 'set', 'eth0', 'up']);
      expect(output).toBe('');
      const info = ctx.getInterfaceInfo('eth0');
      expect(info?.isUp).toBe(true);
    });

    it('should return error when setting nonexistent device', () => {
      const output = executeIpCommand(ctx, ['link', 'set', 'wlan0', 'up']);
      expect(output).toContain('Cannot find device "wlan0"');
    });

    it('should return error for missing device in set', () => {
      const output = executeIpCommand(ctx, ['link', 'set']);
      expect(output).toContain('Not enough information');
    });

    it('should show mtu value', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'eth0']);
      expect(output).toContain('mtu 1500');
    });

    it('should show qdisc and state', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'eth0']);
      expect(output).toContain('qdisc');
      expect(output).toContain('state UP');
    });

    it('should return error for unknown link subcommand', () => {
      const output = executeIpCommand(ctx, ['link', 'foobar']);
      expect(output).toContain('Command "foobar" is unknown, try "ip link help".');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 4: ip route
  // ═══════════════════════════════════════════════════════════════════

  describe('IP-04: ip route', () => {
    let ctx: IpNetworkContext;
    beforeEach(() => { ctx = createMockContext(); });

    it('should show empty routing table', () => {
      const output = executeIpCommand(ctx, ['route']);
      // Empty table — no output
      expect(output).toBe('');
    });

    it('should show routes with "ip route show"', () => {
      ctx.addDefaultRoute('192.168.1.1');
      const output = executeIpCommand(ctx, ['route', 'show']);
      expect(output).toContain('default via 192.168.1.1');
    });

    it('should show routes with "ip r" alias', () => {
      ctx.addDefaultRoute('192.168.1.1');
      const output = executeIpCommand(ctx, ['r']);
      expect(output).toContain('default via 192.168.1.1');
    });

    it('should add default route', () => {
      const output = executeIpCommand(ctx, ['route', 'add', 'default', 'via', '192.168.1.1']);
      expect(output).toBe('');
      // Verify route was added
      const routes = ctx.getRoutingTable();
      expect(routes.length).toBe(1);
      expect(routes[0].type).toBe('default');
      expect(routes[0].nextHop).toBe('192.168.1.1');
    });

    it('should add static route', () => {
      const output = executeIpCommand(ctx, ['route', 'add', '10.0.0.0/8', 'via', '192.168.1.1']);
      expect(output).toBe('');
      const routes = ctx.getRoutingTable();
      expect(routes.length).toBe(1);
      expect(routes[0].network).toBe('10.0.0.0');
      expect(routes[0].cidr).toBe(8);
    });

    it('should add static route with metric', () => {
      const output = executeIpCommand(ctx, ['route', 'add', '10.0.0.0/8', 'via', '192.168.1.1', 'metric', '200']);
      expect(output).toBe('');
      const routes = ctx.getRoutingTable();
      expect(routes[0].metric).toBe(200);
    });

    it('should delete default route', () => {
      ctx.addDefaultRoute('192.168.1.1');
      const output = executeIpCommand(ctx, ['route', 'del', 'default']);
      expect(output).toBe('');
      expect(ctx.getRoutingTable().length).toBe(0);
    });

    it('should return error deleting nonexistent default route', () => {
      const output = executeIpCommand(ctx, ['route', 'del', 'default']);
      expect(output).toContain('RTNETLINK answers: No such process');
    });

    it('should delete static route', () => {
      ctx.addStaticRoute('10.0.0.0', 8, '192.168.1.1');
      const output = executeIpCommand(ctx, ['route', 'del', '10.0.0.0/8']);
      expect(output).toBe('');
      expect(ctx.getRoutingTable().length).toBe(0);
    });

    it('should return error deleting nonexistent static route', () => {
      const output = executeIpCommand(ctx, ['route', 'del', '172.16.0.0/12']);
      expect(output).toContain('RTNETLINK answers: No such process');
    });

    it('should format connected routes properly', () => {
      // Add a connected route to the mock
      const routes = ctx.getRoutingTable();
      routes.push({
        network: '192.168.1.0',
        cidr: 24,
        nextHop: null,
        iface: 'eth0',
        type: 'connected',
        metric: 100,
        isDHCP: false,
        srcIp: '192.168.1.10',
      });
      const output = executeIpCommand(ctx, ['route', 'show']);
      expect(output).toContain('192.168.1.0/24');
      expect(output).toContain('dev eth0');
      expect(output).toContain('proto kernel');
      expect(output).toContain('scope link');
      expect(output).toContain('src 192.168.1.10');
    });

    it('should format default route with proto', () => {
      const routes = ctx.getRoutingTable();
      routes.push({
        network: '0.0.0.0',
        cidr: 0,
        nextHop: '192.168.1.1',
        iface: 'eth0',
        type: 'default',
        metric: 100,
        isDHCP: true,
      });
      const output = executeIpCommand(ctx, ['route', 'show']);
      expect(output).toContain('default via 192.168.1.1');
      expect(output).toContain('proto dhcp');
      expect(output).toContain('metric 100');
    });

    it('should format static routes properly', () => {
      const routes = ctx.getRoutingTable();
      routes.push({
        network: '10.0.0.0',
        cidr: 8,
        nextHop: '192.168.1.1',
        iface: 'eth0',
        type: 'static',
        metric: 100,
        isDHCP: false,
      });
      const output = executeIpCommand(ctx, ['route', 'show']);
      expect(output).toContain('10.0.0.0/8');
      expect(output).toContain('via 192.168.1.1');
      expect(output).toContain('proto static');
    });

    it('should return error for invalid route prefix format', () => {
      const output = executeIpCommand(ctx, ['route', 'add', '10.0.0.0', 'via', '192.168.1.1']);
      expect(output).toContain('Error');
    });

    it('should return error when "via" is missing', () => {
      const output = executeIpCommand(ctx, ['route', 'add', '10.0.0.0/8']);
      expect(output).toContain('Error');
    });

    it('should return error for unknown route subcommand', () => {
      const output = executeIpCommand(ctx, ['route', 'foobar']);
      expect(output).toContain('Command "foobar" is unknown, try "ip route help".');
    });

    it('should handle route add with dev argument', () => {
      const output = executeIpCommand(ctx, ['route', 'add', 'default', 'via', '192.168.1.1', 'dev', 'eth0']);
      expect(output).toBe('');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 5: ip neigh
  // ═══════════════════════════════════════════════════════════════════

  describe('IP-05: ip neigh', () => {
    it('should show empty neighbor table', () => {
      const ctx = createMockContext();
      const output = executeIpCommand(ctx, ['neigh']);
      expect(output).toBe('');
    });

    it('should show neighbor entries', () => {
      const neighbors: IpNeighborEntry[] = [
        { ip: '192.168.1.1', mac: 'aa:bb:cc:00:00:01', iface: 'eth0', state: 'REACHABLE' },
        { ip: '192.168.1.2', mac: 'aa:bb:cc:00:00:02', iface: 'eth0', state: 'STALE' },
      ];
      const ctx = createMockContext({
        getNeighborTable: () => neighbors,
      });
      const output = executeIpCommand(ctx, ['neigh', 'show']);
      expect(output).toContain('192.168.1.1 dev eth0 lladdr aa:bb:cc:00:00:01 REACHABLE');
      expect(output).toContain('192.168.1.2 dev eth0 lladdr aa:bb:cc:00:00:02 STALE');
    });

    it('should work with "ip neigh" (no subcommand)', () => {
      const neighbors: IpNeighborEntry[] = [
        { ip: '10.0.0.1', mac: 'ff:ff:ff:00:00:01', iface: 'eth1', state: 'REACHABLE' },
      ];
      const ctx = createMockContext({
        getNeighborTable: () => neighbors,
      });
      const output = executeIpCommand(ctx, ['neigh']);
      expect(output).toContain('10.0.0.1 dev eth1 lladdr ff:ff:ff:00:00:01 REACHABLE');
    });

    it('should work with "ip neighbor" alias', () => {
      const ctx = createMockContext();
      const output = executeIpCommand(ctx, ['neighbor']);
      expect(output).toBe('');
    });

    it('should work with "ip n" alias', () => {
      const ctx = createMockContext();
      const output = executeIpCommand(ctx, ['n']);
      expect(output).toBe('');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 6: Integration test with LinuxPC
  // ═══════════════════════════════════════════════════════════════════

  describe('IP-06: Integration with LinuxPC', () => {
    // These tests verify the ip command works through LinuxPC.executeCommand
    // after the refactoring to use LinuxCommandExecutor + LinuxIpCommand

    let pc: any; // Will be LinuxPC

    beforeEach(async () => {
      // Dynamically import to avoid issues if wiring isn't done yet
      const { LinuxPC } = await import('@/network/devices/LinuxPC');
      const { resetCounters } = await import('@/network/core/types');
      const { resetDeviceCounters } = await import('@/network/devices/DeviceFactory');
      const { Logger } = await import('@/network/core/Logger');
      resetCounters();
      resetDeviceCounters();
      Logger.reset();
      pc = new LinuxPC('linux-pc', 'TestPC');
    });

    it('should execute "ip addr" through LinuxPC', async () => {
      const output = await pc.executeCommand('ip addr');
      // Should show at least eth0
      expect(output).toContain('eth0');
      expect(output).toContain('link/ether');
    });

    it('should execute "ip link show" through LinuxPC', async () => {
      const output = await pc.executeCommand('ip link show');
      expect(output).toContain('eth0');
      expect(output).toContain('mtu');
    });

    it('should execute "ip route" through LinuxPC (empty table)', async () => {
      const output = await pc.executeCommand('ip route');
      // May be empty or show connected routes
      expect(typeof output).toBe('string');
    });

    it('should execute "ip neigh" through LinuxPC', async () => {
      const output = await pc.executeCommand('ip neigh');
      // Empty ARP table
      expect(typeof output).toBe('string');
    });

    it('should execute "ip help" through LinuxPC', async () => {
      const output = await pc.executeCommand('ip help');
      expect(output).toContain('Usage: ip');
    });

    it('should execute "sudo ip addr add" through LinuxPC', async () => {
      const output = await pc.executeCommand('sudo ip addr add 10.0.0.5/24 dev eth0');
      // Should succeed (via sudo)
      expect(typeof output).toBe('string');
    });

    it('should handle ip error through LinuxPC', async () => {
      const output = await pc.executeCommand('ip xyz');
      expect(output).toContain('Object "xyz" is unknown');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 7: Edge cases and error handling
  // ═══════════════════════════════════════════════════════════════════

  describe('IP-07: Edge cases', () => {
    let ctx: IpNetworkContext;
    beforeEach(() => { ctx = createMockContext(); });

    it('should handle "ip -s link" (statistics flag)', () => {
      const output = executeIpCommand(ctx, ['-s', 'link']);
      // Should still show link info (stats flag is parsed but output varies)
      expect(output).toContain('eth0');
    });

    it('should handle "ip -br addr" (brief format)', () => {
      const output = executeIpCommand(ctx, ['-br', 'addr']);
      // Brief format shows condensed output
      expect(output).toContain('eth0');
      expect(output).toContain('192.168.1.10/24');
    });

    it('should handle "ip addr help"', () => {
      const output = executeIpCommand(ctx, ['addr', 'help']);
      expect(output).toContain('Usage: ip addr');
    });

    it('should handle "ip route help"', () => {
      const output = executeIpCommand(ctx, ['route', 'help']);
      expect(output).toContain('Usage: ip route');
    });

    it('should handle "ip link help"', () => {
      const output = executeIpCommand(ctx, ['link', 'help']);
      expect(output).toContain('Usage: ip link');
    });

    it('should handle LOOPBACK flags for lo', () => {
      const output = executeIpCommand(ctx, ['link', 'show', 'dev', 'lo']);
      expect(output).toContain('LOOPBACK');
    });

    it('should show proper interface index numbers', () => {
      const output = executeIpCommand(ctx, ['addr']);
      // First interface should be index 1, second index 2, etc.
      expect(output).toMatch(/1:\s+lo/);
      expect(output).toMatch(/2:\s+eth0/);
      expect(output).toMatch(/3:\s+eth1/);
    });

    it('should handle "ip route get" with destination', () => {
      ctx.addDefaultRoute('192.168.1.1');
      const output = executeIpCommand(ctx, ['route', 'get', '8.8.8.8']);
      // Should show the route that would be used
      expect(output).toContain('8.8.8.8');
      expect(output).toContain('via 192.168.1.1');
    });
  });
});
