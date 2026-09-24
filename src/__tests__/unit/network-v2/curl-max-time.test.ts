/*
 * Probe — `curl -m` / `--max-time` bounds the whole operation, the
 * connection included, and the smaller of it and --connect-timeout wins.
 *
 * Before: the parser listed `-m` and `--max-time` as unsupported, so every
 * `curl -m 5 …` of the FortiGate tutorial answered an option error instead
 * of trying to connect.
 *
 * Authority: curl 8.5.0 (curl/curl, tag curl-8_5_0). lib/connect.c
 * Curl_timeleft takes the smaller of CURLOPT_TIMEOUT (what remains of the
 * operation) and the connect timeout while connecting; a baller whose
 * budget runs out fails with CURLE_OPERATION_TIMEDOUT and the common failf
 * "Failed to connect to %s port %u after %d ms: %s" reads "Timeout was
 * reached". src/tool_getparam.c parses the value as a decimal number of
 * seconds and refuses anything else with "expected a proper numerical
 * parameter".
 *
 * Measured before the change (git stash of src/network/http/curl): 6 of the
 * 7 cases fail.
 * Passing either way:
 *   - "--connect-timeout alone" is the WITNESS: the dropped-SYN lab is
 *     sound and the timing reads in virtual milliseconds.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper } from '../new_firewall/fortigateBatteryHarness';

async function buildLab(dropSyn: boolean): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const srv = new LinuxServer('linux-server', 'web1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  srv.powerOn();
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, pc.getPort('eth0') as never);
  await taper(srv as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'systemctl start nginx']);
  if (dropSyn) await taper(srv as unknown as Cli, ['iptables -A INPUT -p tcp -j DROP']);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']);
  return { pc, srv };
}

describe('curl -m / --max-time', () => {
  it('--connect-timeout alone', async () => {
    const { pc } = await buildLab(true);
    expect(await pc.executeCommand('curl -sS --connect-timeout 2 http://10.0.0.2/'))
      .toMatch(/Failed to connect to 10\.0\.0\.2 port 80 after 20\d\d ms: Timeout was reached/);
  });

  it('-m bounds a connection nobody answers', async () => {
    const { pc } = await buildLab(true);
    const out = await pc.executeCommand('curl -sS -m 5 http://10.0.0.2/; echo EC=$?');
    expect(out).toMatch(/^curl: \(28\) Failed to connect to 10\.0\.0\.2 port 80 after 50\d\d ms: Timeout was reached$/m);
    expect(out).toContain('EC=28');
  });

  it('--max-time is the same option', async () => {
    const { pc } = await buildLab(true);
    expect(await pc.executeCommand('curl -sS --max-time 3 http://10.0.0.2/'))
      .toMatch(/after 30\d\d ms: Timeout was reached/);
  });

  it('the smaller of -m and --connect-timeout wins', async () => {
    const { pc } = await buildLab(true);
    expect(await pc.executeCommand('curl -sS -m 5 --connect-timeout 2 http://10.0.0.2/'))
      .toMatch(/after 20\d\d ms: Timeout was reached/);
    expect(await pc.executeCommand('curl -sS -m 2 --connect-timeout 5 http://10.0.0.2/'))
      .toMatch(/after 20\d\d ms: Timeout was reached/);
  });

  it('-m bounds the FTP control connection too', async () => {
    const { pc } = await buildLab(true);
    expect(await pc.executeCommand('curl -sS -m 2 ftp://10.0.0.2/'))
      .toMatch(/Failed to connect to 10\.0\.0\.2 port 21 after 20\d\d ms: Timeout was reached/);
  });

  it('a reachable server still answers under -m', async () => {
    const { pc } = await buildLab(false);
    expect(await pc.executeCommand('curl -sS -m 5 http://10.0.0.2/')).toMatch(/nginx/i);
  });

  it('a value that is not a number is refused', async () => {
    const { pc } = await buildLab(false);
    const out = await pc.executeCommand('curl -sS -m abc http://10.0.0.2/; echo EC=$?');
    expect(out).toContain('curl: option -m: expected a proper numerical parameter');
    expect(out).toContain('EC=2');
  });
});
