/**
 * Une connexion TCP n'a qu'une verite, celle de la pile de la machine. `ss`, `netstat`,
 * `/proc/net/{tcp,tcp6,udp,udp6,raw,unix,sockstat}`, `/proc/<pid>/fd` et `lsof -i` la lisent sans en
 * garder chacun une copie : memes files, memes temporisateurs, meme proprietaire, meme inode, et
 * ce que la machine imprime a chacun est ce que l'outil reel imprimerait.
 *
 * Mesure de depart (origin/mandeng 75c5280d8), deux LinuxPC cables, une connexion ouverte de A vers
 * le sshd de B dont 785 octets restent a lire chez A : `ss -tan` imprimait `Recv-Q 0` pour ces 785
 * octets et `Send-Q 0` pour toute ecoute ; `ss -tanoe` rendait la table de `ss -tan` a l'identique
 * (`-o`, `-e` et `-i` acceptes, jamais evalues) ; `ss -V`, `-K`, `-Z` et `-m` imprimaient eux aussi la
 * table ordinaire ; `exclude listening` gardait les ecoutes et la colonne State survivait a
 * `state established` ; `ss -s` rangeait l'ecoute IPv6 sous IPv4 (`TCP 4 4 0`) ; `/proc/net/tcp`
 * donnait l'uid 0 a la prise du resolveur, et `/proc/net/tcp6` comme `/proc/net/sockstat`
 * n'existaient pas ; `netstat -tan` imprimait la colonne `PID/Program name` sans `-p`, dans des
 * colonnes qui ne tombaient pas la ou net-tools les met, et `netstat -V` imprimait une table.
 *
 * Autorites : iproute2 v5.15.0 (`misc/ss.c`, `misc/ssfilter.y`) pour `ss` ; net-tools v2.10
 * (`netstat.c`) pour `netstat` ; noyau v5.15 (`get_tcp4_sock`, `get_tcp6_sock`, `tcp_get_info`,
 * `inet_sk_diag_fill`) pour les rangees de `/proc/net/*`, les files et les temporisateurs. Les
 * sources ont ete lues ; la mise en colonnes et les formats de nombres de `ss` sont en plus
 * compares au code de ss.c compile (`probe-ss-colonnes-oracle`, `probe-ss-formats`).
 *
 * Ce qui est construit : `KernelSocketRows` (la jointure de la `SocketTable` et des prises de la
 * pile : proprietaire, uid, descripteur), les rendus de `ProcNetTables`, `ss` en entier
 * (`SsArguments`, `SsFilterExpression`, `SsTable`, `SsOutput`, `SsRun`), `netstat`
 * (`NetstatArguments`, `NetstatInternet`, `NetstatRun`), `SocketCookies`, `KernelSocketDestroy`
 * (`ss -K` : l'UDP est detruit, TIME_WAIT refuse en silence, une requete SYN_RECV est abandonnee
 * sans RST), la file d'attente d'ecoute de chaque demon (sshd 128, nginx et apache 511, vsftpd 32,
 * nc 1) et le nom de commande du noyau, quinze caracteres, avec une ligne de commande qui commence
 * par argv[0].
 *
 * Ce qui n'est PAS construit : `ss -m`, qui lit les tampons de la prise (sk_rcvbuf, sk_sndbuf), est
 * refuse en le disant ; `-D`, `-E` et `-N` aussi ; ni pacing_rate, delivery_rate, busy ni rcv_rtt
 * (aucun RTT physique dans la pile, aucun pacer) ; ni les tables AF_UNIX, netlink et packet de `ss` ;
 * ni le peripherique lie d'une prise (`127.0.0.53%lo:53`) ; `netstat -g` et `-M` disent que la
 * machine ne les supporte pas, et `-c` n'imprime que le premier cliche.
 *
 * Discrimination (fichier copie sur origin/mandeng 75c5280d8) : CINQUANTE-DEUX cas sur cinquante-cinq
 * tombent. Les trois autres passent des deux cotes : un TEMOIN (la connexion du banc est ESTABLISHED
 * des deux cotes, ce qui prouve qu'il ouvre une vraie connexion que les trois vues auraient du
 * montrer), une NON-REGRESSION (`ss -ta` resolvait deja les noms de services, sauf les ports
 * ephemeres) et le cas UDP de `ss -K` : la base ignorait `-K` et imprimait la table telle quelle, ce
 * que le noyau repond aussi pour une prise liee ; ce cas ne tombe donc que contre l'etat precedent de
 * cette branche, ou l'UDP etait tenu pour non supporte alors que `udp_prot.diag_destroy` existe au
 * noyau 5.15.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { scriptedPeer, openActive } from '../../support/tcpScriptedPeer';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import type { TcpSocket } from '@/network/tcp/TcpStack';

interface Lab {
  readonly a: LinuxPC;
  readonly b: LinuxPC;
  readonly cable: Cable;
  readonly socket: TcpSocket;
  readonly clock: VirtualTimeScheduler;
}

function lab(): Lab {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  const clock = new VirtualTimeScheduler();
  const a = new LinuxPC('A');
  const b = new LinuxPC('B');
  a.powerOn();
  b.powerOn();
  a.setScheduler(clock);
  b.setScheduler(clock);
  const cable = new Cable('c1');
  cable.connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const socket = a.getTcpStack().connect('10.0.0.2', 22)!;
  return { a, b, cable, socket, clock };
}

function rowContaining(output: string, needle: string): string[] {
  const line = output.split('\n').find((candidate) => candidate.includes(needle));
  if (line === undefined) throw new Error(`no row contains ${needle} in:\n${output}`);
  return line.trim().split(/\s+/);
}

async function procRow(machine: LinuxPC, remote: string): Promise<string[]> {
  return rowContaining(await machine.executeCommand('cat /proc/net/tcp'), remote);
}

const REMOTE_SSH = '0200000A:0016';

describe('the bench is sound (witnesses)', () => {
  it('the client and the server both hold an ESTABLISHED connection after the handshake', async () => {
    const { a, b, socket } = lab();
    expect(socket.state).toBe('established');
    expect(b.getTcpStack().listSockets().filter((candidate) => candidate.state === 'established')).toHaveLength(1);
    expect(await a.executeCommand('cat /proc/net/tcp')).toContain(REMOTE_SSH);
  });
});

describe('one connection, three views: ss, netstat and /proc/net/tcp say the same thing', () => {
  it('unread bytes are Recv-Q in all three, and not zero', async () => {
    const { a } = lab();
    const ss = Number(rowContaining(await a.executeCommand('ss -tn'), '10.0.0.2:22')[1]);
    const netstat = Number(rowContaining(await a.executeCommand('netstat -tn'), '10.0.0.2:22')[1]);
    const proc = parseInt((await procRow(a, REMOTE_SSH))[4].split(':')[1], 16);
    expect(ss).toBeGreaterThan(0);
    expect(netstat).toBe(ss);
    expect(proc).toBe(ss);
  });

  it('unacknowledged data is Send-Q and an armed retransmission timer in all three', async () => {
    const { a, cable, socket } = lab();
    cable.setPacketLossRate(1);
    socket.write('x'.repeat(100));
    const ss = await a.executeCommand('ss -tno');
    const netstat = await a.executeCommand('netstat -tno');
    const proc = await procRow(a, REMOTE_SSH);
    expect(rowContaining(ss, '10.0.0.2:22')[2]).toBe('100');
    expect(rowContaining(netstat, '10.0.0.2:22')[2]).toBe('100');
    expect(parseInt(proc[4].split(':')[0], 16)).toBe(100);
    expect(ss).toMatch(/timer:\(on,\d+(\.\d+)?(ms|sec),0\)/);
    expect(netstat).toMatch(/on \(\d+\.\d{2}\/0\/0\)/);
    expect(proc[5].split(':')[0]).toBe('01');
  });

  it('the retransmission timer says how many times it already fired, in all three', async () => {
    const { a, cable, socket, clock } = lab();
    cable.setPacketLossRate(1);
    socket.write('x'.repeat(100));
    clock.advance(250);
    const ss = await a.executeCommand('ss -tno');
    const netstat = await a.executeCommand('netstat -tno');
    const proc = await procRow(a, REMOTE_SSH);
    expect(ss).toMatch(/timer:\(on,[^,]+,1\)/);
    expect(netstat).toMatch(/on \(\d+\.\d{2}\/1\/0\)/);
    expect(parseInt(proc[6], 16)).toBe(1);
  });

  it('a socket carries one inode, the one /proc/<pid>/fd links to', async () => {
    const { b } = lab();
    const ss = await b.executeCommand('sudo ss -tnpe');
    const row = rowContaining(ss, '10.0.0.2:22');
    const inode = /ino:(\d+)/.exec(row.join(' '))![1];
    const holder = /pid=(\d+),fd=(\d+)/.exec(row.join(' '))!;
    const links = await b.executeCommand(`sudo ls -l /proc/${holder[1]}/fd`);
    expect(links).toContain(`${holder[2]} -> socket:[${inode}]`);
    expect(rowContaining(await b.executeCommand('cat /proc/net/tcp'), '0200000A:0016')[9]).toBe(inode);
    const netstat = await b.executeCommand('sudo netstat -tnpe');
    expect(rowContaining(netstat, '10.0.0.2:22').join(' ')).toContain(`${holder[1]}/sshd`);
  });

  it('netstat -e prints the user and the same inode ss -e prints', async () => {
    const { b } = lab();
    const inode = /ino:(\d+)/.exec(rowContaining(await b.executeCommand('sudo ss -tne'), '10.0.0.2:22').join(' '))![1];
    const netstat = await b.executeCommand('sudo netstat -te');
    expect(netstat).toContain(' User       Inode     ');
    const cells = rowContaining(netstat, '10.0.0.1:32768');
    expect(cells.slice(-2)).toEqual(['root', inode]);
  });

  it('the owner of a socket is root for sshd and nobody else', async () => {
    const { b } = lab();
    const ss = rowContaining(await b.executeCommand('sudo ss -tnpe'), '10.0.0.1:32768').join(' ');
    expect(ss).toContain('users:(("sshd"');
    expect(ss).not.toMatch(/uid:\d/);
  });
});

describe('listeners: Recv-Q is the accept queue and Send-Q the backlog the daemon asked for', () => {
  it('sshd listens with a backlog of 128, and /proc/net/tcp keeps the kernel convention (tx_queue 0)', async () => {
    const { b } = lab();
    expect(rowContaining(await b.executeCommand('ss -ltn sport = :22'), '0.0.0.0:22').slice(1, 3)).toEqual(['0', '128']);
    expect(rowContaining(await b.executeCommand('netstat -ltn'), '0.0.0.0:22').slice(1, 3)).toEqual(['0', '0']);
    const proc = rowContaining(await b.executeCommand('cat /proc/net/tcp'), '00000000:0016');
    expect(proc[4]).toBe('00000000:00000000');
  });

  it('a listener asks for what its program asked for: nc 1, nginx 511, and the stub resolver the kernel ceiling', async () => {
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    Logger.reset();
    const server = new LinuxServer('linux-server', 'S');
    server.powerOn();
    await server.executeCommand('sudo nc -l 9000');
    await server.executeCommand('sudo systemctl start nginx');
    const ss = await server.executeCommand('ss -ltn');
    expect(rowContaining(ss, '0.0.0.0:9000')[2]).toBe('1');
    expect(rowContaining(ss, '0.0.0.0:80')[2]).toBe('511');
    expect(rowContaining(ss, '127.0.0.53:53')[2]).toBe('4096');
  });

  it('a socket opened under sudo belongs to root, not to the shell that ran sudo', async () => {
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    Logger.reset();
    const pc = new LinuxPC('P');
    pc.powerOn();
    await pc.executeCommand('sudo nc -l 9000');
    await pc.executeCommand('nc -l 9001');
    const ss = await pc.executeCommand('sudo ss -ltne');
    expect(rowContaining(ss, '0.0.0.0:9000').join(' ')).not.toMatch(/uid:\d/);
    expect(rowContaining(ss, '0.0.0.0:9001').join(' ')).toMatch(/uid:1000/);
    const proc = await pc.executeCommand('cat /proc/net/tcp');
    expect(rowContaining(proc, '00000000:2328')[7]).toBe('0');
    expect(rowContaining(proc, '00000000:2329')[7]).toBe('1000');
  });
});

describe('every state has its row, its queues and its timer', () => {
  it('TIME_WAIT: no queue, the timewait timer, inode 0, and the three views agree on it', async () => {
    const { a, socket } = lab();
    socket.close();
    const ss = await a.executeCommand('ss -tno state time-wait');
    const netstat = await a.executeCommand('netstat -tno');
    const proc = await procRow(a, REMOTE_SSH);
    expect(ss).toMatch(/timer:\(timewait,\d+(\.\d+)?(sec|min|ms)[^,]*,0\)/);
    expect(rowContaining(netstat, '10.0.0.2:22').slice(5)).toEqual(['TIME_WAIT', 'timewait', expect.stringMatching(/^\(\d+\.\d{2}\/0\/0\)$/)]);
    expect(proc[3]).toBe('06');
    expect(proc[5].split(':')[0]).toBe('03');
    expect(proc[9]).toBe('0');
  });

  it('TIME_WAIT is hidden from the default ss listing and shown by -a', async () => {
    const { a, socket } = lab();
    socket.close();
    expect(await a.executeCommand('ss -tn')).not.toContain('10.0.0.2:22');
    expect(await a.executeCommand('ss -tna')).toContain('TIME-WAIT');
  });

  it('SYN_RECV: ss, netstat and /proc/net/tcp show the half-open connection of a listener', async () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
    peer.send({ flags: 'S', sequence: 1000, options: [{ kind: 'mss', value: 1460 }] });
    const ss = await peer.dut.executeCommand('ss -tn state syn-recv');
    const netstat = await peer.dut.executeCommand('netstat -tn');
    const proc = await peer.dut.executeCommand('cat /proc/net/tcp');
    expect(ss).toContain('10.0.0.2:40000');
    expect(netstat).toMatch(/SYN_RECV/);
    expect(proc).toMatch(/ 03 00000000:00000000 01:/);
    expect(await peer.dut.executeCommand('ss -tno state syn-recv')).toMatch(/timer:\(on,\d+(\.\d+)?sec,0\)/);
  });
});

describe('the other states of the machine, each one named the way net-tools and the kernel name it', () => {
  it('SYN_SENT: the SYN counts in Send-Q, the timer is armed, and the three views agree', async () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    const ss = await peer.dut.executeCommand('ss -tno state syn-sent');
    const netstat = await peer.dut.executeCommand('netstat -tno');
    const proc = rowContaining(await peer.dut.executeCommand('cat /proc/net/tcp'), '0200000A:9C40');
    expect(rowContaining(ss, '10.0.0.2:40000')[1]).toBe('1');
    expect(ss).toMatch(/timer:\(on,[^,]+,0\)/);
    expect(rowContaining(netstat, '10.0.0.2:40000').slice(1, 6)).toEqual(['0', '1', '10.0.0.1:32768', '10.0.0.2:40000', 'SYN_SENT']);
    expect(proc[3]).toBe('02');
    expect(parseInt(proc[4].split(':')[0], 16)).toBe(1);
  });

  it('CLOSE_WAIT: the peer FIN is unread data, one byte of Recv-Q until the application sees the end', async () => {
    const peer = scriptedPeer();
    const { dutIsn, peerIsn } = openActive(peer, [], undefined, undefined, { allowHalfOpen: true });
    peer.send({ flags: 'FA', sequence: peerIsn + 1, acknowledgement: dutIsn + 1 });
    const ss = await peer.dut.executeCommand('ss -tn state close-wait');
    const netstat = await peer.dut.executeCommand('netstat -tn');
    const proc = rowContaining(await peer.dut.executeCommand('cat /proc/net/tcp'), '0200000A:9C40');
    expect(rowContaining(ss, '10.0.0.2:40000')[0]).toBe('1');
    expect(rowContaining(netstat, '10.0.0.2:40000').slice(1, 3)).toEqual(['1', '0']);
    expect(rowContaining(netstat, '10.0.0.2:40000')[5]).toBe('CLOSE_WAIT');
    expect(proc[3]).toBe('08');
    expect(parseInt(proc[4].split(':')[1], 16)).toBe(1);
  });

  it('FIN_WAIT_2 and TIME_WAIT: our FIN acknowledged, then the peer FIN, with the names net-tools gives them', async () => {
    const peer = scriptedPeer();
    const { socket, dutIsn, peerIsn } = openActive(peer);
    socket.close();
    peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: dutIsn + 2 });
    expect(rowContaining(await peer.dut.executeCommand('netstat -tn'), '10.0.0.2:40000')[5]).toBe('FIN_WAIT2');
    expect(rowContaining(await peer.dut.executeCommand('cat /proc/net/tcp'), '0200000A:9C40')[3]).toBe('05');
    expect(await peer.dut.executeCommand('ss -tn state fin-wait-2')).toContain('10.0.0.2:40000');
    peer.send({ flags: 'FA', sequence: peerIsn + 1, acknowledgement: dutIsn + 2 });
    expect(rowContaining(await peer.dut.executeCommand('netstat -tn'), '10.0.0.2:40000')[5]).toBe('TIME_WAIT');
  });
});

describe('who owns a socket, as an operator sees it', () => {
  it('an unprivileged ss -p does not show the processes it cannot inspect', async () => {
    const { b } = lab();
    expect(await b.executeCommand('ss -tnp')).not.toContain('users:');
    expect(await b.executeCommand('sudo ss -tnp')).toContain('users:(("sshd"');
  });

  it('an unprivileged netstat -p says it cannot identify them, before the table, as net-tools does', async () => {
    const { b } = lab();
    const output = await b.executeCommand('netstat -tnp');
    expect(output.startsWith('(No info could be read for "-p": geteuid()=1000 but you should be root.)')).toBe(true);
    expect(rowContaining(output, '10.0.0.1:32768').slice(-1)).toEqual(['-']);
  });

  it('a process name is what the kernel keeps, fifteen characters', async () => {
    const { b } = lab();
    expect(await b.executeCommand('sudo ss -tlnp')).toContain('"systemd-resolve"');
    expect(await b.executeCommand('sudo cat /proc/29/comm')).toBe('systemd-resolve');
    expect(await b.executeCommand('sudo netstat -tlnp')).toContain('29/systemd-resolved ');
  });

  it('/proc/<pid>/cmdline starts with argv[0], which is what netstat -p reads', async () => {
    const { b } = lab();
    expect(await b.executeCommand("sudo cat /proc/22/cmdline | tr '\\0' ' '")).toMatch(/^\/usr\/sbin\/sshd /);
  });
});

describe('ss selects like iproute2: states, expressions, files, families', () => {
  it('state established keeps the connection and drops the listeners, and the State column disappears', async () => {
    const { a } = lab();
    const out = await a.executeCommand('ss -tn state established');
    expect(out).toContain('10.0.0.2:22');
    expect(out).not.toContain('LISTEN');
    expect(out.split('\n')[0]).not.toContain('State');
  });

  it('exclude removes a state from the default selection', async () => {
    const { a } = lab();
    const out = await a.executeCommand('ss -tan exclude listening');
    expect(out).toContain('10.0.0.2:22');
    expect(out).not.toContain('LISTEN');
  });

  it('an expression combines ports and prefixes, with parentheses, and or / and / not', async () => {
    const { a } = lab();
    expect(await a.executeCommand('ss -tna "( sport = :22 or dport = :22 )"')).toMatch(/10\.0\.0\.2:22[\s\S]*0\.0\.0\.0:22|0\.0\.0\.0:22[\s\S]*10\.0\.0\.2:22/);
    expect(await a.executeCommand('ss -tn dst 10.0.0.0/24 and dport = :22')).toContain('10.0.0.2:22');
    expect(await a.executeCommand('ss -tn dst 10.0.0.0/24 and dport = :23')).not.toContain('10.0.0.2');
    expect(await a.executeCommand('ss -tna not dport = :22 and sport = :22')).toContain('0.0.0.0:22');
    expect(await a.executeCommand('ss -tna dport ge :1 sport gt :1024')).toContain('10.0.0.1:32768');
  });

  it('a filter file replaces the command line, comment lines are skipped', async () => {
    const { a } = lab();
    await a.executeCommand("printf '# a comment\\nsport = :32768\\n' > /tmp/filter.txt");
    const out = await a.executeCommand('ss -tna -F /tmp/filter.txt');
    expect(out).toContain('10.0.0.1:32768');
    expect(out).not.toContain('0.0.0.0:22');
  });

  it('-A and -f choose tables and families, and an empty selection says so in iproute2 words', async () => {
    const { a } = lab();
    expect(await a.executeCommand('ss -A tcp -an')).toContain('10.0.0.2:22');
    expect(await a.executeCommand('ss -f inet6 -ta')).toContain('[::]:ssh');
    expect(await a.executeCommand('ss -f inet6 -ta')).not.toContain('10.0.0.2');
    expect(await a.executeCommand('ss -A bogus')).toContain('ss: "bogus" is illegal socket table id');
    expect(await a.executeCommand('ss -f bogus')).toContain('ss: "bogus" is invalid family');
  });

  it('exit codes and words of iproute2: unknown state 255, port that is not one 1, version 0', async () => {
    const { a } = lab();
    expect(await a.executeCommand('ss -tn state bogus; echo rc=$?')).toBe('ss: wrong state name: bogus\nrc=255');
    expect(await a.executeCommand('ss -tn dport = :nosuch; echo rc=$?')).toContain('rc=1');
    expect(await a.executeCommand('ss -V; echo rc=$?')).toBe('ss utility, iproute2-5.15.0\nrc=0');
    expect(await a.executeCommand('ss --nonsense >/dev/null 2>&1; echo rc=$?')).toBe('rc=255');
  });

  it('a name in a filter is resolved through /etc/services, and an ambiguous or unknown one is refused', async () => {
    const { a } = lab();
    expect(await a.executeCommand('ss -tn dport = :ssh')).toContain('10.0.0.2');
    expect(await a.executeCommand('ss -tn dport = :zorglub')).toContain('does not look like a port');
  });
});

describe('ss lays its columns out the way iproute2 does', () => {
  it('on a terminal the table is stretched to its width, and stty cols changes it', async () => {
    const { a } = lab();
    const narrow = (await a.executeCommand('ss -tn')).split('\n');
    expect(narrow.every((line) => line.length === 80)).toBe(true);
    await a.executeCommand('stty cols 132');
    const wide = (await a.executeCommand('ss -tn')).split('\n');
    expect(wide.every((line) => line.length === 132)).toBe(true);
  });

  it('into a pipe the table is compact, and the header runs Peer Address:Port into Process, as it does', async () => {
    const { a } = lab();
    const lines = (await a.executeCommand('ss -tn | cat')).split('\n');
    expect(lines[0]).toBe('State Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess');
    expect(lines[1]).toMatch(/^ESTAB \d+\s+0\s+10\.0\.0\.1:32768\s+10\.0\.0\.2:22\s*$/);
  });

  it('-H drops the header, -O keeps each socket on one line, and a single table or state drops its column', async () => {
    const { a } = lab();
    expect((await a.executeCommand('ss -tnH')).split('\n')[0]).toMatch(/^ESTAB/);
    expect((await a.executeCommand('ss -tn state established')).split('\n')[0]).not.toContain('State');
    expect((await a.executeCommand('ss -n')).split('\n')[0]).toContain('Netid');
    expect((await a.executeCommand('ss -tni')).split('\n')).toHaveLength(3);
    expect((await a.executeCommand('ss -tniO')).split('\n')).toHaveLength(2);
  });

  it('service names are shown unless -n, except for ephemeral ports', async () => {
    const { a } = lab();
    const named = await a.executeCommand('ss -tn dport = :22');
    expect(named).toContain('10.0.0.2:22');
    const resolved = await a.executeCommand('ss -ta');
    expect(resolved).toContain('10.0.0.2:ssh');
    expect(resolved).toContain('10.0.0.1:32768');
  });
});

describe('ss -i prints tcp_info the way the kernel quantizes it', () => {
  it('rto is a whole number of jiffies, rtt microseconds, last* whole milliseconds', async () => {
    const { a, cable, socket } = lab();
    cable.setPacketLossRate(1);
    socket.write('x'.repeat(10));
    const info = await a.executeCommand('sudo ss -tni');
    expect(Number(/rto:([\d.]+)/.exec(info)![1]) % 4).toBe(0);
    for (const field of ['rtt', 'ato', 'minrtt']) {
      const match = new RegExp(`${field}:(\\d+(?:\\.\\d+)?)`).exec(info);
      if (match !== null) expect(match[1]).toMatch(/^\d+(\.\d{1,3})?$/);
    }
    for (const field of ['lastsnd', 'lastrcv', 'lastack']) {
      const match = new RegExp(`${field}:(\\S+)`).exec(info);
      if (match !== null) expect(match[1]).toMatch(/^\d+$/);
    }
  });

  it('the option flags need -o or -e, the congestion algorithm and window scale come with -i', async () => {
    const { a } = lab();
    const plain = (await a.executeCommand('sudo ss -tni')).split('\n')[2];
    const flagged = (await a.executeCommand('sudo ss -tnie')).split('\n')[2];
    expect(plain).not.toMatch(/^\s+ts /);
    expect(plain).toMatch(/^\t reno wscale:7,7 /);
    expect(flagged).toMatch(/^\t ts sack reno /);
  });

  it('a listener reports its congestion algorithm and its initial window, and TIME_WAIT an empty line', async () => {
    const { a, socket } = lab();
    expect((await a.executeCommand('sudo ss -tlni')).split('\n')[2]).toMatch(/^\t reno cwnd:10\s*$/);
    socket.close();
    const lines = (await a.executeCommand('sudo ss -tni state time-wait')).split('\n');
    expect(lines[2]).toMatch(/^\t\s*$/);
  });

  it('-e names the socket: inode, cookie, cgroup and the shutdown flags', async () => {
    const { b } = lab();
    const row = rowContaining(await b.executeCommand('sudo ss -tne'), '10.0.0.1:32768').join(' ');
    expect(row).toMatch(/ino:\d+ sk:[0-9a-f]+ cgroup:\/system\.slice\/ssh\.service <->$/);
  });
});

describe('ss -s and the counters it reads', () => {
  it('Total and the TCP line agree with /proc/net/sockstat and /proc/net/snmp', async () => {
    const { a } = lab();
    const summary = await a.executeCommand('ss -s');
    const sockstat = await a.executeCommand('cat /proc/net/sockstat');
    const snmp = await a.executeCommand('cat /proc/net/snmp');
    expect(summary).toContain(`Total: ${/sockets: used (\d+)/.exec(sockstat)![1]}`);
    const header = snmp.split('\n').find((line) => line.startsWith('Tcp:'))!.split(' ');
    const values = snmp.split('\n').filter((line) => line.startsWith('Tcp:'))[1].split(' ');
    expect(summary).toContain(`estab ${values[header.indexOf('CurrEstab')]},`);
    expect(summary).toMatch(/Transport Total {5}IP {8}IPv6\nRAW\t {2}\d+ +\d+ +\d+ +\nUDP\t/);
  });
});

describe('ss -K destroys a connection the way SOCK_DESTROY does', () => {
  it('as root it resets the connection, and the peer loses it too', async () => {
    const { a, b } = lab();
    expect(await b.executeCommand('sudo ss -tn state established')).toContain('10.0.0.1:32768');
    const output = await a.executeCommand('sudo ss -K dport = :22');
    expect(output).toContain('10.0.0.2:ssh');
    expect(await a.executeCommand('ss -tn state established')).not.toContain('10.0.0.2');
    expect(await b.executeCommand('sudo ss -tn state established')).not.toContain('10.0.0.1');
  });

  it('as a user it is refused, and the connection stays', async () => {
    const { a } = lab();
    const output = await a.executeCommand('ss -K dport = :22');
    expect(output).toContain('SOCK_DESTROY answers: Operation not permitted');
    expect(await a.executeCommand('ss -tn state established')).toContain('10.0.0.2:22');
  });

  it('the refusal is printed twice for each table that has a selected socket, as iproute2 retries with AF_UNSPEC', async () => {
    const { a } = lab();
    const denied = (text: string): number => (text.match(/SOCK_DESTROY answers: Operation not permitted/g) ?? []).length;
    expect(denied(await a.executeCommand('ss -K dport = :22'))).toBe(2);
    expect(denied(await a.executeCommand('ss -K -ta -ua'))).toBe(4);
    expect(denied(await a.executeCommand('ss -K -ta dport = :9'))).toBe(0);
  });

  it('a UDP socket is destroyable: the kernel answers success, the row is shown, a bound socket stays', async () => {
    const { a } = lab();
    const before = await a.executeCommand('ss -uan');
    expect(before).toContain('127.0.0.53:53');
    expect(await a.executeCommand('sudo ss -K -uan')).toBe(before);
    expect(await a.executeCommand('ss -uan')).toBe(before);
  });

  it('a TIME_WAIT socket is the one the kernel refuses with EOPNOTSUPP, so it is skipped without a word', async () => {
    const { a, socket } = lab();
    socket.close();
    expect(await a.executeCommand('ss -tan state time-wait')).toContain('10.0.0.2:22');
    const output = await a.executeCommand('sudo ss -K -tan state time-wait');
    expect(output).not.toContain('10.0.0.2');
    expect(await a.executeCommand('ss -tan state time-wait')).toContain('10.0.0.2:22');
  });

  it('a half-open connection is a request socket: it is dropped without a reset, while an established one is reset', async () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
    peer.send({ flags: 'S', sequence: 1000, options: [{ kind: 'mss', value: 1460 }] });
    expect(await peer.dut.executeCommand('ss -tn state syn-recv')).toContain('10.0.0.2:40000');
    peer.clear();
    expect(await peer.dut.executeCommand('sudo ss -K -tn state syn-recv')).toContain('10.0.0.2:40000');
    expect(peer.take().filter((segment) => segment.flags.rst)).toEqual([]);
    expect(await peer.dut.executeCommand('ss -tn state syn-recv')).not.toContain('10.0.0.2:40000');

    const other = scriptedPeer();
    openActive(other);
    other.clear();
    await other.dut.executeCommand('sudo ss -K -tn state established');
    expect(other.take().filter((segment) => segment.flags.rst)).toHaveLength(1);
  });

  it('a listener is destroyed too: the port stops answering and leaves the table', async () => {
    const { a, b } = lab();
    expect(await b.executeCommand('sudo ss -tln sport = :22')).toContain('0.0.0.0:22');
    expect(await b.executeCommand('sudo ss -K -tln sport = :22')).toContain('0.0.0.0:22');
    expect(await b.executeCommand('sudo ss -tln sport = :22')).not.toContain('0.0.0.0:22');
    expect(a.getTcpStack().connect('10.0.0.2', 22)?.state).not.toBe('established');
  });
});

describe('netstat prints what net-tools prints', () => {
  it('the header, the row widths and the state names of net-tools', async () => {
    const { a } = lab();
    const lines = (await a.executeCommand('netstat -tn')).split('\n');
    expect(lines[0]).toBe('Active Internet connections (w/o servers)');
    expect(lines[1]).toBe('Proto Recv-Q Send-Q Local Address           Foreign Address         State      ');
    expect(lines[2]).toMatch(/^tcp {2,}\d+ {6}0 10\.0\.0\.1:32768 {10}10\.0\.0\.2:22 {13}ESTABLISHED$/);
    expect(lines[2]).toMatch(/^tcp {2}\s*\d+ {1,6}0 /);
  });

  it('the default listing ends with the UNIX sockets section', async () => {
    const { a } = lab();
    const out = await a.executeCommand('netstat');
    expect(out).toContain('Active UNIX domain sockets (w/o servers)\nProto RefCnt Flags       Type       State         I-Node   Path');
    expect((await a.executeCommand('netstat -t')).includes('UNIX')).toBe(false);
  });

  it('addresses are 0.0.0.0 for IPv4 and [::] for IPv6, numeric -n gives ::', async () => {
    const { b } = lab();
    const named = await b.executeCommand('netstat -tl');
    expect(named).toMatch(/tcp6 +0 +0 \[::\]:ssh +\[::\]:\* +LISTEN/);
    expect(named).toMatch(/tcp +0 +0 0\.0\.0\.0:ssh +0\.0\.0\.0:\* +LISTEN/);
    expect(await b.executeCommand('netstat -tln')).toMatch(/tcp6 +0 +0 :::22 +:::\* +LISTEN/);
  });

  it('-W does not truncate, and without it an address and a port are cut to 22 characters', async () => {
    const { a } = lab();
    await a.executeCommand("echo '10.0.0.2 a-name-that-is-much-too-long-for-the-column.example' | sudo tee -a /etc/hosts");
    const cut = rowContaining(await a.executeCommand('netstat -t'), 'a-name-that').join(' ');
    expect(cut).toContain('a-name-that-is-much:ssh');
    const wide = rowContaining(await a.executeCommand('netstat -tW'), 'a-name-that').join(' ');
    expect(wide).toContain('a-name-that-is-much-too-long-for-the-column.example:ssh');
  });

  it('-o prints off for a quiet socket and the timer name otherwise', async () => {
    const { a } = lab();
    expect(await a.executeCommand('netstat -to')).toMatch(/ESTABLISHED off \(0\.00\/0\/0\)/);
  });

  it('usage goes to stderr with the exit code of net-tools, and -V says which version', async () => {
    const { a } = lab();
    expect(await a.executeCommand('netstat -z 2>&1 | head -1')).toBe("netstat: invalid option -- 'z'");
    expect(await a.executeCommand('netstat -z >/dev/null 2>&1; echo rc=$?')).toBe('rc=3');
    expect(await a.executeCommand('netstat -V | head -1')).toBe('net-tools 2.10-alpha');
    expect(await a.executeCommand('netstat -h 2>&1 >/dev/null | head -1')).toContain('usage: netstat [-vWeenNcCF] [<Af>] -r');
  });

  it('options the machine cannot honour say so in the words of net-tools', async () => {
    const { a } = lab();
    expect(await a.executeCommand('netstat -S')).toContain("netstat: no support for `AF INET (sctp)' on this system.");
    expect(await a.executeCommand('netstat -M')).toContain("netstat: no support for `ip_masquerade' on this system.");
  });
});

describe('/proc/net/tcp is kernel text, and what the machine prints in it is what the stack holds', () => {
  it('tcp4 rows are padded to 149 columns, tcp6 words are little-endian, the header is the kernel one', async () => {
    const { a } = lab();
    const lines = (await a.executeCommand('cat /proc/net/tcp')).split('\n');
    expect(lines[0]).toBe(`${'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'.padEnd(149)}`);
    expect(lines[1].length).toBe(149);
    expect(lines[1]).toMatch(/^ {3}0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000 +0 +0 \d+ 1 0000000000000000 100 0 0 10 0 *$/);
    const v6 = (await a.executeCommand('cat /proc/net/tcp6')).split('\n');
    expect(v6[0]).toBe('  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode');
    expect(v6[1]).toMatch(/^ {3}0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A /);
  });

  it('a connection row carries the congestion window, the slow-start threshold and the rto in clock ticks', async () => {
    const { a, cable, socket, clock } = lab();
    cable.setPacketLossRate(1);
    socket.write('x'.repeat(100));
    clock.advance(250);
    const row = await procRow(a, REMOTE_SSH);
    expect(row.slice(10)).toEqual(['1', '0000000000000000', expect.stringMatching(/^\d+$/), '20', '0', '1', '2']);
  });

  it('udp rows show unconnected sockets with state 07 and the kernel width', async () => {
    const { a } = lab();
    const lines = (await a.executeCommand('cat /proc/net/udp')).split('\n').filter(Boolean);
    expect(lines[0]).toBe('   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops'.padEnd(127));
    expect(lines.slice(1).every((line) => line.length === 127 && / 07 00000000:00000000 00:00000000 /.test(line))).toBe(true);
  });

  it('sockstat counts what the table holds', async () => {
    const { a, socket } = lab();
    const before = await a.executeCommand('cat /proc/net/sockstat');
    socket.close();
    const after = await a.executeCommand('cat /proc/net/sockstat');
    expect(before).toMatch(/TCP: inuse 3 orphan 0 tw 0 alloc 4 mem \d+/);
    expect(after).toMatch(/tw 1 /);
  });
});

describe('the three views follow the machine when the table changes under them', () => {
  beforeEach(() => {
    resetCounters();
  });

  it('stopping sshd empties the listener in all three, and starting it brings it back with its backlog', async () => {
    const { b } = lab();
    await b.executeCommand('sudo systemctl stop ssh');
    expect(await b.executeCommand('ss -ltn')).not.toContain(':22');
    expect(await b.executeCommand('netstat -ltn')).not.toContain(':22');
    expect(await b.executeCommand('cat /proc/net/tcp')).not.toContain('00000000:0016');
    await b.executeCommand('sudo systemctl start ssh');
    expect(rowContaining(await b.executeCommand('ss -ltn sport = :22'), '0.0.0.0:22')[2]).toBe('128');
  });
});
