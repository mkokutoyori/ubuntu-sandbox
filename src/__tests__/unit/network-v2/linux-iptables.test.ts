/**
 * TDD Tests for Linux iptables (netfilter)
 * Faithful reproduction of real iptables behavior on Linux.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';

// ═══════════════════════════════════════════════════════════════════
// IPTABLES — Linux Netfilter Firewall
// ═══════════════════════════════════════════════════════════════════

describe('iptables', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'SRV1');
  });

  // ─── Default state ─────────────────────────────────────────────

  describe('default state', () => {
    it('should have default ACCEPT policy on all filter chains', async () => {
      const out = await server.executeCommand('iptables -L');
      expect(out).toContain('Chain INPUT (policy ACCEPT)');
      expect(out).toContain('Chain FORWARD (policy ACCEPT)');
      expect(out).toContain('Chain OUTPUT (policy ACCEPT)');
    });

    it('should show column headers in -L output', async () => {
      const out = await server.executeCommand('iptables -L');
      expect(out).toContain('target');
      expect(out).toContain('prot');
      expect(out).toContain('source');
      expect(out).toContain('destination');
    });

    it('should have empty chains by default', async () => {
      const out = await server.executeCommand('iptables -S');
      // Only default policies, no rules
      expect(out).toBe('-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT');
    });
  });

  // ─── -L (list) ─────────────────────────────────────────────────

  describe('-L (list)', () => {
    it('should list a specific chain', async () => {
      const out = await server.executeCommand('iptables -L INPUT');
      expect(out).toContain('Chain INPUT (policy ACCEPT)');
      expect(out).not.toContain('Chain FORWARD');
      expect(out).not.toContain('Chain OUTPUT');
    });

    it('should error on non-existent chain', async () => {
      const out = await server.executeCommand('iptables -L NONEXISTENT');
      expect(out).toContain("iptables: No chain/target/match by that name");
    });

    it('should support -n flag for numeric output', async () => {
      await server.executeCommand('iptables -A INPUT -s 192.168.1.0/24 -j ACCEPT');
      const out = await server.executeCommand('iptables -L INPUT -n');
      expect(out).toContain('192.168.1.0/24');
    });

    it('should support -v flag for verbose output with counters', async () => {
      const out = await server.executeCommand('iptables -L -v');
      expect(out).toContain('pkts');
      expect(out).toContain('bytes');
    });

    it('should support --line-numbers', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
      const out = await server.executeCommand('iptables -L INPUT --line-numbers');
      expect(out).toContain('num');
      expect(out).toMatch(/1\s+ACCEPT/);
      expect(out).toMatch(/2\s+ACCEPT/);
    });

    it('should list nat table with -t nat', async () => {
      const out = await server.executeCommand('iptables -t nat -L');
      expect(out).toContain('Chain PREROUTING (policy ACCEPT)');
      expect(out).toContain('Chain INPUT (policy ACCEPT)');
      expect(out).toContain('Chain OUTPUT (policy ACCEPT)');
      expect(out).toContain('Chain POSTROUTING (policy ACCEPT)');
    });

    it('should list mangle table', async () => {
      const out = await server.executeCommand('iptables -t mangle -L');
      expect(out).toContain('Chain PREROUTING (policy ACCEPT)');
      expect(out).toContain('Chain INPUT (policy ACCEPT)');
      expect(out).toContain('Chain FORWARD (policy ACCEPT)');
      expect(out).toContain('Chain OUTPUT (policy ACCEPT)');
      expect(out).toContain('Chain POSTROUTING (policy ACCEPT)');
    });

    it('should list raw table', async () => {
      const out = await server.executeCommand('iptables -t raw -L');
      expect(out).toContain('Chain PREROUTING (policy ACCEPT)');
      expect(out).toContain('Chain OUTPUT (policy ACCEPT)');
    });

    it('should error on invalid table name', async () => {
      const out = await server.executeCommand('iptables -t invalid -L');
      expect(out).toContain("can't initialize iptables table");
    });
  });

  // ─── -S (list rules as commands) ───────────────────────────────

  describe('-S (list rules)', () => {
    it('should list rules for a specific chain', async () => {
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toBe('-P INPUT ACCEPT');
    });

    it('should list rules for nat table', async () => {
      const out = await server.executeCommand('iptables -t nat -S');
      expect(out).toContain('-P PREROUTING ACCEPT');
      expect(out).toContain('-P POSTROUTING ACCEPT');
    });

    it('should show appended rules in -S output', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-P INPUT ACCEPT');
      expect(out).toContain('-A INPUT -p tcp --dport 22 -j ACCEPT');
    });
  });

  // ─── -P (policy) ──────────────────────────────────────────────

  describe('-P (policy)', () => {
    it('should change INPUT policy to DROP', async () => {
      const out = await server.executeCommand('iptables -P INPUT DROP');
      expect(out).toBe('');
      const list = await server.executeCommand('iptables -L INPUT');
      expect(list).toContain('Chain INPUT (policy DROP)');
    });

    it('should change FORWARD policy to DROP', async () => {
      await server.executeCommand('iptables -P FORWARD DROP');
      const out = await server.executeCommand('iptables -S');
      expect(out).toContain('-P FORWARD DROP');
    });

    it('should reject invalid policy', async () => {
      const out = await server.executeCommand('iptables -P INPUT INVALID');
      expect(out).toContain('iptables');
    });

    it('should reject policy on non-existent chain', async () => {
      const out = await server.executeCommand('iptables -P NONEXISTENT DROP');
      expect(out).toContain("No chain/target/match by that name");
    });

    it('should only allow ACCEPT or DROP as built-in chain policy', async () => {
      const out = await server.executeCommand('iptables -P INPUT REJECT');
      expect(out).toContain('iptables');
    });
  });

  // ─── -F (flush) ────────────────────────────────────────────────

  describe('-F (flush)', () => {
    it('should flush all rules from all chains', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -F');
      const out = await server.executeCommand('iptables -S');
      expect(out).toBe('-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT');
    });

    it('should flush rules from a specific chain', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -F INPUT');
      const sInput = await server.executeCommand('iptables -S INPUT');
      expect(sInput).toBe('-P INPUT ACCEPT');
      // OUTPUT should still have its rule
      const sOutput = await server.executeCommand('iptables -S OUTPUT');
      expect(sOutput).toContain('-A OUTPUT');
    });

    it('should flush rules from nat table', async () => {
      await server.executeCommand('iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE');
      await server.executeCommand('iptables -t nat -F');
      const out = await server.executeCommand('iptables -t nat -S');
      expect(out).not.toContain('-A POSTROUTING');
    });
  });

  // ─── -A (append) ──────────────────────────────────────────────

  describe('-A (append rule)', () => {
    it('should append a simple ACCEPT rule', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -p tcp --dport 22 -j ACCEPT');
    });

    it('should append a DROP rule', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 23 -j DROP');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -p tcp --dport 23 -j DROP');
    });

    it('should append with source IP', async () => {
      await server.executeCommand('iptables -A INPUT -s 10.0.0.1 -j DROP');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -s 10.0.0.1 -j DROP');
    });

    it('should append with source CIDR', async () => {
      await server.executeCommand('iptables -A INPUT -s 192.168.1.0/24 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -s 192.168.1.0/24 -j ACCEPT');
    });

    it('should append with destination IP', async () => {
      await server.executeCommand('iptables -A OUTPUT -d 8.8.8.8 -j ACCEPT');
      const out = await server.executeCommand('iptables -S OUTPUT');
      expect(out).toContain('-A OUTPUT -d 8.8.8.8 -j ACCEPT');
    });

    it('should append with interface -i for INPUT', async () => {
      await server.executeCommand('iptables -A INPUT -i eth0 -p tcp --dport 80 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -i eth0 -p tcp --dport 80 -j ACCEPT');
    });

    it('should append with interface -o for OUTPUT', async () => {
      await server.executeCommand('iptables -A OUTPUT -o eth0 -p tcp --dport 443 -j ACCEPT');
      const out = await server.executeCommand('iptables -S OUTPUT');
      expect(out).toContain('-A OUTPUT -o eth0 -p tcp --dport 443 -j ACCEPT');
    });

    it('should append with multiple criteria', async () => {
      await server.executeCommand('iptables -A INPUT -s 10.0.0.0/8 -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -s 10.0.0.0/8 -p tcp --dport 22 -j ACCEPT');
    });

    it('should append to FORWARD chain', async () => {
      await server.executeCommand('iptables -A FORWARD -i eth0 -o eth1 -j ACCEPT');
      const out = await server.executeCommand('iptables -S FORWARD');
      expect(out).toContain('-A FORWARD -i eth0 -o eth1 -j ACCEPT');
    });

    it('should append UDP rule', async () => {
      await server.executeCommand('iptables -A INPUT -p udp --dport 53 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -p udp --dport 53 -j ACCEPT');
    });

    it('should append ICMP rule', async () => {
      await server.executeCommand('iptables -A INPUT -p icmp -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -p icmp -j ACCEPT');
    });

    it('should append with source port --sport', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --sport 1024 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -p tcp --sport 1024 -j ACCEPT');
    });

    it('should append with port range', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 6000:6007 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -p tcp --dport 6000:6007 -j ACCEPT');
    });

    it('should preserve rule order', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 443 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      const lines = out.split('\n');
      expect(lines[1]).toContain('--dport 22');
      expect(lines[2]).toContain('--dport 80');
      expect(lines[3]).toContain('--dport 443');
    });

    it('should error on non-existent chain', async () => {
      const out = await server.executeCommand('iptables -A NONEXISTENT -j ACCEPT');
      expect(out).toContain("No chain/target/match by that name");
    });
  });

  // ─── -D (delete) ──────────────────────────────────────────────

  describe('-D (delete rule)', () => {
    it('should delete by rule specification', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -D INPUT -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).not.toContain('--dport 22');
      expect(out).toContain('--dport 80');
    });

    it('should delete by rule number', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -D INPUT 1');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).not.toContain('--dport 22');
      expect(out).toContain('--dport 80');
    });

    it('should error on out-of-range rule number', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -D INPUT 5');
      expect(out).toContain('iptables');
    });

    it('should error on non-matching rule specification', async () => {
      const out = await server.executeCommand('iptables -D INPUT -p tcp --dport 9999 -j ACCEPT');
      expect(out).toContain("does a matching rule exist");
    });
  });

  // ─── -I (insert) ──────────────────────────────────────────────

  describe('-I (insert rule)', () => {
    it('should insert at the beginning by default', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -I INPUT -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      const lines = out.split('\n');
      expect(lines[1]).toContain('--dport 22');
      expect(lines[2]).toContain('--dport 80');
    });

    it('should insert at specific position', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 443 -j ACCEPT');
      await server.executeCommand('iptables -I INPUT 2 -p tcp --dport 80 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      const lines = out.split('\n');
      expect(lines[1]).toContain('--dport 22');
      expect(lines[2]).toContain('--dport 80');
      expect(lines[3]).toContain('--dport 443');
    });
  });

  // ─── -R (replace) ─────────────────────────────────────────────

  describe('-R (replace rule)', () => {
    it('should replace rule at position', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
      await server.executeCommand('iptables -R INPUT 1 -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-j ACCEPT');
      expect(out).not.toContain('-j DROP');
    });
  });

  // ─── -C (check) ───────────────────────────────────────────────

  describe('-C (check rule)', () => {
    it('should return 0 if rule exists', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      const out = await server.executeCommand('iptables -C INPUT -p tcp --dport 22 -j ACCEPT');
      expect(out).toBe('');
    });

    it('should return error if rule does not exist', async () => {
      const out = await server.executeCommand('iptables -C INPUT -p tcp --dport 9999 -j ACCEPT');
      expect(out).toContain("does a matching rule exist");
    });
  });

  // ─── -N, -X, -E (custom chains) ──────────────────────────────

  describe('custom chains (-N, -X, -E)', () => {
    it('should create a new chain with -N', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      const out = await server.executeCommand('iptables -L MYCHAIN');
      expect(out).toContain('Chain MYCHAIN');
    });

    it('should error creating duplicate chain', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      const out = await server.executeCommand('iptables -N MYCHAIN');
      expect(out).toContain("Chain already exists");
    });

    it('should delete empty custom chain with -X', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      await server.executeCommand('iptables -X MYCHAIN');
      const out = await server.executeCommand('iptables -L MYCHAIN');
      expect(out).toContain("No chain/target/match by that name");
    });

    it('should not delete built-in chains', async () => {
      const out = await server.executeCommand('iptables -X INPUT');
      expect(out).toContain("built-in chain");
    });

    it('should not delete non-empty custom chain', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      await server.executeCommand('iptables -A MYCHAIN -j ACCEPT');
      const out = await server.executeCommand('iptables -X MYCHAIN');
      expect(out).toContain("Directory not empty");
    });

    it('should rename chain with -E', async () => {
      await server.executeCommand('iptables -N OLDCHAIN');
      await server.executeCommand('iptables -E OLDCHAIN NEWCHAIN');
      const out = await server.executeCommand('iptables -L NEWCHAIN');
      expect(out).toContain('Chain NEWCHAIN');
      const out2 = await server.executeCommand('iptables -L OLDCHAIN');
      expect(out2).toContain("No chain/target/match by that name");
    });

    it('should allow jumping to custom chain', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      await server.executeCommand('iptables -A MYCHAIN -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -j MYCHAIN');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -j MYCHAIN');
    });

    it('should show custom chain references in -L', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      const out = await server.executeCommand('iptables -L MYCHAIN');
      expect(out).toContain('Chain MYCHAIN (0 references)');
    });

    it('should count references to custom chain', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      await server.executeCommand('iptables -A INPUT -j MYCHAIN');
      const out = await server.executeCommand('iptables -L MYCHAIN');
      expect(out).toContain('Chain MYCHAIN (1 references)');
    });

    it('should delete all empty custom chains with -X (no args)', async () => {
      await server.executeCommand('iptables -N CHAIN1');
      await server.executeCommand('iptables -N CHAIN2');
      await server.executeCommand('iptables -X');
      const out = await server.executeCommand('iptables -S');
      expect(out).not.toContain('CHAIN1');
      expect(out).not.toContain('CHAIN2');
    });
  });

  // ─── Match extensions (-m) ────────────────────────────────────

  describe('match extensions (-m)', () => {
    it('should support -m state --state ESTABLISHED,RELATED', async () => {
      await server.executeCommand('iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
    });

    it('should support -m conntrack --ctstate', async () => {
      await server.executeCommand('iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-m conntrack --ctstate ESTABLISHED,RELATED');
    });

    it('should support -m multiport --dports', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp -m multiport --dports 80,443,8080 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-m multiport --dports 80,443,8080');
    });

    it('should support -m multiport --sports', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp -m multiport --sports 1024:65535 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-m multiport --sports 1024:65535');
    });

    it('should support -m comment --comment', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -m comment --comment "Allow SSH" -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-m comment --comment "Allow SSH"');
    });

    it('should support -m limit --limit', async () => {
      await server.executeCommand('iptables -A INPUT -p icmp -m limit --limit 1/sec -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-m limit --limit 1/sec');
    });

    it('should support -m limit --limit-burst', async () => {
      await server.executeCommand('iptables -A INPUT -p icmp -m limit --limit 1/sec --limit-burst 4 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('--limit-burst 4');
    });

    it('should support -m mac --mac-source', async () => {
      await server.executeCommand('iptables -A INPUT -m mac --mac-source 00:11:22:33:44:55 -j DROP');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-m mac --mac-source 00:11:22:33:44:55');
    });

    it('should support -m iprange --src-range', async () => {
      await server.executeCommand('iptables -A INPUT -m iprange --src-range 192.168.1.100-192.168.1.200 -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-m iprange --src-range 192.168.1.100-192.168.1.200');
    });
  });

  // ─── Targets (-j) ─────────────────────────────────────────────

  describe('targets (-j)', () => {
    it('should support ACCEPT target', async () => {
      await server.executeCommand('iptables -A INPUT -j ACCEPT');
      const out = await server.executeCommand('iptables -L INPUT');
      expect(out).toContain('ACCEPT');
    });

    it('should support DROP target', async () => {
      await server.executeCommand('iptables -A INPUT -j DROP');
      const out = await server.executeCommand('iptables -L INPUT');
      expect(out).toContain('DROP');
    });

    it('should support REJECT target', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 23 -j REJECT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-j REJECT');
    });

    it('should support REJECT with --reject-with', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 23 -j REJECT --reject-with icmp-port-unreachable');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('--reject-with icmp-port-unreachable');
    });

    it('should support LOG target', async () => {
      await server.executeCommand('iptables -A INPUT -j LOG --log-prefix "INPUT_DROP: "');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('-j LOG --log-prefix "INPUT_DROP: "');
    });

    it('should support MASQUERADE in nat table', async () => {
      await server.executeCommand('iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE');
      const out = await server.executeCommand('iptables -t nat -S POSTROUTING');
      expect(out).toContain('-A POSTROUTING -o eth0 -j MASQUERADE');
    });

    it('should support DNAT target', async () => {
      await server.executeCommand('iptables -t nat -A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 192.168.1.10:8080');
      const out = await server.executeCommand('iptables -t nat -S PREROUTING');
      expect(out).toContain('--to-destination 192.168.1.10:8080');
    });

    it('should support SNAT target', async () => {
      await server.executeCommand('iptables -t nat -A POSTROUTING -o eth0 -j SNAT --to-source 1.2.3.4');
      const out = await server.executeCommand('iptables -t nat -S POSTROUTING');
      expect(out).toContain('--to-source 1.2.3.4');
    });

    it('should support REDIRECT target', async () => {
      await server.executeCommand('iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080');
      const out = await server.executeCommand('iptables -t nat -S PREROUTING');
      expect(out).toContain('--to-port 8080');
    });

    it('should support RETURN target', async () => {
      await server.executeCommand('iptables -N MYCHAIN');
      await server.executeCommand('iptables -A MYCHAIN -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A MYCHAIN -j RETURN');
      const out = await server.executeCommand('iptables -S MYCHAIN');
      expect(out).toContain('-j RETURN');
    });
  });

  // ─── Negation (!) ─────────────────────────────────────────────

  describe('negation (!)', () => {
    it('should support negated source', async () => {
      await server.executeCommand('iptables -A INPUT ! -s 10.0.0.0/8 -j DROP');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('! -s 10.0.0.0/8');
    });

    it('should support negated protocol', async () => {
      await server.executeCommand('iptables -A INPUT ! -p tcp -j ACCEPT');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('! -p tcp');
    });

    it('should support negated interface', async () => {
      await server.executeCommand('iptables -A INPUT ! -i eth0 -j DROP');
      const out = await server.executeCommand('iptables -S INPUT');
      expect(out).toContain('! -i eth0');
    });
  });

  // ─── iptables-save / iptables-restore ─────────────────────────

  describe('iptables-save and iptables-restore', () => {
    it('should save all rules with iptables-save', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -P FORWARD DROP');
      const out = await server.executeCommand('iptables-save');
      expect(out).toContain('*filter');
      expect(out).toContain(':INPUT ACCEPT');
      expect(out).toContain(':FORWARD DROP');
      expect(out).toContain(':OUTPUT ACCEPT');
      expect(out).toContain('-A INPUT -p tcp --dport 22 -j ACCEPT');
      expect(out).toContain('-A INPUT -p tcp --dport 80 -j ACCEPT');
      expect(out).toContain('COMMIT');
    });

    it('should save nat table rules', async () => {
      await server.executeCommand('iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE');
      const out = await server.executeCommand('iptables-save');
      expect(out).toContain('*nat');
      expect(out).toContain('-A POSTROUTING -o eth0 -j MASQUERADE');
    });

    it('should restore rules from saved config', async () => {
      // Save current rules to file
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -P FORWARD DROP');
      await server.executeCommand('iptables-save > /tmp/rules.v4');

      // Flush everything
      await server.executeCommand('iptables -F');
      await server.executeCommand('iptables -P FORWARD ACCEPT');

      // Restore
      await server.executeCommand('iptables-restore < /tmp/rules.v4');
      const out = await server.executeCommand('iptables -S');
      expect(out).toContain('-P FORWARD DROP');
      expect(out).toContain('-A INPUT -p tcp --dport 22 -j ACCEPT');
    });
  });

  // ─── Zero counters (-Z) ───────────────────────────────────────

  describe('-Z (zero counters)', () => {
    it('should zero all counters', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -Z');
      const out = await server.executeCommand('iptables -L INPUT -v');
      expect(out).toContain('0');
    });

    it('should zero counters for a specific chain', async () => {
      await server.executeCommand('iptables -Z INPUT');
      // Should not error
      const out = await server.executeCommand('iptables -L INPUT -v');
      expect(out).toContain('pkts');
    });
  });

  // ─── Combined real-world scenarios ────────────────────────────

  describe('real-world scenarios', () => {
    it('should implement a typical server firewall', async () => {
      // Typical server hardening
      await server.executeCommand('iptables -P INPUT DROP');
      await server.executeCommand('iptables -P FORWARD DROP');
      await server.executeCommand('iptables -P OUTPUT ACCEPT');
      await server.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p tcp --dport 443 -j ACCEPT');
      await server.executeCommand('iptables -A INPUT -p icmp -j ACCEPT');

      const out = await server.executeCommand('iptables -S');
      expect(out).toContain('-P INPUT DROP');
      expect(out).toContain('-P FORWARD DROP');
      expect(out).toContain('-P OUTPUT ACCEPT');
      expect(out).toContain('-A INPUT -i lo -j ACCEPT');
      expect(out).toContain('-m state --state ESTABLISHED,RELATED');
      expect(out).toContain('--dport 22');
      expect(out).toContain('--dport 80');
      expect(out).toContain('--dport 443');
      expect(out).toContain('-p icmp');
    });

    it('should implement NAT/masquerade for gateway', async () => {
      await server.executeCommand('iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE');
      await server.executeCommand('iptables -A FORWARD -i eth1 -o eth0 -j ACCEPT');
      await server.executeCommand('iptables -A FORWARD -i eth0 -o eth1 -m state --state ESTABLISHED,RELATED -j ACCEPT');

      const natOut = await server.executeCommand('iptables -t nat -S');
      expect(natOut).toContain('-A POSTROUTING -o eth0 -j MASQUERADE');

      const fwdOut = await server.executeCommand('iptables -S FORWARD');
      expect(fwdOut).toContain('-A FORWARD -i eth1 -o eth0 -j ACCEPT');
      expect(fwdOut).toContain('-m state --state ESTABLISHED,RELATED');
    });

    it('should implement port forwarding with DNAT', async () => {
      await server.executeCommand('iptables -t nat -A PREROUTING -i eth0 -p tcp --dport 80 -j DNAT --to-destination 192.168.1.10:8080');
      await server.executeCommand('iptables -A FORWARD -p tcp -d 192.168.1.10 --dport 8080 -j ACCEPT');

      const natOut = await server.executeCommand('iptables -t nat -S PREROUTING');
      expect(natOut).toContain('--to-destination 192.168.1.10:8080');

      const fwdOut = await server.executeCommand('iptables -S FORWARD');
      expect(fwdOut).toContain('-d 192.168.1.10');
    });
  });

  // ─── Real packet filtering ────────────────────────────────────

  describe('real packet filtering', () => {

    beforeEach(() => {
      resetCounters();
      MACAddress.resetCounter();
    });

    function connectPCtoServer() {
      const pc = new LinuxPC('linux-pc', 'Client', 0, 0);
      const srv = new LinuxServer('linux-server', 'Server', 200, 0);
      const cable = new Cable('cable-ipt');
      cable.connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
      return { pc, srv };
    }

    async function setupIPs(pc: LinuxPC, srv: LinuxServer) {
      await pc.executeCommand('ifconfig eth0 10.0.0.1');
      await srv.executeCommand('ifconfig eth0 10.0.0.2');
    }

    it('should accept all packets when iptables has default ACCEPT policy', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
    });

    it('should drop incoming ICMP when INPUT policy is DROP', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -P INPUT DROP');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
    });

    it('should allow ICMP when explicit ACCEPT rule exists with DROP policy', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -P INPUT DROP');
      await srv.executeCommand('iptables -A INPUT -p icmp -j ACCEPT');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
    });

    it('should drop specific source IP', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -A INPUT -s 10.0.0.1 -j DROP');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
    });

    it('should accept from allowed source with DROP policy', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -P INPUT DROP');
      await srv.executeCommand('iptables -A INPUT -s 10.0.0.1 -j ACCEPT');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
    });

    it('should respect first-match-wins ordering', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -A INPUT -s 10.0.0.1 -j DROP');
      await srv.executeCommand('iptables -A INPUT -j ACCEPT');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
    });

    it('should filter by interface name', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -A INPUT -i eth0 -j DROP');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
    });

    it('should not match wrong interface', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -A INPUT -i eth1 -j DROP');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('1 received');
    });

    it('should filter by CIDR source', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -A INPUT -s 10.0.0.0/24 -j DROP');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
    });

    it('should block outgoing packets with OUTPUT DROP policy', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      // Block output on the PC (the one pinging)
      await pc.executeCommand('sudo iptables -P OUTPUT DROP');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
    });

    it('should send ICMP reject when using REJECT target', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -A INPUT -p icmp -j REJECT');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('Destination Host Unreachable');
    });

    it('should handle negated source (!)', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      // Drop everything NOT from 10.0.0.99 (pc is 10.0.0.1, so it matches negation)
      await srv.executeCommand('iptables -I INPUT ! -s 10.0.0.99 -j DROP');

      const result = await pc.executeCommand('ping -c 1 10.0.0.2');
      expect(result).toContain('0 received');
    });

    it('should update packet counters', async () => {
      const { pc, srv } = connectPCtoServer();
      await setupIPs(pc, srv);
      await srv.executeCommand('iptables -A INPUT -p icmp -j ACCEPT');
      await pc.executeCommand('ping -c 1 10.0.0.2');

      const out = await srv.executeCommand('iptables -L INPUT -v');
      expect(out).toMatch(/[1-9]\d*/);
    });
  });
});
