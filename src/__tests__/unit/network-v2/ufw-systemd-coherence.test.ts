/**
 * ufw ↔ systemd coherence — PRD-Iptables-UFW.md §1.3 items A.1/A.2,
 * §2.1 objectifs A.1/A.2 (Phase 5).
 *
 * Before this fix, the `ufw` systemd unit was pure display: `systemctl
 * start/stop ufw` never touched `LinuxFirewallManager`, and `ufw enable`/
 * `disable` never touched `serviceMgr` — `systemctl status ufw` and the
 * real firewall state could silently diverge in both directions, and a
 * simulated reboot always reactivated the unit regardless of the persisted
 * `ENABLED=` value in `/etc/ufw/ufw.conf`.
 *
 * Design note (discovered while implementing, documented rather than
 * forced): `systemctl stop ufw` deliberately does *not* disable the live
 * firewall. A generic reboot cycle stops every active unit before
 * restarting the enabled ones — wiring `stop` to `cmdDisable()` would
 * persist `ENABLED=no` for the split second before the unit restarts,
 * corrupting the very state Phase 5 exists to preserve across reboot. Real
 * `ufw.service` has no meaningful `ExecStop` for the same reason (it's a
 * oneshot activation script, not a process whose exit tears down loaded
 * rules). `systemctl start ufw` (including the boot-time restart) always
 * reconciles against `ufw.conf` instead.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('ufw ↔ systemd coherence', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'SRV1');
  });

  it('ufw enable makes systemctl status ufw report active', async () => {
    await server.executeCommand('ufw enable');
    const status = await server.executeCommand('systemctl status ufw');
    expect(status).toMatch(/active/);
    expect(status).not.toMatch(/inactive/);
  });

  it('ufw disable makes systemctl status ufw report inactive', async () => {
    await server.executeCommand('ufw enable');
    await server.executeCommand('ufw disable');
    const status = await server.executeCommand('systemctl status ufw');
    expect(status).toMatch(/inactive/);
  });

  it('systemctl stop ufw does not disable the live firewall (no ExecStop side effect, by design)', async () => {
    await server.executeCommand('ufw default deny incoming');
    await server.executeCommand('ufw enable');
    await server.executeCommand('systemctl stop ufw');

    // The firewall's own state is unaffected by stopping the unit — real
    // ufw.service has no meaningful ExecStop for the same reason.
    const status = await server.executeCommand('ufw status');
    expect(status).toMatch(/^Status: active/);
  });

  it('systemctl start ufw does not blindly enable the firewall — it defers to ufw.conf', async () => {
    // Never ran `ufw enable`, so /etc/ufw/ufw.conf still says ENABLED=no.
    await server.executeCommand('systemctl start ufw');
    const status = await server.executeCommand('ufw status');
    expect(status).toBe('Status: inactive');
  });

  it('systemctl restart ufw re-enables the firewall when ufw.conf says ENABLED=yes', async () => {
    await server.executeCommand('ufw enable');
    await server.executeCommand('systemctl restart ufw');
    const status = await server.executeCommand('ufw status');
    expect(status).toMatch(/^Status: active/);
  });

  it('a reboot with ENABLED=no persisted does not reactivate the firewall', async () => {
    await server.executeCommand('ufw enable');
    await server.executeCommand('ufw disable');
    await server.executeCommand('reboot');

    const status = await server.executeCommand('ufw status');
    expect(status).toBe('Status: inactive');
    // The systemd unit itself still comes back up (oneshot success),
    // independently of whether the firewall rules were reloaded.
    const svc = await server.executeCommand('systemctl status ufw');
    expect(svc).toMatch(/active/);
  });

  it('a reboot with ENABLED=yes persisted keeps the firewall active and its rules intact', async () => {
    await server.executeCommand('ufw default deny incoming');
    await server.executeCommand('ufw allow 22/tcp');
    await server.executeCommand('ufw enable');
    await server.executeCommand('reboot');

    const status = await server.executeCommand('ufw status');
    expect(status).toMatch(/^Status: active/);
    expect(status).toContain('22/tcp');
  });
});
