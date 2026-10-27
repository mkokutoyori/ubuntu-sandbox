/**
 * nc as a long-lived client and server, and what ss/netstat/sysctl then say about it, measured on netcat-openbsd 1.226-1ubuntu2 and
 * iproute2 6.1.0 in a fresh network and pid namespace (the full corpus is replayed by netcmds-oracle.test.ts; these cases pin the pieces
 * that corpus cannot name):
 *
 *   echo hi | nc H P &            the pipeline runs in the background; with no -N, -q or -w the client stays connected until killed
 *   kill -0 PID                   existence probe: rc 0 for a live pid, "No such process" rc 1 otherwise (it was "invalid signal specification")
 *   nc -kl P + two clients        the listener serves one at a time: the second connection is ESTABLISHED in the kernel and counted in
 *                                 the listener's Recv-Q (1), its data is read only after the first client leaves
 *   ss -m                         skmem:(r,rb,t,tb,f,w,o,bl,d) with rb/tb read from net.ipv4.tcp_rmem/tcp_wmem
 *   sysctl net.ipv4.tcp_rmem      "4096\t131072\t6291456" and writable; ss -m shows the middle value as rb
 *   nc -u -p 40003 H 5300 &       a connected UDP socket is ESTAB with its peer in ss -ua (it showed UNCONN 0.0.0.0:40003)
 *   echo x | nc -u H P            with a listener the client stays (no reply ever comes); with a closed port the ICMP error ends it at once, rc 0
 *
 * A job started from a typed line is announced `[N] pid` whatever the line holds (an interactive bash does, a script never does), so `root` strips the notice
 * and `typed` keeps it.
 *
 * Measured with the sources at HEAD: 7 of the 10 cases fall (the piped client, kill -0, the accept queue, skmem, the connected UDP socket, the piped UDP
 * client and the queued connection's cgroup). The three that pass either way are named: the foreground `-N` client (WITNESS: the lab is sound and the
 * faithful loop did not break the short exchange), the standalone trailing `&` (NON-REGRESSION: its `[N] pid` announcement existed) and
 * `echo start; sleep 100 & echo after` (NON-REGRESSION: a trailing `&` must keep backgrounding only the last command of a compound line).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function typed(line: string): Promise<string> {
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return machine.executor.runAsUser('root', () => pc.executeCommand(line));
}

async function root(line: string): Promise<string> {
  return (await typed(line)).replace(/^\[\d+\] \d+\n?/gm, '').replace(/\n$/, '');
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await root('ip link set lo up');
  await root('cd /tmp');
});

describe('long-lived nc connections', () => {
  it('a client typed alone with a trailing & returns at once', async () => {
    await root('nc -l 127.0.0.1 9300 & sleep 0.3');
    expect(await typed('nc 127.0.0.1 9300 &')).toMatch(/^\[\d+\] \d+$/);
  });

  it('a trailing & only backgrounds the last command of the line', async () => {
    expect(await typed('echo start; sleep 100 & echo after')).toMatch(/^start\n\[\d+\] \d+\nafter$/);
  });

  it('a piped client without -N stays connected until it is killed', async () => {
    const out = await root('nc -l 127.0.0.1 9301 > got.txt & S=$!; sleep 0.3; echo hi | nc 127.0.0.1 9301 & C=$!; sleep 1; kill -0 $C && echo client-alive; kill -0 $S && echo server-alive; cat got.txt');
    expect(out).toBe('client-alive\nserver-alive\nhi');
    expect(await root('ss -tn state established | wc -l')).toBe('3');
  });

  it('WITNESS: a foreground client with -N returns once the server closes', async () => {
    const out = await root('nc -l 127.0.0.1 9302 > got.txt & S=$!; sleep 0.3; echo hi | nc -N 127.0.0.1 9302; echo rc=$?; kill -0 $S 2>/dev/null && echo server-alive || echo server-gone; cat got.txt');
    expect(out).toBe('rc=0\nserver-gone\nhi');
  });

  it('kill -0 reports a missing process', async () => {
    expect(await root('kill -0 4000; echo rc=$?')).toBe('bash: kill: (4000) - No such process\nrc=1');
    expect(await root('sleep 100 & kill -0 $!; echo rc=$?')).toBe('rc=0');
  });

  it('the second client of nc -kl waits in the accept queue', async () => {
    await root('nc -kl 127.0.0.1 9303 > got.txt & sleep 0.3; nc -p 40001 127.0.0.1 9303 & nc -p 40002 127.0.0.1 9303 &');
    expect(await root('ss -tlnH sport = :9303')).toMatch(/^LISTEN\s+1\s+1\s/);
    expect(await root('ss -tan state established | grep -c 9303')).toBe('4');
  });

  it('ss -m prints skmem from the buffer sysctls', async () => {
    await root('nc -l 127.0.0.1 9304 &');
    expect(await root('ss -tlmH sport = :9304')).toContain('skmem:(r0,rb131072,t0,tb16384,f0,w0,o0,bl0,d0)');
    expect(await root('sysctl net.ipv4.tcp_rmem')).toBe('net.ipv4.tcp_rmem = 4096\t131072\t6291456');
    await root('sysctl -w net.ipv4.tcp_rmem="4096 262144 6291456"');
    expect(await root('ss -tlmH sport = :9304')).toContain('rb262144');
  });

  it('a connected UDP client is ESTAB with its peer', async () => {
    await root('nc -lu 127.0.0.1 5300 > got.txt & sleep 0.3; nc -u -p 40003 127.0.0.1 5300 &');
    const rows = (await root('ss -uanH | grep -E ":(40003|5300) "')).split('\n').map((line) => line.trim().split(/\s+/).join(' '));
    expect(rows.sort()).toEqual(['ESTAB 0 0 127.0.0.1:40003 127.0.0.1:5300', 'UNCONN 0 0 127.0.0.1:5300 0.0.0.0:*']);
  });

  it('a piped UDP client stays while the port has a listener and leaves at once when the port is closed', async () => {
    await root('nc -lu 127.0.0.1 5301 > got.txt & sleep 0.3');
    const out = await root('echo hi | nc -u 127.0.0.1 5301 & C=$!; sleep 1; kill -0 $C && echo open-alive; echo test | nc -u 127.0.0.1 19999; echo closed-rc=$?');
    expect(out).toBe('open-alive\nclosed-rc=0');
  });

  it('a queued connection reports a cgroup but no descriptor', async () => {
    await root('nc -kl 127.0.0.1 9305 > got.txt & sleep 0.3; nc -p 40011 127.0.0.1 9305 & nc -p 40012 127.0.0.1 9305 &');
    const rows = await root('ss -tanpH sport = :9305');
    expect(rows.split('\n').filter((line) => line.includes('users:')).length).toBe(2);
  });
});
