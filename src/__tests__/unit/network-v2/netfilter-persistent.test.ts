/**
 * netfilter-persistent — PRD-Iptables-UFW.md §2.1 items B.5/B.6 (Phase 7).
 *
 * Before this fix, `/etc/iptables/rules.v6` was never written (only
 * `rules.v4`, as a side effect of any `ufw` action reaching
 * `LinuxFirewallManager.syncToVfs()`) — an asymmetry directly tied to
 * `ufw` not holding a v6 engine reference before Phase 4. And there was no
 * `netfilter-persistent`/`iptables-persistent` mechanism at all: raw
 * `iptables -A ...` rules configured *outside* of `ufw` (ufw has its own,
 * separate persistence path) had no way to survive a simulated reboot —
 * the JS object simply never got destroyed, which is not the same thing
 * as rules actually being reloaded from disk.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('netfilter-persistent', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'SRV1');
  });

  describe('rules.v4/rules.v6 symmetry', () => {
    it('writes /etc/iptables/rules.v6 as a side effect of any ufw action, symmetrically with rules.v4', async () => {
      await server.executeCommand('ufw allow 22/tcp');

      const v4 = await server.executeCommand('cat /etc/iptables/rules.v4');
      const v6 = await server.executeCommand('cat /etc/iptables/rules.v6');
      expect(v4).toContain('*filter');
      expect(v6).toContain('*filter');
    });

    it('rules.v6 reflects the live ip6tables engine, not a copy of rules.v4', async () => {
      await server.executeCommand('ufw allow 22/tcp');
      await server.executeCommand('ip6tables -A INPUT -p tcp --dport 8080 -j ACCEPT');
      await server.executeCommand('ufw allow 80/tcp'); // trigger another syncToVfs

      const v6 = await server.executeCommand('cat /etc/iptables/rules.v6');
      expect(v6).toContain('8080');
    });
  });

  describe('netfilter-persistent save|reload|flush', () => {
    it('save dumps the current live iptables/ip6tables rule sets to disk', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 9999 -j ACCEPT');
      await server.executeCommand('ip6tables -A INPUT -p tcp --dport 8888 -j ACCEPT');

      const out = await server.executeCommand('netfilter-persistent save');
      expect(out).toContain('Saving');

      const v4 = await server.executeCommand('cat /etc/iptables/rules.v4');
      const v6 = await server.executeCommand('cat /etc/iptables/rules.v6');
      expect(v4).toContain('9999');
      expect(v6).toContain('8888');
    });

    it('reload restores rules from disk into the live engines', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 7000 -j ACCEPT');
      await server.executeCommand('netfilter-persistent save');

      // Simulate the rule having been lost from the live engine (e.g. a
      // stray flush) while the persisted file still has it.
      await server.executeCommand('iptables -F INPUT');
      let listing = await server.executeCommand('iptables -L INPUT -n');
      expect(listing).not.toContain('7000');

      const out = await server.executeCommand('netfilter-persistent reload');
      expect(out).toContain('Reloading');

      listing = await server.executeCommand('iptables -L INPUT -n');
      expect(listing).toContain('7000');
    });

    it('flush clears the live rule sets in both address families', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 6000 -j ACCEPT');
      await server.executeCommand('ip6tables -A INPUT -p tcp --dport 6001 -j ACCEPT');

      const out = await server.executeCommand('netfilter-persistent flush');
      expect(out).toContain('Flushing');

      const v4 = await server.executeCommand('iptables -L INPUT -n');
      const v6 = await server.executeCommand('ip6tables -L INPUT -n');
      expect(v4).not.toContain('6000');
      expect(v6).not.toContain('6001');
    });

    it('rejects an unknown subcommand', async () => {
      const out = await server.executeCommand('netfilter-persistent bogus');
      expect(out).toContain('Usage');
    });
  });

  describe('reboot persistence for raw rules configured outside ufw', () => {
    it('a raw iptables rule set with netfilter-persistent survives a reboot', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 5000 -j ACCEPT');
      await server.executeCommand('netfilter-persistent save');

      await server.executeCommand('reboot');

      const listing = await server.executeCommand('iptables -L INPUT -n');
      expect(listing).toMatch(/ACCEPT.*dpt:5000/);
    });

    it('a raw ip6tables rule set with netfilter-persistent survives a reboot', async () => {
      await server.executeCommand('ip6tables -A INPUT -p tcp --dport 5001 -j ACCEPT');
      await server.executeCommand('netfilter-persistent save');

      await server.executeCommand('reboot');

      const listing = await server.executeCommand('ip6tables -L INPUT -n');
      expect(listing).toMatch(/ACCEPT.*dpt:5001/);
    });

    it('a raw rule never saved does not survive a reboot (matches real iptables non-persistence without the package)', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 5555 -j ACCEPT');
      // No `netfilter-persistent save` — nothing was ever written to disk.

      await server.executeCommand('reboot');

      const listing = await server.executeCommand('iptables -L INPUT -n');
      expect(listing).not.toContain('5555');
    });
  });

  describe('systemd coherence', () => {
    it('systemctl status netfilter-persistent reports active after boot', async () => {
      const status = await server.executeCommand('systemctl status netfilter-persistent');
      expect(status).toMatch(/active/);
    });

    it('systemctl restart netfilter-persistent reloads the saved rule set into the live engine', async () => {
      await server.executeCommand('iptables -A INPUT -p tcp --dport 4000 -j ACCEPT');
      await server.executeCommand('netfilter-persistent save');
      await server.executeCommand('iptables -F INPUT');

      await server.executeCommand('systemctl restart netfilter-persistent');

      const listing = await server.executeCommand('iptables -L INPUT -n');
      expect(listing).toMatch(/ACCEPT.*dpt:4000/);
    });
  });
});
