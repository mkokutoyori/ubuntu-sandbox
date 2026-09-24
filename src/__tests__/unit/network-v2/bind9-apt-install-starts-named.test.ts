/*
 * Probe — after `apt install bind9`, `named` starts and serves a zone.
 *
 * The install hook wrote /etc/bind/named.conf including
 * named.conf.options and named.conf.local, and wrote neither: `systemctl
 * start named` then failed with "/etc/bind/named.conf:1: open:
 * /etc/bind/named.conf.options: file not found", so no LinuxServer could
 * serve DNS without the operator hand-writing files the package ships.
 *
 * The Ubuntu/Debian package files could not be fetched from this
 * environment (launchpad.net and salsa.debian.org are refused by the
 * egress proxy), so only the directives of named.conf.options this probe
 * relies on are asserted: `directory "/var/cache/bind"`.
 *
 * Measured before the fix (git stash of src/network): 2 of the 3 cases
 * fail — named stayed "failed" and the zone was never served.
 * Passing either way:
 *   - "the package writes named.conf" is the WITNESS: the install hook ran.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import '../new_firewall/fortigateBatteryHarness';

const ZONE = [
  '$TTL 3600',
  '@ IN SOA ns1.lab.lan. admin.lab.lan. ( 1 3600 900 604800 300 )',
  '@ IN NS ns1.lab.lan.',
  'ns1 IN A 10.0.0.2',
  'web IN A 10.0.0.80',
].join('\\n');

async function buildLab(): Promise<{ srv: LinuxServer; cli: LinuxPC }> {
  const srv = new LinuxServer('linux-server', 'dns1', 0, 0);
  const cli = new LinuxPC('linux-pc', 'pc1', 0, 0);
  srv.powerOn();
  cli.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, cli.getPort('eth0') as never);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']) await srv.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) await cli.executeCommand(line);
  await srv.executeCommand('apt install -y bind9');
  return { srv, cli };
}

describe('apt install bind9 leaves a named that starts', () => {
  it('the package writes named.conf', async () => {
    const { srv } = await buildLab();
    expect(await srv.executeCommand('cat /etc/bind/named.conf')).toContain('include "/etc/bind/named.conf.options";');
  });

  it('named starts and listens on port 53', async () => {
    const { srv } = await buildLab();
    expect(await srv.executeCommand('cat /etc/bind/named.conf.options')).toContain('directory "/var/cache/bind";');
    await srv.executeCommand('systemctl start named');
    expect((await srv.executeCommand('systemctl is-active named')).trim()).toBe('active');
    expect(await srv.executeCommand('ss -lun')).toMatch(/0\.0\.0\.0:53\s/);
  });

  it('a declared zone is answered authoritatively on the wire', async () => {
    const { srv, cli } = await buildLab();
    await srv.executeCommand(`printf '${ZONE}\\n' > /etc/bind/db.lab.lan`);
    await srv.executeCommand(`echo 'zone "lab.lan" { type master; file "/etc/bind/db.lab.lan"; };' >> /etc/bind/named.conf.local`);
    await srv.executeCommand('systemctl reload named');
    const out = await cli.executeCommand('dig @10.0.0.2 web.lab.lan');
    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/flags: qr aa/);
    expect(out).toMatch(/web\.lab\.lan\.\s+\d+\s+IN\s+A\s+10\.0\.0\.80/);
  });
});
