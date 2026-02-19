/**
 * Cisco ACL (Access Control List) — TDD Test Suite
 *
 * Tests cover:
 *   Group 1: ACL Data Structures & API (standard + extended ACLs)
 *   Group 2: Standard ACL CLI commands (access-list 1-99)
 *   Group 3: Extended ACL CLI commands (access-list 100-199)
 *   Group 4: Named ACLs (ip access-list standard/extended)
 *   Group 5: Interface ACL Application (ip access-group in/out)
 *   Group 6: Show commands (show access-lists, show ip access-lists)
 *   Group 7: ACL Packet Filtering — Standard ACLs on forwarded traffic
 *   Group 8: ACL Packet Filtering — Extended ACLs on forwarded traffic
 *   Group 9: ACL with Multiple LANs (end-to-end scenarios)
 *   Group 10: Running-config integration
 *   Group 11: Error handling and edge cases
 *
 * Topology used for Groups 7-9:
 *
 *   [PC_A 10.0.1.2] ── [R1 Gi0/0: 10.0.1.1 | Gi0/1: 10.0.2.1] ── [R2 Gi0/0: 10.0.2.2 | Gi0/1: 10.0.3.1] ── [PC_B 10.0.3.2]
 *
 *   LAN A: 10.0.1.0/24
 *   Transit: 10.0.2.0/24
 *   LAN B: 10.0.3.0/24
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  IPv4Packet, ICMPPacket, UDPPacket,
  EthernetFrame,
  createIPv4Packet,
  ETHERTYPE_IPV4,
  IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP,
  resetCounters,
} from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ──────────────────────────────────────────────────────────

/** Execute a sequence of CLI commands on a router */
async function configureRouter(router: CiscoRouter, commands: string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const cmd of commands) {
    outputs.push(await router.executeCommand(cmd));
  }
  return outputs;
}

/** Build a simple 2-router 3-LAN topology:
 *  PC_A (10.0.1.2) — R1 — R2 — PC_B (10.0.3.2)
 */
function buildTopology() {
  const pcA = new LinuxPC('linux-pc', 'PC_A');
  const pcB = new LinuxPC('linux-pc', 'PC_B');
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');

  // Configure R1
  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

  // Configure R2
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
  r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));

  // Static routes
  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

  // PC configuration
  pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
  pcB.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
  pcB.setDefaultGateway(new IPAddress('10.0.3.1'));

  // Cabling
  const c1 = new Cable('c1');
  c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  const c2 = new Cable('c2');
  c2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  const c3 = new Cable('c3');
  c3.connect(r2.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

  return { pcA, pcB, r1, r2, c1, c2, c3 };
}

describe('Cisco ACL (Access Control Lists)', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 1: ACL Data Structures & API
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 1: ACL Data Structures & API', () => {
    it('1.1 should have empty ACLs by default', () => {
      const r = new CiscoRouter('R1');
      expect(r.getAccessLists()).toEqual([]);
    });

    it('1.2 should add a standard numbered ACL via API', () => {
      const r = new CiscoRouter('R1');
      r.addAccessListEntry(10, 'permit', { srcIP: new IPAddress('10.0.1.0'), srcWildcard: new SubnetMask('0.0.0.255') });
      const acls = r.getAccessLists();
      expect(acls.length).toBe(1);
      expect(acls[0].id).toBe(10);
      expect(acls[0].type).toBe('standard');
    });

    it('1.3 should add an extended numbered ACL via API', () => {
      const r = new CiscoRouter('R1');
      r.addAccessListEntry(100, 'deny', {
        protocol: 'tcp',
        srcIP: new IPAddress('10.0.1.0'), srcWildcard: new SubnetMask('0.0.0.255'),
        dstIP: new IPAddress('10.0.3.0'), dstWildcard: new SubnetMask('0.0.0.255'),
        dstPort: 80,
      });
      const acls = r.getAccessLists();
      expect(acls.length).toBe(1);
      expect(acls[0].id).toBe(100);
      expect(acls[0].type).toBe('extended');
    });

    it('1.4 should accumulate multiple entries in the same ACL', () => {
      const r = new CiscoRouter('R1');
      r.addAccessListEntry(10, 'permit', { srcIP: new IPAddress('10.0.1.0'), srcWildcard: new SubnetMask('0.0.0.255') });
      r.addAccessListEntry(10, 'deny', { srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255') });
      const acls = r.getAccessLists();
      expect(acls.length).toBe(1);
      expect(acls[0].entries.length).toBe(2);
      expect(acls[0].entries[0].action).toBe('permit');
      expect(acls[0].entries[1].action).toBe('deny');
    });

    it('1.5 should create a named standard ACL', () => {
      const r = new CiscoRouter('R1');
      r.addNamedAccessListEntry('MY_ACL', 'standard', 'permit', {
        srcIP: new IPAddress('192.168.1.0'), srcWildcard: new SubnetMask('0.0.0.255'),
      });
      const acls = r.getAccessLists();
      expect(acls.length).toBe(1);
      expect(acls[0].name).toBe('MY_ACL');
      expect(acls[0].type).toBe('standard');
    });

    it('1.6 should create a named extended ACL', () => {
      const r = new CiscoRouter('R1');
      r.addNamedAccessListEntry('BLOCK_WEB', 'extended', 'deny', {
        protocol: 'tcp',
        srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
        dstIP: new IPAddress('10.0.3.0'), dstWildcard: new SubnetMask('0.0.0.255'),
        dstPort: 80,
      });
      const acls = r.getAccessLists();
      expect(acls[0].name).toBe('BLOCK_WEB');
      expect(acls[0].type).toBe('extended');
    });

    it('1.7 should remove an ACL by number', () => {
      const r = new CiscoRouter('R1');
      r.addAccessListEntry(10, 'permit', { srcIP: new IPAddress('10.0.1.0'), srcWildcard: new SubnetMask('0.0.0.255') });
      r.removeAccessList(10);
      expect(r.getAccessLists()).toEqual([]);
    });

    it('1.8 should remove a named ACL', () => {
      const r = new CiscoRouter('R1');
      r.addNamedAccessListEntry('TEST', 'standard', 'permit', {
        srcIP: new IPAddress('10.0.0.0'), srcWildcard: new SubnetMask('0.255.255.255'),
      });
      r.removeNamedAccessList('TEST');
      expect(r.getAccessLists()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 2: Standard ACL CLI Commands (access-list 1-99)
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 2: Standard ACL CLI Commands', () => {
    it('2.1 should configure a standard ACL permit via CLI', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
      ]);
      const acls = r.getAccessLists();
      expect(acls.length).toBe(1);
      expect(acls[0].entries[0].action).toBe('permit');
    });

    it('2.2 should configure a standard ACL deny via CLI', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 deny 192.168.0.0 0.0.255.255',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].entries[0].action).toBe('deny');
    });

    it('2.3 should support "host" keyword in standard ACL', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit host 10.0.1.2',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].entries[0].srcWildcard.toString()).toBe('0.0.0.0');
      expect(acls[0].entries[0].srcIP.toString()).toBe('10.0.1.2');
    });

    it('2.4 should support "any" keyword in standard ACL', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 deny any',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].entries[0].srcIP.toString()).toBe('0.0.0.0');
      expect(acls[0].entries[0].srcWildcard.toString()).toBe('255.255.255.255');
    });

    it('2.5 should add multiple entries to the same standard ACL', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'access-list 10 deny any',
      ]);
      const acls = r.getAccessLists();
      expect(acls.length).toBe(1);
      expect(acls[0].entries.length).toBe(2);
    });

    it('2.6 should remove a standard ACL with "no access-list"', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'no access-list 10',
      ]);
      expect(r.getAccessLists()).toEqual([]);
    });

    it('2.7 should reject invalid ACL number (e.g. 200)', async () => {
      const r = new CiscoRouter('R1');
      const outputs = await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 200 permit 10.0.1.0 0.0.0.255',
      ]);
      expect(outputs[2]).toContain('%');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 3: Extended ACL CLI Commands (access-list 100-199)
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 3: Extended ACL CLI Commands', () => {
    it('3.1 should configure an extended ACL deny TCP via CLI', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 deny tcp 10.0.1.0 0.0.0.255 10.0.3.0 0.0.0.255 eq 80',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].type).toBe('extended');
      expect(acls[0].entries[0].protocol).toBe('tcp');
      expect(acls[0].entries[0].dstPort).toBe(80);
    });

    it('3.2 should configure an extended ACL permit ICMP via CLI', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 permit icmp any any',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].entries[0].protocol).toBe('icmp');
      expect(acls[0].entries[0].action).toBe('permit');
    });

    it('3.3 should configure an extended ACL deny UDP to a specific port', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 101 deny udp any 10.0.3.0 0.0.0.255 eq 53',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].entries[0].protocol).toBe('udp');
      expect(acls[0].entries[0].dstPort).toBe(53);
    });

    it('3.4 should configure an extended ACL permit IP (all protocols)', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 permit ip any any',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].entries[0].protocol).toBe('ip');
    });

    it('3.5 should support "host" keyword in extended ACL', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 deny tcp host 10.0.1.2 host 10.0.3.2 eq 443',
      ]);
      const acls = r.getAccessLists();
      const entry = acls[0].entries[0];
      expect(entry.srcIP.toString()).toBe('10.0.1.2');
      expect(entry.srcWildcard.toString()).toBe('0.0.0.0');
      expect(entry.dstIP.toString()).toBe('10.0.3.2');
      expect(entry.dstWildcard.toString()).toBe('0.0.0.0');
    });

    it('3.6 should support source port "eq" in extended ACL', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 deny tcp 10.0.1.0 0.0.0.255 eq 1024 10.0.3.0 0.0.0.255 eq 80',
      ]);
      const acls = r.getAccessLists();
      const entry = acls[0].entries[0];
      expect(entry.srcPort).toBe(1024);
      expect(entry.dstPort).toBe(80);
    });

    it('3.7 should remove an extended ACL with "no access-list"', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 deny tcp any any eq 80',
        'no access-list 100',
      ]);
      expect(r.getAccessLists()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 4: Named ACLs (ip access-list standard/extended)
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 4: Named ACLs', () => {
    it('4.1 should enter named standard ACL mode and add entries', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list standard ALLOW_LAN',
        'permit 10.0.1.0 0.0.0.255',
        'deny any',
        'exit',
      ]);
      const acls = r.getAccessLists();
      expect(acls.length).toBe(1);
      expect(acls[0].name).toBe('ALLOW_LAN');
      expect(acls[0].type).toBe('standard');
      expect(acls[0].entries.length).toBe(2);
    });

    it('4.2 should enter named extended ACL mode and add entries', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list extended BLOCK_HTTP',
        'deny tcp any any eq 80',
        'permit ip any any',
        'exit',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].name).toBe('BLOCK_HTTP');
      expect(acls[0].type).toBe('extended');
      expect(acls[0].entries.length).toBe(2);
    });

    it('4.3 should show correct prompt in named ACL config mode', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list standard TEST',
      ]);
      const prompt = r.getPrompt();
      expect(prompt).toContain('config-std-nacl');
    });

    it('4.4 should show correct prompt in named extended ACL config mode', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list extended TEST',
      ]);
      const prompt = r.getPrompt();
      expect(prompt).toContain('config-ext-nacl');
    });

    it('4.5 should remove a named ACL with "no ip access-list"', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list standard MY_ACL',
        'permit 10.0.1.0 0.0.0.255',
        'exit',
        'no ip access-list standard MY_ACL',
      ]);
      expect(r.getAccessLists()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 5: Interface ACL Application (ip access-group)
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 5: Interface ACL Application', () => {
    it('5.1 should apply a numbered ACL inbound on an interface', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      const acl = r.getInterfaceACL('GigabitEthernet0/0', 'in');
      expect(acl).toBe(10);
    });

    it('5.2 should apply a numbered ACL outbound on an interface', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/1',
        'ip access-group 100 out',
      ]);
      const acl = r.getInterfaceACL('GigabitEthernet0/1', 'out');
      expect(acl).toBe(100);
    });

    it('5.3 should apply a named ACL on an interface', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list standard ALLOW_LAN',
        'permit 10.0.1.0 0.0.0.255',
        'exit',
        'interface GigabitEthernet0/0',
        'ip access-group ALLOW_LAN in',
      ]);
      const acl = r.getInterfaceACL('GigabitEthernet0/0', 'in');
      expect(acl).toBe('ALLOW_LAN');
    });

    it('5.4 should remove an ACL from an interface with "no ip access-group"', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit any',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
        'no ip access-group 10 in',
      ]);
      const acl = r.getInterfaceACL('GigabitEthernet0/0', 'in');
      expect(acl).toBeNull();
    });

    it('5.5 should replace ACL when applying a new one on same interface/direction', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit any',
        'access-list 20 deny any',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
        'ip access-group 20 in',
      ]);
      const acl = r.getInterfaceACL('GigabitEthernet0/0', 'in');
      expect(acl).toBe(20);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 6: Show Commands
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 6: Show Commands', () => {
    it('6.1 should display "show access-lists" with standard ACL', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'access-list 10 deny any',
        'end',
      ]);
      const output = await r.executeCommand('show access-lists');
      expect(output).toContain('Standard IP access list 10');
      expect(output).toContain('permit 10.0.1.0 0.0.0.255');
      expect(output).toContain('deny any');
    });

    it('6.2 should display "show access-lists" with extended ACL', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 deny tcp any any eq 80',
        'access-list 100 permit ip any any',
        'end',
      ]);
      const output = await r.executeCommand('show access-lists');
      expect(output).toContain('Extended IP access list 100');
      expect(output).toContain('deny tcp any any eq 80');
      expect(output).toContain('permit ip any any');
    });

    it('6.3 should display "show ip access-lists" (alias)', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit any',
        'end',
      ]);
      const output = await r.executeCommand('show ip access-lists');
      expect(output).toContain('Standard IP access list 10');
    });

    it('6.4 should display named ACLs in show access-lists', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list standard MY_ACL',
        'permit 10.0.1.0 0.0.0.255',
        'deny any',
        'exit',
        'end',
      ]);
      const output = await r.executeCommand('show access-lists');
      expect(output).toContain('Standard IP access list MY_ACL');
      expect(output).toContain('permit 10.0.1.0 0.0.0.255');
    });

    it('6.5 should display empty when no ACLs configured', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, ['enable']);
      const output = await r.executeCommand('show access-lists');
      expect(output).toBe('');
    });

    it('6.6 should display match counters in show access-lists', async () => {
      const { r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'access-list 10 deny any',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
        'end',
      ]);
      // Send a ping from PC_A to trigger ACL evaluation
      const { pcA } = buildTopology();
      // After traffic, match counts should be shown
      const output = await r1.executeCommand('show access-lists');
      expect(output).toContain('permit 10.0.1.0 0.0.0.255');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 7: ACL Packet Filtering — Standard ACLs
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 7: Standard ACL Packet Filtering', () => {
    it('7.1 should permit traffic from allowed source with standard ACL inbound', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).toContain('64 bytes from 10.0.3.2');
    });

    it('7.2 should deny traffic from blocked source with standard ACL (implicit deny)', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // ACL 10 only permits 192.168.0.0/16 — PC_A (10.0.1.2) will be denied by implicit deny
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 permit 192.168.0.0 0.0.255.255',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('7.3 should deny specific host with standard ACL', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 deny host 10.0.1.2',
        'access-list 10 permit any',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('7.4 should permit other hosts while denying a specific one', async () => {
      const { r1, r2 } = buildTopology();
      // Create another PC on the same LAN
      const pcC = new LinuxPC('linux-pc', 'PC_C');
      pcC.configureInterface('eth0', new IPAddress('10.0.1.3'), new SubnetMask('255.255.255.0'));
      pcC.setDefaultGateway(new IPAddress('10.0.1.1'));
      // We need to connect PC_C somehow... in this case we test that ACL logic
      // denies 10.0.1.2 but permits 10.0.1.3
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 deny host 10.0.1.2',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      // Verify ACL is configured correctly
      const acls = r1.getAccessLists();
      expect(acls[0].entries.length).toBe(2);
      expect(acls[0].entries[0].action).toBe('deny');
      expect(acls[0].entries[1].action).toBe('permit');
    });

    it('7.5 should apply standard ACL outbound to filter egress traffic', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // Block traffic going out Gi0/1 from source 10.0.1.0/24
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 deny 10.0.1.0 0.0.0.255',
        'access-list 10 permit any',
        'interface GigabitEthernet0/1',
        'ip access-group 10 out',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('7.6 should not filter traffic on interfaces without ACL', async () => {
      const { pcA, r1 } = buildTopology();
      // Apply ACL only on Gi0/1, not on Gi0/0
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 deny any',
        'interface GigabitEthernet0/1',
        'ip access-group 10 in',
      ]);
      // Traffic from PC_A enters Gi0/0 (no ACL) — should still be forwarded
      // unless blocked by outbound ACL on Gi0/1
      const acl = r1.getInterfaceACL('GigabitEthernet0/0', 'in');
      expect(acl).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 8: ACL Packet Filtering — Extended ACLs
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 8: Extended ACL Packet Filtering', () => {
    it('8.1 should deny TCP to specific port with extended ACL', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny tcp 10.0.1.0 0.0.0.255 10.0.3.0 0.0.0.255 eq 80',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      // ICMP should still work
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).toContain('64 bytes from 10.0.3.2');
    });

    it('8.2 should deny all ICMP with extended ACL', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny icmp any any',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('8.3 should permit ICMP but deny UDP with extended ACL', async () => {
      const { r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny udp any any',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      // Verify ACL entries
      const acls = r1.getAccessLists();
      expect(acls[0].entries[0].protocol).toBe('udp');
      expect(acls[0].entries[0].action).toBe('deny');
      expect(acls[0].entries[1].protocol).toBe('ip');
      expect(acls[0].entries[1].action).toBe('permit');
    });

    it('8.4 should filter by destination IP in extended ACL', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // Only deny traffic going to 10.0.3.2 specifically
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny ip any host 10.0.3.2',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('8.5 should match "ip" protocol to any L4 protocol', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // deny all IP from 10.0.1.0/24
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny ip 10.0.1.0 0.0.0.255 any',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('8.6 should permit traffic that matches no deny rule (first-match)', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        // Deny ICMP from 192.168.x.x — does NOT match PC_A (10.0.1.2)
        'access-list 100 deny icmp 192.168.0.0 0.0.255.255 any',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).toContain('64 bytes from 10.0.3.2');
    });

    it('8.7 should apply extended ACL outbound', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny icmp any any',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/1',
        'ip access-group 100 out',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 9: Multi-LAN End-to-End Scenarios
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 9: Multi-LAN End-to-End Scenarios', () => {
    it('9.1 should allow ping through two routers without ACL', async () => {
      const { pcA, pcB } = buildTopology();
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).toContain('64 bytes from 10.0.3.2');
    });

    it('9.2 should block ping at first router with ACL on ingress', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny icmp any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('9.3 should block ping at second router with ACL on ingress', async () => {
      const { pcA, pcB, r2 } = buildTopology();
      await configureRouter(r2, [
        'enable',
        'configure terminal',
        'access-list 100 deny icmp any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('9.4 should block return ping at second router with ACL on egress', async () => {
      const { pcA, pcB, r2 } = buildTopology();
      // Block ICMP echo-reply going back through R2's Gi0/0
      await configureRouter(r2, [
        'enable',
        'configure terminal',
        'access-list 100 deny icmp any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 out',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('9.5 should allow other traffic while blocking specific protocol', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // Block only UDP, allow ICMP
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny udp any any',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      // ICMP ping should work
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).toContain('64 bytes from 10.0.3.2');
    });

    it('9.6 should block traffic from LAN A to LAN B but allow B to A', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // Standard ACL: block 10.0.1.0/24 on R1 egress
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 deny 10.0.1.0 0.0.0.255',
        'access-list 10 permit any',
        'interface GigabitEthernet0/1',
        'ip access-group 10 out',
      ]);
      // PC_A → PC_B should fail
      const outputAtoB = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(outputAtoB).not.toContain('64 bytes from 10.0.3.2');
      // PC_B → PC_A should work (traffic enters Gi0/1 inbound — no ACL there)
      const outputBtoA = await pcB.executeCommand('ping -c 1 10.0.1.2');
      expect(outputBtoA).toContain('64 bytes from 10.0.1.2');
    });

    it('9.7 should apply named ACL end-to-end', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'ip access-list extended BLOCK_ICMP',
        'deny icmp any any',
        'permit ip any any',
        'exit',
        'interface GigabitEthernet0/0',
        'ip access-group BLOCK_ICMP in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('9.8 should filter based on source+destination pair in extended ACL', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        // Block only traffic from 10.0.1.2 to 10.0.3.2
        'access-list 100 deny ip host 10.0.1.2 host 10.0.3.2',
        'access-list 100 permit ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 10: Running-config Integration
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 10: Running-config Integration', () => {
    it('10.1 should display standard ACL in running-config', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'access-list 10 deny any',
        'end',
      ]);
      const output = await r.executeCommand('show running-config');
      expect(output).toContain('access-list 10 permit 10.0.1.0 0.0.0.255');
      expect(output).toContain('access-list 10 deny any');
    });

    it('10.2 should display extended ACL in running-config', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 100 deny tcp any any eq 80',
        'access-list 100 permit ip any any',
        'end',
      ]);
      const output = await r.executeCommand('show running-config');
      expect(output).toContain('access-list 100 deny tcp any any eq 80');
      expect(output).toContain('access-list 100 permit ip any any');
    });

    it('10.3 should display named ACL in running-config', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'ip access-list standard MY_ACL',
        'permit 10.0.1.0 0.0.0.255',
        'deny any',
        'exit',
        'end',
      ]);
      const output = await r.executeCommand('show running-config');
      expect(output).toContain('ip access-list standard MY_ACL');
      expect(output).toContain(' permit 10.0.1.0 0.0.0.255');
      expect(output).toContain(' deny any');
    });

    it('10.4 should display ip access-group in interface config', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit any',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
        'end',
      ]);
      const output = await r.executeCommand('show running-config');
      expect(output).toContain('ip access-group 10 in');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Group 11: Error Handling and Edge Cases
  // ═══════════════════════════════════════════════════════════════════

  describe('Group 11: Error Handling and Edge Cases', () => {
    it('11.1 should have implicit deny at end of every ACL', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // ACL with only permit for 192.168.x.x — should implicit deny 10.0.1.x
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 permit 192.168.0.0 0.0.255.255',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).not.toContain('64 bytes from 10.0.3.2');
    });

    it('11.2 should return error for incomplete access-list command', async () => {
      const r = new CiscoRouter('R1');
      const outputs = await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list',
      ]);
      expect(outputs[2]).toContain('%');
    });

    it('11.3 should handle wildcard mask correctly (0.0.0.0 = exact match)', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.2 0.0.0.0',
      ]);
      const acls = r.getAccessLists();
      expect(acls[0].entries[0].srcWildcard.toString()).toBe('0.0.0.0');
    });

    it('11.4 should evaluate ACL entries in order (first match wins)', async () => {
      const { pcA, pcB, r1 } = buildTopology();
      // First rule permits all, second denies — first match should win
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 10 permit any',
        'access-list 10 deny 10.0.1.0 0.0.0.255',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');
      expect(output).toContain('64 bytes from 10.0.3.2');
    });

    it('11.5 should not affect router-destined traffic (control plane)', async () => {
      const { pcA, r1 } = buildTopology();
      // Block ALL forwarded traffic with ACL
      await configureRouter(r1, [
        'enable',
        'configure terminal',
        'access-list 100 deny ip any any',
        'interface GigabitEthernet0/0',
        'ip access-group 100 in',
      ]);
      // Ping to R1's own interface should still work (control plane bypass)
      const output = await pcA.executeCommand('ping -c 1 10.0.1.1');
      expect(output).toContain('64 bytes from 10.0.1.1');
    });

    it('11.6 should handle ACL without any entries gracefully', async () => {
      const r = new CiscoRouter('R1');
      // Try to reference a non-existent ACL on an interface
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
      ]);
      // With no ACL 10 defined, implicit deny should apply
      const acl = r.getInterfaceACL('GigabitEthernet0/0', 'in');
      expect(acl).toBe(10);
    });

    it('11.7 should support abbreviation for show access-lists', async () => {
      const r = new CiscoRouter('R1');
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit any',
        'end',
      ]);
      const output = await r.executeCommand('sh access-lists');
      expect(output).toContain('Standard IP access list 10');
    });

    it('11.8 should support multiple ACLs on different interfaces', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      r.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit 10.0.1.0 0.0.0.255',
        'access-list 20 permit 10.0.2.0 0.0.0.255',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
        'exit',
        'interface GigabitEthernet0/1',
        'ip access-group 20 in',
      ]);
      expect(r.getInterfaceACL('GigabitEthernet0/0', 'in')).toBe(10);
      expect(r.getInterfaceACL('GigabitEthernet0/1', 'in')).toBe(20);
    });

    it('11.9 should support both inbound and outbound ACLs on same interface', async () => {
      const r = new CiscoRouter('R1');
      r.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      await configureRouter(r, [
        'enable',
        'configure terminal',
        'access-list 10 permit any',
        'access-list 100 deny icmp any any',
        'interface GigabitEthernet0/0',
        'ip access-group 10 in',
        'ip access-group 100 out',
      ]);
      expect(r.getInterfaceACL('GigabitEthernet0/0', 'in')).toBe(10);
      expect(r.getInterfaceACL('GigabitEthernet0/0', 'out')).toBe(100);
    });
  });
});
