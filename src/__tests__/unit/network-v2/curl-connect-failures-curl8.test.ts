/*
 * Probe — curl reports a failed connection the way curl 8.5.0 does, and a
 * SYN that nobody answers is a kernel timeout, not a refusal.
 *
 * Before: any connection that did not open at once was printed as
 * "curl: (7) Failed to connect to H port P: Connection refused" — the
 * pre-7.88 wording — including a SYN silently dropped by the server.
 *
 * Authority: curl 8.5.0 (curl/curl, tag curl-8_5_0), lib/connect.c:
 * failf "Failed to connect to %s port %u after %d ms: %s" with
 * curl_easy_strerror(CURLE_COULDNT_CONNECT) = "Couldn't connect to server"
 * (lib/strerror.c), the result turned into CURLE_OPERATION_TIMEDOUT (28)
 * when the OS said ETIMEDOUT; lib/connect.h DEFAULT_CONNECT_TIMEOUT 300000.
 * The SYN retransmission schedule is the simulator's TCP stack (RTO 1 s
 * doubling, five retransmissions), not Linux's tcp_syn_retries.
 *
 * Measured before the change (git stash of src/network/http/curl): 4 of the
 * 5 cases fail.
 * Passing either way:
 *   - "--connect-timeout still bounds the wait" is the WITNESS.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper } from '../new_firewall/fortigateBatteryHarness';

async function buildLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const srv = new LinuxServer('linux-server', 'web1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  srv.powerOn();
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, pc.getPort('eth0') as never);
  await taper(srv as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']);
  return { pc, srv };
}

describe('curl connection failures, curl 8 wording', () => {
  it('a refused HTTP connection', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl -sS http://10.0.0.2:81/; echo EC=$?');
    expect(out).toContain("curl: (7) Failed to connect to 10.0.0.2 port 81 after 0 ms: Couldn't connect to server");
    expect(out).toContain('EC=7');
  });

  it('a refused HTTPS connection', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl -sS https://10.0.0.2/; echo EC=$?');
    expect(out).toContain("curl: (7) Failed to connect to 10.0.0.2 port 443 after 0 ms: Couldn't connect to server");
  });

  it('a refused FTP control connection', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('curl -sS ftp://10.0.0.2/; echo EC=$?');
    expect(out).toContain("curl: (7) Failed to connect to 10.0.0.2 port 21 after 0 ms: Couldn't connect to server");
  });

  it('a SYN dropped by the server ends in a kernel timeout, code 28', async () => {
    const { pc, srv } = await buildLab();
    await taper(srv as unknown as Cli, ['systemctl start nginx', 'iptables -A INPUT -p tcp --dport 80 -j DROP']);
    const out = await pc.executeCommand('curl -sS http://10.0.0.2/; echo EC=$?');
    expect(out).toMatch(/^curl: \(28\) Failed to connect to 10\.0\.0\.2 port 80 after \d+ ms: Couldn't connect to server$/m);
    expect(out).toContain('EC=28');
    expect(out).not.toContain('Connection refused');
  });

  it('--connect-timeout still bounds the wait', async () => {
    const { pc, srv } = await buildLab();
    await taper(srv as unknown as Cli, ['systemctl start nginx', 'iptables -A INPUT -p tcp --dport 80 -j DROP']);
    const out = await pc.executeCommand('curl -sS --connect-timeout 2 http://10.0.0.2/; echo EC=$?');
    expect(out).toMatch(/curl: \(28\) Failed to connect to 10\.0\.0\.2 port 80 after 20\d\d ms: Timeout was reached/);
  });
});
