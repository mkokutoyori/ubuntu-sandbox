/**
 * UNIX-domain sockets as ONE kernel table, measured on netcat-openbsd 1.226, iproute2 6.1.0 and net-tools 2.10 in a fresh network and pid
 * namespace (the full corpus is replayed by netcmds-oracle.test.ts, family unix-sockets.json; these cases pin what that corpus cannot name):
 *
 *   nc -lU P &                    /proc/net/unix, `ss -x` and `netstat -x` list the SAME socket, with the same inode, the process and the
 *                                 descriptor `/proc/<pid>/fd/3 -> socket:[inode]`; flags 00010000, St 01, RefCount 2, backlog 5
 *   nc -U P &                     a connected pair: the accepted end carries the listener's path, the client is unnamed, both ESTAB with
 *                                 each other's inode, RefCount 3, `sockets: used` counts them
 *   nc -kU -l P + two clients     the second connection is queued: the listener's Recv-Q is 1 and `ss -e` names the client in `peers:`;
 *                                 /proc/net/unix keeps the unaccepted half (inode 0, St 02, the listener's path)
 *   kill the listener             the sockets vanish, the socket FILE stays (`test -S`), a new connect is refused
 *   nc -luU P + nc -uU -s C P     two u_dgr sockets, the server RefCount 3 (one connected peer), the client bound to its own path
 *   nc -zU P on a datagram path   `Protocol wrong type for socket` (EPROTOTYPE), not `Connection refused`
 *   ss -xa 'src /tmp/lab/*'       the filter is an fnmatch on the bound path (it was parsed and never evaluated)
 *   TCP and UNIX inodes           one allocator: no inode is shared between a TCP socket and a UNIX socket
 *
 * Measured with the sources at HEAD: 7 of the 8 cases fall (the UNIX table did not exist: /proc/net/unix held its header only and nc refused -U -l).
 * The one that passes either way is the TCP WITNESS: it proves the lab is sound and that sharing the allocator did not disturb the TCP rows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function root(line: string): Promise<string> {
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  const text = await machine.executor.runAsUser('root', () => pc.executeCommand(line));
  return text.replace(/^\[\d+\] \d+\n?/gm, '').replace(/\n$/, '');
}

function inodesOf(proc: string): number[] {
  return proc.split('\n').slice(1).filter((line) => line !== '').map((line) => Number(line.trim().split(/\s+/)[6]));
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await root('ip link set lo up');
  await root('mkdir -p /tmp/lab; cd /tmp/lab');
});

describe('UNIX sockets are one table', () => {
  it('a listening nc -lU is the same socket in /proc/net/unix, ss, netstat and /proc/<pid>/fd', async () => {
    await root('cd /tmp/lab; nc -lU /tmp/lab/s1 & P=$!; sleep 0.3');
    const proc = await root('cat /proc/net/unix');
    const [inode] = inodesOf(proc);
    expect(proc.split('\n')[1]).toMatch(/^[0-9a-f]{16}: 00000002 00000000 00010000 0001 01 +\d+ \/tmp\/lab\/s1$/);
    expect(await root('ss -xlH')).toMatch(new RegExp(`^u_str\\s+LISTEN\\s+0\\s+5\\s+/tmp/lab/s1 ${inode}\\s+\\* 0\\s*$`));
    expect(await root('netstat -xl | tail -1')).toMatch(new RegExp(`^unix\\s+2\\s+\\[ ACC \\]\\s+STREAM\\s+LISTENING\\s+${inode}\\s+/tmp/lab/s1$`));
    expect(await root('ls -l /proc/$(pidof nc)/fd | grep socket | awk \'{print $NF}\'')).toBe(`socket:[${inode}]`);
    expect(await root('ss -xlpH | grep -o "users:.*"')).toMatch(/^users:\(\("nc",pid=\d+,fd=3\)\)$/);
  });

  it('a connected pair is listed from both ends and counted in sockstat', async () => {
    const used = async (): Promise<number> => Number((await root('grep "sockets: used" /proc/net/sockstat')).split(' ')[2]);
    const before = await used();
    await root('cd /tmp/lab; nc -lU /tmp/lab/s1 & sleep 0.3; nc -U /tmp/lab/s1 & sleep 0.3');
    const proc = await root('cat /proc/net/unix');
    expect(inodesOf(proc)).toHaveLength(3);
    expect(proc).toMatch(/00000003 00000000 00000000 0001 03 +\d+ \/tmp\/lab\/s1/);
    expect(proc).toMatch(/00000003 00000000 00000000 0001 03 +\d+$/m);
    const rows = (await root('ss -xH')).split('\n').map((line) => line.trim().split(/\s+/));
    expect(rows).toHaveLength(2);
    const [named, unnamed] = rows[0][4] === '*' ? [rows[1], rows[0]] : [rows[0], rows[1]];
    expect(named[4]).toBe('/tmp/lab/s1');
    expect(unnamed[4]).toBe('*');
    expect(named[5]).toBe(unnamed[7]);
    expect(unnamed[5]).toBe(named[7]);
    expect(await used() - before).toBe(3);
  });

  it('the second client of nc -kU -l waits in the accept queue', async () => {
    await root('cd /tmp/lab; nc -kU -l /tmp/lab/s1 > got.txt & sleep 0.3; nc -U /tmp/lab/s1 & sleep 0.3; nc -U /tmp/lab/s1 & sleep 0.3');
    const listener = (await root('ss -xlH')).trim().split(/\s+/);
    expect(listener.slice(0, 4)).toEqual(['u_str', 'LISTEN', '1', '5']);
    const detail = await root('ss -xlpeH');
    const queued = /peers: (\d+)/.exec(detail)?.[1];
    expect(queued).toBeDefined();
    expect(await root('ss -xaH | grep -cE " \\* 0 *$"')).toBe('2');
    expect(await root('cat /proc/net/unix')).toMatch(/00000003 00000000 00000000 0001 02 +0 \/tmp\/lab\/s1/);
  });

  it('killing the listener frees the sockets and leaves the socket file', async () => {
    await root('cd /tmp/lab; nc -lU /tmp/lab/s1 & P=$!; sleep 0.3; kill $P; sleep 0.3');
    expect(inodesOf(await root('cat /proc/net/unix'))).toEqual([]);
    expect(await root('test -S /tmp/lab/s1 && echo socket')).toBe('socket');
    expect(await root('nc -U /tmp/lab/s1; echo rc=$?')).toBe('nc: /tmp/lab/s1: Connection refused\nrc=1');
  });

  it('a datagram server and its bound client are two u_dgr sockets', async () => {
    await root('cd /tmp/lab; nc -luU /tmp/lab/s1 > got.txt & sleep 0.3; nc -uU -s /tmp/lab/c1 /tmp/lab/s1 & sleep 0.3');
    const proc = (await root('cat /proc/net/unix')).split('\n').slice(1);
    expect(proc.find((line) => line.endsWith('/tmp/lab/s1'))).toMatch(/00000003 00000000 00000000 0002 03 /);
    expect(proc.find((line) => line.endsWith('/tmp/lab/c1'))).toMatch(/00000002 00000000 00000000 0002 03 /);
    expect(await root('ss -xaH | awk \'{print $1,$2}\' | sort | uniq -c')).toMatch(/2 u_dgr ESTAB/);
    expect(await root('nc -zU /tmp/lab/s1; echo rc=$?')).toBe('nc: /tmp/lab/s1: Protocol wrong type for socket\nrc=1');
  });

  it('the src filter of ss is an fnmatch on the bound path', async () => {
    await root('cd /tmp/lab; nc -lU /tmp/lab/s1 & sleep 0.3; nc -U /tmp/lab/s1 & sleep 0.3');
    expect(await root('ss -xaH src "/tmp/lab/*" | wc -l')).toBe('2');
    expect(await root('ss -xaH src /nothing | wc -l')).toBe('0');
    expect(await root('ss -xaH dst "*" | wc -l')).toBe('3');
  });

  it('a stream written to the socket reaches the server', async () => {
    await root('cd /tmp/lab; nc -lU /tmp/lab/s1 > got.txt & sleep 0.3; echo hello | nc -NU /tmp/lab/s1; sleep 0.3');
    expect(await root('cat /tmp/lab/got.txt')).toBe('hello');
    expect(inodesOf(await root('cat /proc/net/unix'))).toEqual([]);
  });

  it('WITNESS: a TCP listener keeps its row and shares no inode with the UNIX sockets', async () => {
    await root('cd /tmp/lab; nc -l 127.0.0.1 9100 & nc -lU /tmp/lab/s1 & sleep 0.3');
    const unix = inodesOf(await root('cat /proc/net/unix'));
    const tcp = (await root('ss -tlnpeH')).match(/ino:(\d+)/)?.[1];
    expect(tcp).toBeDefined();
    expect(unix).not.toContain(Number(tcp));
    expect(await root('ss -tlnH sport = :9100 | wc -l')).toBe('1');
  });
});
