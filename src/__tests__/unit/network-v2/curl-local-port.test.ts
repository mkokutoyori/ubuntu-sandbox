/*
 * Probe — `curl --local-port` binds the source port of the connection, and
 * `-w` reports the local end; an HTTPS transfer opens one connection.
 *
 * Before: `curl --local-port 45678 …` answered "option --local-port: is
 * unknown" (FortiGate battery 02, test 69, which then looks for 45678 in
 * `diagnose sys session list`), `-w "%{local_port}"` was an unknown
 * variable, and an HTTPS transfer dialled the server twice: once to test
 * the connection, once more inside the TLS session.
 *
 * Authority: curl 8.5.0 (curl/curl, tag curl-8_5_0): src/tool_getparam.c
 * parses `--local-port NUM[-NUM]` and answers PARAM_BAD_USE ("is badly
 * used here", src/tool_helpers.c) for anything else or above 65535;
 * lib/cf-socket.c tries each port of the range and fails with "bind failed
 * with errno %d: %s", CURLE_INTERFACE_FAILED (45); `local_ip` and
 * `local_port` are write-out variables (curl(1), --write-out).
 *
 * Measured before the change (git stash of src/network): 6 of the 7 cases
 * fail.
 * Passing either way:
 *   - "a transfer without --local-port" is the WITNESS.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

async function buildLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const srv = new LinuxServer('linux-server', 'web', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  srv.powerOn();
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, pc.getPort('eth0') as never);
  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'systemctl start nginx']) await srv.executeCommand(c);
  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) await pc.executeCommand(c);
  return { pc, srv };
}

async function serveHttps(srv: LinuxServer): Promise<void> {
  for (const c of [
    'systemctl stop nginx',
    'a2enmod ssl',
    'mkdir -p /etc/ssl/certs /etc/ssl/private',
    'openssl req -x509 -newkey rsa:512 -keyout /etc/ssl/private/lab.key -out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=lab.local"',
    `sh -c 'printf "<VirtualHost *:443>\\n\\tDocumentRoot /var/www/html\\n\\tSSLEngine on\\n\\tSSLCertificateFile /etc/ssl/certs/lab.crt\\n\\tSSLCertificateKeyFile /etc/ssl/private/lab.key\\n</VirtualHost>\\n" > /etc/apache2/sites-available/lab-ssl.conf'`,
    'ln -s ../sites-available/lab-ssl.conf /etc/apache2/sites-enabled/lab-ssl.conf',
    'systemctl start apache2',
  ]) await srv.executeCommand(c);
}

describe('curl --local-port', () => {
  it('a transfer without --local-port', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://10.0.0.2/')).toBe('200');
  });

  it('the connection leaves from the port asked for', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand('curl --local-port 45678 -s -o /dev/null http://10.0.0.2/');
    expect(await pc.executeCommand('ss -tan')).toMatch(/^TIME-WAIT\s+0\s+0\s+10\.0\.0\.1:45678\s+10\.0\.0\.2:80\b/m);
  });

  it('-w reports the local end', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('curl --local-port 45678 -s -o /dev/null -w "%{local_ip}:%{local_port}" http://10.0.0.2/'))
      .toBe('10.0.0.1:45678');
  });

  it('a range takes its first free port', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand('curl --local-port 45000-45010 -s -o /dev/null http://10.0.0.2/');
    expect(await pc.executeCommand('curl --local-port 45000-45010 -s -o /dev/null -w "%{local_port}" http://10.0.0.2/'))
      .toBe('45001');
  });

  it('a port held by the same connection fails to bind', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand('curl --local-port 45678 -s -o /dev/null http://10.0.0.2/');
    const out = await pc.executeCommand('curl --local-port 45678 -sS -o /dev/null http://10.0.0.2/; echo EC=$?');
    expect(out).toContain('curl: (45) bind failed with errno 98: Address already in use');
    expect(out).toContain('EC=45');
  });

  it('a value that is not a port is refused', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl --local-port 70000 http://10.0.0.2/; echo EC=$?');
    expect(out).toContain('curl: option --local-port: is badly used here');
    expect(out).toContain('EC=2');
  });

  it('an HTTPS transfer opens one connection, from the port asked for', async () => {
    const { pc, srv } = await buildLab();
    await serveHttps(srv);
    expect(await pc.executeCommand('curl -k --local-port 45680 -s -o /dev/null -w "%{http_code}" https://10.0.0.2/')).toBe('200');
    const sockets = (await pc.executeCommand('ss -tan')).split('\n').filter((l) => l.includes('10.0.0.2:443'));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toContain('10.0.0.1:45680');
  });
});
