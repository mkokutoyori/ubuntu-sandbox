/*
 * Probe — `curl --connect-timeout` bounds the wait for an unanswered SYN
 * and fails the way curl 8.5.0 does.
 *
 * Authority: curl 8.5.0 source, lib/connect.c (a single address whose
 * attempt outlives its timeout ends in "Failed to connect to %s port %u
 * after %d ms: %s" with CURLE_OPERATION_TIMEDOUT, code 28) and
 * lib/strerror.c (CURLE_OPERATION_TIMEDOUT reads "Timeout was reached").
 *
 * Measured before the change (git stash of src/network): 3 of the 4 cases
 * fail — the option was refused outright with "is not implemented in this
 * simulator", so neither the dropped SYN, nor the allowed request, nor the
 * malformed value reached the engine.
 * Passing either way:
 *   - "without the option" is the WITNESS: the same lab serves the page on
 *     port 80, so the server and the path are sound.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

async function buildLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
  [pc, srv, sw].forEach((d) => d.powerOn());
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) await pc.executeCommand(line);
  for (const line of [
    'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0',
    'systemctl start nginx', 'iptables -A INPUT -p tcp --dport 443 -j DROP',
  ]) await srv.executeCommand(line);
  return { pc, srv };
}

describe('curl --connect-timeout', () => {
  it('without the option, the page on port 80 is served', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('curl -s http://10.0.0.2/')).toMatch(/nginx/i);
  });

  it('an allowed request under a connect timeout is served', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('curl -s --connect-timeout 1 http://10.0.0.2/')).toMatch(/nginx/i);
  });

  it('a silently dropped SYN fails with code 28 once the timeout elapses', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl -k -sS --connect-timeout 1 https://10.0.0.2/; echo EC=$?');
    const failure = /curl: \(28\) Failed to connect to 10\.0\.0\.2 port 443 after (\d+) ms: Timeout was reached/.exec(out);
    expect(failure).not.toBeNull();
    expect(Number(failure![1])).toBeGreaterThanOrEqual(1000);
    expect(out).toContain('EC=28');
  });

  it('a value that is not a number is refused', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl --connect-timeout abc http://10.0.0.2/');
    expect(out).toContain('curl: option --connect-timeout: expected a proper numerical parameter');
  });
});
