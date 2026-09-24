/*
 * Probe — `apt install vsftpd` gives a Linux machine a real FTP server, and
 * `curl ftp://` talks to it over the wire.
 *
 * Before: no Linux machine could serve FTP (no vsftpd unit, no
 * /etc/vsftpd.conf, no ftp account, no /srv/ftp) and curl refused the
 * scheme outright ("Protocol "ftp" not supported or disabled in libcurl"),
 * although the repository already carried a full FTP engine (network/ftp)
 * that only the Cisco router used.
 *
 * Authorities, fetched and read: vsftpd 3.0.2 upstream sources
 * (vsftpd.conf sample, tunables.c compiled defaults, prelogin.c and
 * postlogin.c replies, ls.c and sysutil.c for the LIST line) and curl
 * 8.5.0 lib/ftp.c and lib/urldata.h (default anonymous/ftp@example.com,
 * "The file does not exist" 78, "Failed FTP upload: %d" 25, "Access denied:
 * %03d" 67). The banner carries 3.0.5, the version Ubuntu jammy packages.
 *
 * Measured before the change (git stash of src/network): 9 of the 10 cases
 * fail.
 * Passing either way:
 *   - "nothing listens on 21 before the package is installed" is the
 *     WITNESS: the lab and the wire are sound and the server is not a
 *     default of the image.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import '../new_firewall/fortigateBatteryHarness';

async function buildLab(install = true): Promise<{ srv: LinuxServer; pc: LinuxPC }> {
  const srv = new LinuxServer('linux-server', 'ftp1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  srv.powerOn();
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, pc.getPort('eth0') as never);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']) await srv.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) await pc.executeCommand(line);
  if (install) {
    await srv.executeCommand('apt install -y vsftpd');
    await srv.executeCommand('echo HELLO_FTP > /srv/ftp/test.txt');
  }
  return { srv, pc };
}

describe('vsftpd on Linux, reached by curl ftp://', () => {
  it('nothing listens on 21 before the package is installed', async () => {
    const { pc } = await buildLab(false);
    expect(await pc.executeCommand('nc -zv -w 1 10.0.0.2 21')).toContain('Connection refused');
  });

  it('the package installs, enables and starts the service on port 21', async () => {
    const { srv } = await buildLab();
    expect(await srv.executeCommand('systemctl is-active vsftpd')).toMatch(/^active$/m);
    expect(await srv.executeCommand('systemctl is-enabled vsftpd')).toMatch(/^enabled$/m);
    expect(await srv.executeCommand('ss -ltnp')).toMatch(/0\.0\.0\.0:21\s.*"vsftpd"/);
    expect(await srv.executeCommand('getent passwd ftp')).toMatch(/^ftp:x:\d+:\d+::\/srv\/ftp:\/usr\/sbin\/nologin$/m);
  });

  it('an anonymous download returns the file', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('curl -sS ftp://10.0.0.2/test.txt')).toBe('HELLO_FTP\n');
  });

  it('a directory URL lists in the vsftpd format', async () => {
    const { pc } = await buildLab();
    const listing = await pc.executeCommand('curl -sS ftp://10.0.0.2/');
    expect(listing).toMatch(/^-rw-r--r-- {4}1 0 {8}0 {14}10 [A-Z][a-z]{2} \d{2} \d{2}:\d{2} test\.txt$/m);
  });

  it('a missing file is reported as curl reports it', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl -sS ftp://10.0.0.2/nope.txt; echo EC=$?');
    expect(out).toContain('curl: (78) The file does not exist');
    expect(out).toContain('EC=78');
  });

  it('an anonymous upload is refused while write_enable is off', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('echo UP > up.txt; curl -sS -T up.txt ftp://10.0.0.2/; echo EC=$?');
    expect(out).toContain('curl: (25) Failed FTP upload: 550');
  });

  it('a local account is refused on an anonymous-only server', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl -sS -u root:secret ftp://10.0.0.2/; echo EC=$?');
    expect(out).toContain('curl: (67) Access denied: 530');
  });

  it('an anonymous upload lands owned by ftp once the configuration allows it', async () => {
    const { srv, pc } = await buildLab();
    await srv.executeCommand("sed -i 's/^#write_enable=YES/write_enable=YES/; s/^#anon_upload_enable=YES/anon_upload_enable=YES/' /etc/vsftpd.conf");
    await srv.executeCommand('mkdir /srv/ftp/in; chown ftp /srv/ftp/in; systemctl restart vsftpd');
    await pc.executeCommand('echo UP > up.txt');
    expect(await pc.executeCommand('curl -sS -T up.txt ftp://10.0.0.2/in/; echo EC=$?')).toContain('EC=0');
    expect(await srv.executeCommand('cat /srv/ftp/in/up.txt')).toMatch(/^UP$/m);
    expect(await srv.executeCommand('stat -c %U /srv/ftp/in/up.txt')).toMatch(/^ftp$/m);
  });

  it('a data channel that cannot open is an error, not an empty download', async () => {
    const { srv, pc } = await buildLab();
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 1024:65535 -j DROP');
    const out = await pc.executeCommand('curl -sS ftp://10.0.0.2/test.txt; echo EC=$?');
    expect(out).toMatch(/curl: \(7\) Failed to connect to 10\.0\.0\.2 port \d+: Connection refused/);
    expect(out).toContain('EC=7');
    expect(out).not.toContain('HELLO_FTP');
  });

  it('a directive the simulator does not evaluate stops the service from starting', async () => {
    const { srv } = await buildLab();
    await srv.executeCommand('echo userlist_enable=YES >> /etc/vsftpd.conf');
    const out = await srv.executeCommand('systemctl restart vsftpd; systemctl is-active vsftpd');
    expect(out).toContain('userlist_enable is not supported by this simulator');
    expect(out).not.toMatch(/^active$/m);
  });
});
