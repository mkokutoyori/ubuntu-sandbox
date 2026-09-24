/*
 * Probe — `apt install bind9` leaves named RUNNING and enabled, as a Debian
 * package does (a daemon's maintainer scripts enable and start its unit on
 * install; vsftpd already behaves so in this simulator).
 *
 * Before: the install hook wrote the configuration and started nothing: on
 * a LinuxServer port 53 had no listener (`ss -lun` showed only
 * systemd-resolved on 127.0.0.53) and `dig @127.0.0.1` timed out until an
 * operator typed `systemctl start named`.
 *
 * Measured before the change (git stash of LinuxCommandExecutor.ts): 3 of
 * the 4 cases fail.
 * Passing either way:
 *   - "nothing answers on 53 before the package" is the WITNESS: the
 *     listener is the package's doing, not a default of the image.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import '../new_firewall/fortigateBatteryHarness';

async function server(install: boolean): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'ns1', 0, 0);
  srv.powerOn();
  if (install) await srv.executeCommand('apt install -y bind9');
  return srv;
}

describe('bind9 runs right after apt install', () => {
  it('nothing answers on 53 before the package', async () => {
    const srv = await server(false);
    expect(await srv.executeCommand('ss -lun')).not.toMatch(/0\.0\.0\.0:53\s/);
  });

  it('named is active and enabled', async () => {
    const srv = await server(true);
    expect(await srv.executeCommand('systemctl is-active named')).toMatch(/^active$/m);
    expect(await srv.executeCommand('systemctl is-enabled named')).toMatch(/^enabled$/m);
  });

  it('named listens on port 53', async () => {
    const srv = await server(true);
    expect(await srv.executeCommand('ss -lun')).toMatch(/0\.0\.0\.0:53\s/);
  });

  it('a local query is answered instead of timing out', async () => {
    const srv = await server(true);
    const out = await srv.executeCommand('dig @127.0.0.1 localhost +tries=1');
    expect(out).toMatch(/;; ->>HEADER<<- opcode: QUERY, status: /);
    expect(out).not.toContain('connection timed out');
  });
});
