/**
 * ufw ↔ VFS reload — PRD-Iptables-UFW.md §2.1 objectif B.3 (Phase 6).
 *
 * Before this fix, `/etc/ufw/user.rules` and `/etc/ufw/user6.rules` were
 * write-only: `ufw enable`/`allow`/`deny` etc. wrote iptables-save-style
 * dumps to the VFS for cosmetic realism (`cat /etc/ufw/user.rules` "looked
 * right"), but nothing ever read them back. Hand-editing the rule files —
 * or restoring them from a backup — and running `ufw reload` silently did
 * nothing: the live rule set was untouched because `cmdReload()` never
 * consulted the VFS at all.
 *
 * This also covers the reboot-time reconciliation bug fixed alongside it:
 * `reconcileFromBoot()` used to only push rules into the live iptables
 * chains on a disabled→enabled *transition*. If the firewall stayed
 * enabled across a reload (e.g. rules edited on disk while ufw was
 * already active), the freshly-loaded rules were parsed into `this.rules`
 * but never rebuilt into the actual iptables chains — `ufw status` would
 * show the new rules but real traffic would still be filtered by the old
 * ones.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('ufw ↔ VFS reload', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'SRV1');
  });

  it('picks up a hand-edited /etc/ufw/user.rules on `ufw reload`', async () => {
    await server.executeCommand('ufw enable');

    // Hand-edit the rule file directly, bypassing the `ufw allow` CLI path
    // entirely — this is what a sysadmin restoring a backed-up ruleset
    // would do.
    await server.executeCommand(
      "cat > /etc/ufw/user.rules <<'EOF'\n" +
      '*filter\n' +
      ':ufw-user-input - [0:0]\n' +
      ':ufw-user-output - [0:0]\n' +
      ':ufw-user-forward - [0:0]\n' +
      ':ufw-user-limit-accept - [0:0]\n' +
      '-A ufw-user-input -p tcp --dport 8443 -j ACCEPT\n' +
      'COMMIT\n' +
      'EOF'
    );

    const beforeReload = await server.executeCommand('ufw status');
    expect(beforeReload).not.toContain('8443');

    const out = await server.executeCommand('ufw reload');
    expect(out).toContain('Firewall reloaded');

    const status = await server.executeCommand('ufw status');
    expect(status).toContain('8443/tcp');
  });

  it('actually filters traffic against reloaded rules, not just displaying them', async () => {
    await server.executeCommand('ufw default deny incoming');
    await server.executeCommand('ufw enable');

    await server.executeCommand(
      "cat > /etc/ufw/user.rules <<'EOF'\n" +
      '*filter\n' +
      ':ufw-user-input - [0:0]\n' +
      ':ufw-user-output - [0:0]\n' +
      ':ufw-user-forward - [0:0]\n' +
      ':ufw-user-limit-accept - [0:0]\n' +
      '-A ufw-user-input -p tcp --dport 9000 -j ACCEPT\n' +
      'COMMIT\n' +
      'EOF'
    );
    await server.executeCommand('ufw reload');

    // The rule was reconciled into the live iptables chain, not merely
    // parsed into ufw's in-memory rule list for display purposes.
    const listen = await server.executeCommand('iptables -L ufw-user-input -n');
    expect(listen).toMatch(/ACCEPT.*dpt:9000/);
  });

  it('parses ENABLED= and LOGLEVEL= from a hand-edited ufw.conf on reload', async () => {
    await server.executeCommand(
      "cat > /etc/ufw/ufw.conf <<'EOF'\n" +
      'ENABLED=yes\n' +
      'LOGLEVEL=high\n' +
      'EOF'
    );

    await server.executeCommand('ufw reload');

    const status = await server.executeCommand('ufw status verbose');
    expect(status).toMatch(/^Status: active/);
    expect(status).toContain('Logging: on (high)');
  });

  it('reconciles rules into live chains on reload even when enabled state does not change', async () => {
    // Enable first with one rule, then hand-edit to a different rule set
    // while staying enabled the whole time — this is the transition-only
    // bug: reconcileFromBoot() must not gate the rebuild on an
    // enabled-state flip.
    await server.executeCommand('ufw allow 111/tcp');
    await server.executeCommand('ufw enable');

    await server.executeCommand(
      "cat > /etc/ufw/user.rules <<'EOF'\n" +
      '*filter\n' +
      ':ufw-user-input - [0:0]\n' +
      ':ufw-user-output - [0:0]\n' +
      ':ufw-user-forward - [0:0]\n' +
      ':ufw-user-limit-accept - [0:0]\n' +
      '-A ufw-user-input -p tcp --dport 222 -j ACCEPT\n' +
      'COMMIT\n' +
      'EOF'
    );
    await server.executeCommand('ufw reload');

    const chain = await server.executeCommand('iptables -L ufw-user-input -n');
    expect(chain).toMatch(/ACCEPT.*dpt:222/);
    expect(chain).not.toMatch(/dpt:111/);
  });

  it('reloads IPv6 rules from user6.rules independently of user.rules', async () => {
    await server.executeCommand('ufw enable');

    await server.executeCommand(
      "cat > /etc/ufw/user6.rules <<'EOF'\n" +
      '*filter\n' +
      ':ufw6-user-input - [0:0]\n' +
      ':ufw6-user-output - [0:0]\n' +
      ':ufw6-user-forward - [0:0]\n' +
      ':ufw6-user-limit-accept - [0:0]\n' +
      '-A ufw6-user-input -p tcp --dport 7777 -j ACCEPT\n' +
      'COMMIT\n' +
      'EOF'
    );
    await server.executeCommand('ufw reload');

    const status = await server.executeCommand('ufw status');
    expect(status).toContain('7777/tcp (v6)');
  });
});
