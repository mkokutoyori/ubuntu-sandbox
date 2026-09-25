/*
 * Probe — `apt` installs and removes packages on THIS machine: its
 * /var/lib/dpkg/status, its systemd units, its services.
 *
 * Before: `apt install <pkg>` answered "<pkg> is already the newest
 * version" for any package of a module-wide table and laid nothing down.
 * On a LinuxPC, `apt install -y nginx` then `systemctl start nginx` gave
 * "Unit nginx.service not found." (FortiGate battery test 18, the TODO
 * entry [apt]); vsftpd was listed as installed everywhere.
 *
 * Authority: apt 2.4.12 (Debian/apt, apt-private/private-install.cc and
 * private-output.cc: "%s is already the newest version (%s).", "The
 * following NEW packages will be installed:", "The following packages
 * will be REMOVED:", "%lu upgraded, %lu newly installed, %lu to remove and
 * %lu not upgraded.", "Package '%s' is not installed, so not removed";
 * apt-pkg/depcache.cc "Building dependency tree", "Reading state
 * information"); dpkg (guillemj/dpkg, src/main/archives.c "Selecting
 * previously unselected package %s.", unpack.c "Preparing to unpack %s
 * ..." / "Unpacking %s (%s) ...", configure.c "Setting up %s (%s) ...",
 * remove.c "Removing %s (%s) ..." / "Purging configuration files for %s
 * (%s) ..."). Debian policy: a daemon package enables and starts its
 * service on installation. No archive is modelled, so the download lines
 * ("Need to get", "Get:", "Fetched") are not printed.
 *
 * Measured before the change (git stash of src/network/devices/linux):
 * 7 of the 9 cases fail.
 * Passing either way:
 *   - "the server image ships nginx" is the WITNESS.
 *   - "a package already there is not installed again" is non-regression.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';

function pc(name = 'pc1'): LinuxPC {
  const machine = new LinuxPC('linux-pc', name, 0, 0);
  machine.powerOn();
  return machine;
}

describe('apt installs on this machine', () => {
  it('the server image ships nginx', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    srv.powerOn();
    expect(await srv.executeCommand('apt install -y nginx')).toContain('nginx is already the newest version (1.18.0-6ubuntu14.4).');
    expect(await srv.executeCommand('systemctl start nginx; echo EC=$?')).toBe('EC=0');
  });

  it('a desktop has no nginx until it is installed', async () => {
    const machine = pc();
    expect(await machine.executeCommand('systemctl start nginx')).toContain('Unit nginx.service not found.');
    expect(await machine.executeCommand('dpkg -l nginx')).toContain('dpkg-query: no packages found matching nginx');
  });

  it('apt install lays the package down in apt and dpkg words', async () => {
    const out = await pc().executeCommand('apt install -y nginx');
    expect(out).toContain([
      'Reading package lists... Done',
      'Building dependency tree... Done',
      'Reading state information... Done',
      'The following NEW packages will be installed:',
      '  nginx',
      '0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.',
      'Selecting previously unselected package nginx.',
      'Preparing to unpack .../nginx_1.18.0-6ubuntu14.4_amd64.deb ...',
      'Unpacking nginx (1.18.0-6ubuntu14.4) ...',
      'Setting up nginx (1.18.0-6ubuntu14.4) ...',
    ].join('\n'));
  });

  it('the installed daemon runs and serves', async () => {
    const machine = pc();
    await machine.executeCommand('apt install -y nginx');
    expect(await machine.executeCommand('systemctl is-active nginx; systemctl is-enabled nginx')).toBe('active\nenabled');
    expect(await machine.executeCommand('curl -s http://127.0.0.1/')).toMatch(/Welcome to nginx/);
  });

  it('a package already there is not installed again', async () => {
    const machine = pc();
    await machine.executeCommand('apt install -y curl');
    expect(await machine.executeCommand('apt install -y curl')).toContain('curl is already the newest version (7.81.0-1ubuntu1.15).');
  });

  it('dpkg, apt list and the status file agree', async () => {
    const machine = pc();
    await machine.executeCommand('apt install -y nginx');
    expect(await machine.executeCommand('dpkg -l nginx')).toMatch(/^ii  nginx /m);
    expect(await machine.executeCommand('apt list --installed')).toContain('nginx/jammy,now 1.18.0-6ubuntu14.4 amd64 [installed]');
    expect(await machine.executeCommand("sed -n '/^Package: nginx$/,/^$/p' /var/lib/dpkg/status")).toContain('Status: install ok installed');
  });

  it('installing on one machine leaves the other untouched', async () => {
    const first = pc('pc1');
    const second = pc('pc2');
    await first.executeCommand('apt install -y nginx');
    expect(await second.executeCommand('dpkg -l nginx')).toContain('no packages found matching nginx');
  });

  it('apt remove stops the daemon and keeps its configuration', async () => {
    const machine = pc();
    await machine.executeCommand('apt install -y nginx');
    const out = await machine.executeCommand('apt remove -y nginx');
    expect(out).toContain('The following packages will be REMOVED:\n  nginx\n0 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.');
    expect(out).toContain('Removing nginx (1.18.0-6ubuntu14.4) ...');
    expect(await machine.executeCommand('systemctl start nginx')).toContain('Unit nginx.service not found.');
    expect(await machine.executeCommand('dpkg -l nginx')).toMatch(/^rc  nginx /m);
  });

  it('vsftpd arrives with its account, its root and its running daemon', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    srv.powerOn();
    expect(await srv.executeCommand('dpkg -l vsftpd')).toContain('no packages found matching vsftpd');
    await srv.executeCommand('apt install -y vsftpd');
    expect(await srv.executeCommand('systemctl is-active vsftpd; id -un ftp; test -d /srv/ftp && echo ROOT')).toBe('active\nftp\nROOT');
  });
});
