/**
 * ip6tables-restore — was a dead CLI entry point in both dispatch paths
 * (PRD-Iptables-UFW.md §1.3 item D.12 / §2.1 objectif D.12, Phase 2):
 * `LinuxMachine.tryNetworkCommand` delegated unconditionally (correctly,
 * since it needs stdin/redirection), but `LinuxCommandExecutor`'s composite
 * switch — reached via the `<` redirection — had no `ip6tables`/
 * `ip6tables-save`/`ip6tables-restore` case at all, so the line fell through
 * to "command not found". This mirrors the existing iptables-restore
 * coverage in linux-iptables.test.ts for the v6 engine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';

describe('ip6tables-save / ip6tables-restore', () => {
  let server: LinuxServer;

  beforeEach(() => {
    resetCounters();
    server = new LinuxServer('linux-server', 'SRV1');
  });

  it('which/command -v recognize ip6tables-restore (was unresolvable before this fix)', async () => {
    const out = await server.executeCommand('which ip6tables-restore');
    expect(out).not.toContain('not found');
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it('ip6tables-save dumps the v6 rules, independently of the v4 engine', async () => {
    await server.executeCommand('iptables -A INPUT -p tcp --dport 80 -j ACCEPT');
    await server.executeCommand('ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT');
    const out = await server.executeCommand('ip6tables-save');
    expect(out).toContain('*filter');
    expect(out).toContain('-A INPUT -p tcp --dport 22 -j ACCEPT');
    expect(out).not.toContain('--dport 80');
  });

  it('ip6tables-restore loads rules from stdin via redirection (was "command not found")', async () => {
    await server.executeCommand('ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT');
    await server.executeCommand('ip6tables -P FORWARD DROP');
    await server.executeCommand('ip6tables-save > /tmp/rules.v6');

    await server.executeCommand('ip6tables -F');
    await server.executeCommand('ip6tables -P FORWARD ACCEPT');

    const restoreOut = await server.executeCommand('ip6tables-restore < /tmp/rules.v6');
    expect(restoreOut).not.toMatch(/command not found/i);

    const out = await server.executeCommand('ip6tables -S');
    expect(out).toContain('-P FORWARD DROP');
    expect(out).toContain('-A INPUT -p tcp --dport 22 -j ACCEPT');
  });

  it('ip6tables-restore without stdin fails with a real error, not "command not found"', async () => {
    const out = await server.executeCommand('ip6tables-restore');
    expect(out).toMatch(/unable to read from stdin/i);
  });
});
