/**
 * Une socket TCP liee qui n'ecoute pas existe dans la pile : elle tient son port, refuse les connexions qui lui arrivent
 * comme le fait un port ferme, n'est pas un port ephemere pour les connexions de la machine, meurt avec son processus et
 * devient une ecoute quand elle ecoute ; `netstat -q` la liste sous l'etat BOUND et `Get-NetTCPConnection -State Bound`
 * aussi ; `ss`, `netstat` de Linux et `/proc/net/tcp` ne la voient pas, comme le noyau Linux.
 *
 * Mesure de depart (fa7d49a31) : la pile n'offrait que `listen` et `connect`, aucun moyen de tenir un port sans ecouter
 * ; `netstat -q` imprimait le meme tableau que `netstat` et `Get-NetTCPConnection -State Bound` acceptait un etat que
 * rien ne pouvait produire.
 *
 * Autorites : Microsoft Learn (`netstat -q`) : toutes les connexions, les ports en ecoute et les ports TCP lies qui
 * n'ecoutent pas, associes ou non a une connexion active. Pour Linux, le noyau 5.15 lu depuis GitHub :
 * `net/ipv4/tcp_ipv4.c` (l'iterateur de `/proc/net/tcp` parcourt la table d'ecoute `lhash2` puis la table des connexions
 * `ehash`) et `net/ipv4/inet_diag.c` (`inet_diag_dump_icsk`, d'ou vient `ss`, parcourt les memes deux tables) ne
 * visitent jamais la table de liaison que `inet_csk_get_port` alimente quand `bind` n'est pas suivi de `listen` ou de
 * `connect`. Non confirme : que `AppliedSetting` d'une ligne BOUND soit vide comme celui d'une ecoute.
 *
 * Ce qui est construit : `TcpStack.bind` / `startListening` (le meme registre que `listen`, un ecouteur sans
 * gestionnaire d'acceptation ; `findListener` l'ignore, donc le SYN recoit un RST, et `listListeners`, que lisent les
 * panneaux et les signaux de l'hote, ne le compte pas ; l'evenement `tcp.listener.changed` n'est publie qu'a l'ecoute),
 * `SocketState` BOUND avec `ListenerSocketSink.promote`, `SocketTable.setListenerState`, le faucheur de prises qui ferme
 * aussi la liaison, `ProtocolSocketState` (les etats de la machine d'etats du protocole, sans BOUND) que partagent la
 * projection TCP et `kernelSocketRows` qui saute les liaisons. Ce qui n'est PAS construit : aucune application de la
 * simulation n'ouvre aujourd'hui de socket dans cet etat ; la brique est dans la pile, `bind` en est l'entree.
 *
 * Discrimination (fichier copie sur fa7d49a31) : VINGT-DEUX cas sur vingt-quatre tombent. Les deux autres passent des
 * deux cotes : le temoin (un port en ecoute accepte, un port ferme refuse) et le temoin des evenements (un `listen`
 * ordinaire annonce l'ecoute puis son retrait). Mutations, toutes tuees (23) : liaison qui accepte 11, `findListener`
 * qui ignore l'etat 1 et qui s'arrete a la liaison 1, `listListeners` non filtre 1, liaison annoncee comme une ecoute 2,
 * fermeture qui annonce toujours le retrait 1, `startListening` non idempotent 1, sans promotion 2, sans annonce 2,
 * ligne posee en LISTEN 7, rejeu pour un puits attache apres coup 1, puits qui ignore l'etat lie 7, promotion sans effet
 * 2, faucheur qui laisse la liaison 1, promotion qui ignore le protocole 1, l'adresse 1 ou le port 2, lignes du noyau
 * Linux qui gardent la liaison 1, `netstat` qui montre BOUND sans `-q` 3 ou jamais 5, modele PowerShell : liaison avec
 * un gabarit 1, adresse distante non resolue 1, gabarit constant 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Bench {
  readonly linux: LinuxPC;
  readonly win: WindowsPC;
  reach(port: number): Promise<'open' | 'refused'>;
}

async function bench(): Promise<Bench> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const win = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  win.powerOn();
  win.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, win.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await win.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  const reach: Bench['reach'] = async (port) => {
    let opened = false;
    const socket = linux.getTcpStack().connect('10.0.0.7', port, { onOpen: () => { opened = true; } })!;
    await settle();
    if (opened) socket.close();
    return opened ? 'open' : 'refused';
  };
  return { linux, win, reach };
}

const dataRows = (output: string) => output.split('\n').filter((line) => /^\s*(TCP|UDP)\s/.test(line));

const cellsOf = (row: string) => row.trim().split(/\s+/);

const rowFor = (output: string, pattern: RegExp) => dataRows(output).find((row) => pattern.test(row)) ?? '<absent>';

const listenerEvents = (win: WindowsPC, port: number): boolean[] => {
  const seen: boolean[] = [];
  win.getBus().subscribe('tcp.listener.changed', (event) => {
    if (event.payload.localPort === port) seen.push(event.payload.added);
  });
  return seen;
};

const powershell = async (win: WindowsPC, line: string) => (await PowerShellSubShell.create(win).subShell.processLine(line)).output.join('\n');

describe('the bench is sound (witness)', () => {
  it('a listening socket accepts and a closed port refuses', async () => {
    const { win, reach } = await bench();
    win.getTcpStack().listen(9000, { onAccept: () => undefined });
    expect(await reach(9000)).toBe('open');
    expect(await reach(9001)).toBe('refused');
  });
});

describe('a socket that is bound and does not listen', () => {
  it('holds its port: nobody else can listen on it', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    expect(() => win.getTcpStack().listen(9000, { onAccept: () => undefined })).toThrow(/EADDRINUSE/);
  });

  it('refuses the connections that come to it, as a closed port does', async () => {
    const { win, reach } = await bench();
    win.getTcpStack().bind(9000);
    expect(await reach(9000)).toBe('refused');
  });

  it('accepts them once it listens', async () => {
    const { win, reach } = await bench();
    const bound = win.getTcpStack().bind(9000);
    win.getTcpStack().startListening(bound, () => undefined);
    expect(await reach(9000)).toBe('open');
  });

  it('gives its port back when it is closed', async () => {
    const { win, reach } = await bench();
    win.getTcpStack().bind(9000);
    win.getTcpStack().closeListener(9000);
    win.getTcpStack().listen(9000, { onAccept: () => undefined });
    expect(await reach(9000)).toBe('open');
  });

  it('does not hide the wildcard listener of the same port from the connections to its address', async () => {
    const { win, reach } = await bench();
    win.getTcpStack().bind(9000, undefined, '10.0.0.7');
    win.getTcpStack().listen(9000, { onAccept: () => undefined });
    expect(await reach(9000)).toBe('open');
  });

  it('is not one of the listeners of the host, in the stack or in what the panels read', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    win.getTcpStack().listen(9001, { onAccept: () => undefined });
    expect(win.getTcpStack().listListeners().map((listener) => listener.localPort)).toContain(9001);
    expect(win.getTcpStack().listListeners().map((listener) => listener.localPort)).not.toContain(9000);
    expect(win.observables.tcpListeners.get().map((listener) => listener.port)).toContain(9001);
    expect(win.observables.tcpListeners.get().map((listener) => listener.port)).not.toContain(9000);
  });

  it('is one of them as soon as it listens', async () => {
    const { win } = await bench();
    const bound = win.getTcpStack().bind(9000);
    win.getTcpStack().startListening(bound, () => undefined);
    expect(win.getTcpStack().listListeners().map((listener) => listener.localPort)).toContain(9000);
    expect(win.observables.tcpListeners.get().map((listener) => listener.port)).toContain(9000);
  });

  it('tells a sink attached later which of the registered listeners only hold their port', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    win.getTcpStack().listen(9001, { onAccept: () => undefined });
    const told: Array<[number, boolean | undefined]> = [];
    win.getTcpStack().attachSocketSink({
      announce: (_address, port, _identity, _device, bound) => { told.push([port, bound]); },
      promote: () => undefined,
      withdraw: () => undefined,
    });
    expect(told).toContainEqual([9000, true]);
    expect(told).toContainEqual([9001, false]);
  });

  it('is not an ephemeral port for the connections the machine opens', async () => {
    const { win } = await bench();
    win.getTcpStack().setEphemeralRange(50000, 50000);
    win.getTcpStack().bind(50000);
    expect(win.getTcpStack().connect('10.0.0.3', 22, {})).toBeNull();
  });
});

describe('the stack announces a listener when it listens, not when it binds', () => {
  it('witness: a plain listen announces the listener and its close announces the removal', async () => {
    const { win } = await bench();
    const seen = listenerEvents(win, 9001);
    win.getTcpStack().listen(9001, { onAccept: () => undefined });
    win.getTcpStack().closeListener(9001);
    expect(seen).toEqual([true, false]);
  });

  it('a bind announces nothing, the first startListening announces the listener, the second announces nothing more', async () => {
    const { win } = await bench();
    const seen = listenerEvents(win, 9000);
    const bound = win.getTcpStack().bind(9000);
    expect(seen).toEqual([]);
    win.getTcpStack().startListening(bound, () => undefined);
    win.getTcpStack().startListening(bound, () => undefined);
    expect(seen).toEqual([true]);
    win.getTcpStack().closeListener(9000);
    expect(seen).toEqual([true, false]);
  });

  it('closing a bound socket that never listened announces no removal', async () => {
    const { win } = await bench();
    const seen = listenerEvents(win, 9000);
    win.getTcpStack().bind(9000);
    win.getTcpStack().closeListener(9000);
    expect(seen).toEqual([]);
  });
});

describe('netstat -q lists the bound sockets', () => {
  it('without -q the bound socket is not listed, with -q it is, in the state BOUND', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    expect(rowFor(await win.executeCommand('netstat -an'), /:9000\s/)).toBe('<absent>');
    expect(cellsOf(rowFor(await win.executeCommand('netstat -anq'), /:9000\s/))).toEqual(['TCP', '0.0.0.0:9000', '0.0.0.0:0', 'BOUND']);
  });

  it('-q lists everything -a lists, and the bound sockets besides', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    const all = dataRows(await win.executeCommand('netstat -an'));
    const bound = dataRows(await win.executeCommand('netstat -anq'));
    expect(bound.length).toBe(all.length + 1);
    expect(all.every((row) => bound.includes(row))).toBe(true);
  });

  it('a bound socket without a listener is not LISTENING anywhere', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    expect(rowFor(await win.executeCommand('netstat -anq'), /:9000\s/)).not.toContain('LISTENING');
    expect(rowFor(await win.executeCommand('netstat -an'), /:9000\s/)).toBe('<absent>');
  });

  it('the bound socket becomes a listener row when it listens, with or without -q', async () => {
    const { win } = await bench();
    const bound = win.getTcpStack().bind(9000);
    win.getTcpStack().startListening(bound, () => undefined);
    expect(cellsOf(rowFor(await win.executeCommand('netstat -an'), /:9000\s/))[3]).toBe('LISTENING');
    expect(cellsOf(rowFor(await win.executeCommand('netstat -anq'), /:9000\s/))[3]).toBe('LISTENING');
  });

  it('the owner of the bound socket is the process that holds it, and its death takes the socket', async () => {
    const { win } = await bench();
    const holder = Number(/PID\s*:\s*(\d+)/.exec(await win.executeCommand('sc queryex Dnscache'))![1]);
    win.getTcpStack().bind(9000, { identity: { pid: holder, processName: 'svchost.exe' } });
    expect(cellsOf(rowFor(await win.executeCommand('netstat -anoq'), /:9000\s/)).at(-1)).toBe(String(holder));
    await win.executeCommand(`taskkill /F /PID ${holder}`);
    expect(rowFor(await win.executeCommand('netstat -anoq'), /:9000\s/)).toBe('<absent>');
    win.getTcpStack().listen(9000, { onAccept: () => undefined });
  });

  it('promotes its own row: not the UDP endpoint of the same port, not the IPv6 socket bound before it', async () => {
    const { win } = await bench();
    win.udpBind(9000, () => undefined);
    win.getTcpStack().bind(9000, undefined, '::');
    const wildcard = win.getTcpStack().bind(9000);
    win.getTcpStack().startListening(wildcard, () => undefined);
    const rows = dataRows(await win.executeCommand('netstat -anq')).filter((row) => /:9000\s/.test(row)).map(cellsOf);
    expect(rows).toEqual([
      ['TCP', '0.0.0.0:9000', '0.0.0.0:0', 'LISTENING'],
      ['TCP', '[::]:9000', '[::]:0', 'BOUND'],
      ['UDP', '0.0.0.0:9000', '*:*'],
    ]);
  });

  it('a bound socket takes its place in the order of the TCP rows', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(100, undefined, '10.0.0.7');
    win.getTcpStack().bind(70);
    const tcp = dataRows(await win.executeCommand('netstat -anq')).filter((row) => /^\s*TCP/.test(row));
    expect(tcp.map((row) => cellsOf(row)[1]).slice(0, 2)).toEqual(['0.0.0.0:22', '0.0.0.0:70']);
    expect(tcp.map((row) => cellsOf(row)[1])).toContain('10.0.0.7:100');
  });
});

describe('PowerShell and the other views agree', () => {
  it('Get-NetTCPConnection -State Bound lists it with the wildcard remote address and no template', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    const output = await powershell(win, 'Get-NetTCPConnection -State Bound | Format-List *');
    expect(output).toMatch(/LocalPort\s*:\s*9000/);
    expect(output).toMatch(/RemoteAddress\s*:\s*0\.0\.0\.0/);
    expect(output).toMatch(/State\s*:\s*Bound/);
    expect(output).toMatch(/AppliedSetting\s*:\s*$/m);
  });

  it('Get-NetTCPConnection -State Listen does not list it', async () => {
    const { win } = await bench();
    win.getTcpStack().bind(9000);
    expect(await powershell(win, 'Get-NetTCPConnection -State Listen')).not.toMatch(/LocalPort\s*:\s*9000/);
  });

  it('a Linux host keeps the bound socket out of ss, netstat and /proc/net/tcp, as its kernel keeps it out of the hash tables they walk', async () => {
    const { linux } = await bench();
    linux.getTcpStack().bind(9000);
    linux.getTcpStack().listen(9001, { onAccept: () => undefined });
    expect(await linux.executeCommand('ss -tln')).toContain(':9001');
    expect(await linux.executeCommand('cat /proc/net/tcp')).toContain(':2329');
    expect(await linux.executeCommand('netstat -tan')).toContain(':9001');
    for (const command of ['ss -tan', 'ss -tlnp', 'netstat -tan', 'cat /proc/net/tcp']) {
      expect(await linux.executeCommand(command)).not.toMatch(/:9000\s|:2328\s/);
    }
  });

  it('the Linux bound socket still holds its port', async () => {
    const { linux } = await bench();
    linux.getTcpStack().bind(9000);
    expect(() => linux.getTcpStack().listen(9000, { onAccept: () => undefined })).toThrow(/EADDRINUSE/);
  });
});
