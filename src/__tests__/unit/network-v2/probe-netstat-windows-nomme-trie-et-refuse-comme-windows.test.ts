/**
 * `netstat` de Windows imprime comme le vrai : les lignes triees, les ecoutes face au nom de l'ordinateur, la colonne
 * distante nommee par le fichier services, le fichier hosts et le DNS de la machine (sauf avec `-n`), les adresses IPv6
 * entre crochets avec leur zone, `-p` restreint aux familles qu'il connait, l'aide rendue et la ligne de commande
 * refusee quand le vrai la refuse, `-e` et `-s` ensemble, les commutateurs sans egard a la casse.
 *
 * Mesure de depart (fa7d49a31), un LinuxPC et un WindowsServer cables, le role DNS installe : `netstat -an` listait les
 * lignes dans l'ordre ou la table les avait recues (le TCP 53 apres les UDP, les ecoutes IPv6 apres les UDP), une ecoute
 * IPv6 en `:::7200`, `::1:7300` ou `fe80::ff:fe00:5:8080` (ni crochets ni zone) face a une adresse distante IPv4
 * `0.0.0.0:0` ; aucun nom n'etait jamais cherche, ni `microsoft-ds` pour le 445, ni le fichier hosts, ni le DNS, et une
 * ecoute portait `0.0.0.0:0` au lieu du nom de l'ordinateur ; une connexion en TIME_WAIT n'apparaissait pas sans `-a` ;
 * `-ap udp` et `-p tcpv6` listaient tout ; `/?`, `-?`, `-z` et `-p foo` imprimaient le tableau comme si de rien n'etait,
 * aucune ligne de commande ne rendait l'aide ; `NETSTAT -AN` n'imprimait que l'entete ; `-e -s` ne disait que `-e`, dont
 * la ligne `Unknown protocols` portait deux chiffres.
 *
 * Autorites : le texte de `netstat /?` capture sur Windows 10 22H2 (pen2.com) pour l'aide, l'ordre des commutateurs et
 * la disposition des colonnes (largeurs 6, 22, 22 et 15, un blanc entre colonnes, retrait de 2) ; Microsoft Learn
 * (`netstat`) pour `-a`, `-e`, `-f`, `-n`, `-p` et `-s` ; des transcriptions de `netstat -ano` et `-bano`
 * (BleepingComputer, geekflare) pour le nom de l'ordinateur en colonne distante (`PC:0` pour une ecoute, une adresse de
 * la machine ou la boucle), la colonne PID et les lignes UDP `*:*`. Non confirme depuis cet environnement : la ligne
 * vide qui precede le texte d'aide ; que chaque ligne de commande invalide (commutateur inconnu, `-p` sans protocole ou
 * suivi d'un protocole hors de sa liste, `-y` avec `-b`) rende l'aide plutot qu'un message plus court ; l'ordre des
 * lignes d'une machine a plusieurs adresses (tri numerique par adresse puis par port, TCP IPv4, TCP IPv6, UDP IPv4, UDP
 * IPv6, deduit de transcriptions a une seule adresse) ; que `-f` ajoute le suffixe DNS principal au nom de l'ordinateur
 * ; `-s -p ipv6|icmpv6|tcpv6|udpv6`, laisse comme avant faute de compteurs IPv6 (D9).
 *
 * Ce qui est construit : `WinNetstat.ts` (arguments types, aide, tri, noms, familles, statistiques) remplace le code de
 * `WinFileCommands.ts` ; la mise en colonnes est `renderTable` de `TextTable` ; la colonne distante lit le fichier
 * services de la machine (`IanaServiceRegistry.fromServicesFile`, dont `parseServicesRecord` remplace aussi le lecteur
 * de `/etc/services` de `getent`), son fichier hosts (`HostsFile`) et son DNS par une vraie question PTR sur le fil
 * (`resolveAddressNameAsync`, mise en cache par le cache DNS) ; la zone d'une adresse de lien local est l'indice de
 * l'interface.
 *
 * Discrimination (fichier copie sur fa7d49a31) : VINGT-HUIT cas sur trente-cinq tombent. Les sept autres passent des
 * deux cotes : le temoin et six non-regressions (sans `-a` ni ecoute ni extremite UDP ; `-a` les ajoute ; `-p udp` sans
 * `-a` ne liste rien, UDP n'ayant pas de connexion ; `-y` avec les options qu'il accepte n'est pas une erreur d'usage ;
 * `-rn` imprime toujours la table de routage ; un intervalle ne change pas ce qu'un affichage montre). Mutations,
 * trente-sept tuees sur trente-huit : etiquette LISTENING perdue 5, filtre d'etat ignore 3, seulement ESTABLISHED sans
 * `-a` 5, sans tri 2, UDP avant TCP 1, ordre lexical des adresses 1, ordre des ports perdu 2, IPv6 sans crochets 5, zone
 * perdue 1, sans blanc entre colonnes 3, noms toujours 7, noms jamais 9, adresse propre non nommee 4, ports numeriques
 * 4, registre standard au lieu du fichier services 1, `-f` ignore pour la colonne distante 1, `-f` toujours 1, suffixe
 * DNS local ignore 1, aucune resolution 2, filtre de protocole ignore 3, famille absente de la cle 2, `-p` seulement
 * seul 2, sensible a la casse 1, commutateur inconnu ignore 3, `-p` sans protocole accepte 1, protocole de liste non
 * controle 1, combinaisons de `-y` ignorees 1, `-e` perdu avec `-s` 1, premiere famille seule 1, `Unknown protocols` a
 * deux chiffres 1, intervalle refuse 1, colonne PID perdue 1 ; lecture de la zone morte 1, fichier services non lu 4,
 * boucle IPv4 et boucle IPv6 non propres 2, suffixe DNS non lu 1. La survivante est equivalente : retirer de
 * `isListener` la garde `UDP` ne change rien tant que la table range toute extremite UDP a l'etat LISTEN, ce qu'elle
 * fait aujourd'hui, y compris pour une socket UDP connectee ; la garde reste pour que la reponse ne depende pas de ce
 * choix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const SERVICES_FILE = 'C:\\Windows\\System32\\drivers\\etc\\services';

interface Bench {
  readonly linux: LinuxPC;
  readonly win: WindowsPC;
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
  return { linux, win };
}

async function closedByWindows(lab: Bench, remotePort = 22): Promise<void> {
  const socket = lab.win.getTcpStack().connect('10.0.0.3', remotePort, {})!;
  await settle();
  socket.close();
  await settle();
}

const dataRows = (output: string) => output.split('\n').filter((line) => /^\s*(TCP|UDP)\s/.test(line));

const cellsOf = (row: string) => row.trim().split(/\s+/);

const rowFor = (output: string, pattern: RegExp) => dataRows(output).find((row) => pattern.test(row)) ?? '<absent>';

const pad = (text: string, width: number) => text.padEnd(width);

describe('the bench is sound (witness)', () => {
  it('-ano prints the header of the real tool and the sshd.exe listener at its pid', async () => {
    const { win } = await bench();
    const output = await win.executeCommand('netstat -ano');
    expect(output.split('\n').slice(0, 4)).toEqual([
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
    ]);
    expect(cellsOf(rowFor(output, /:22\s/))).toEqual(['TCP', '0.0.0.0:22', '0.0.0.0:0', 'LISTENING', '1088']);
  });
});

describe('a row is laid out the way the real tool lays it out', () => {
  it('an IPv6 address is bracketed and carries its zone, and a value longer than its column keeps one blank before the next', async () => {
    const { win } = await bench();
    const linkLocal = win.getPort('eth0')!.getLinkLocalIPv6()!.toString().replace(/%.*$/, '');
    win.getTcpStack().listen(8080, { onAccept: () => undefined }, linkLocal);
    const row = rowFor(await win.executeCommand('netstat -an'), /:8080\s/);
    expect(row).toBe(`  ${pad('TCP', 6)} [${linkLocal}%2]:8080 ${pad('[::]:0', 22)} LISTENING`);
  });

  it('the wildcard and the loopback of IPv6 are bracketed too', async () => {
    const { win } = await bench();
    win.getTcpStack().listen(7200, { onAccept: () => undefined }, '::');
    win.getTcpStack().listen(7300, { onAccept: () => undefined }, '::1');
    const output = await win.executeCommand('netstat -an');
    expect(cellsOf(rowFor(output, /:7200\s/))).toEqual(['TCP', '[::]:7200', '[::]:0', 'LISTENING']);
    expect(cellsOf(rowFor(output, /:7300\s/))).toEqual(['TCP', '[::1]:7300', '[::]:0', 'LISTENING']);
  });
});

describe('the rows come in the order of the real tool', () => {
  it('TCP rows are sorted by local address, numerically, and then by port; IPv4 before IPv6', async () => {
    const { win } = await bench();
    const never = { onAccept: () => undefined };
    win.getTcpStack().listen(9100, never);
    win.getTcpStack().listen(8100, never, '10.0.0.7');
    win.getTcpStack().listen(8200, never, '127.0.0.1');
    win.getTcpStack().listen(8300, never, '9.9.9.9');
    win.getTcpStack().listen(7100, never);
    win.getTcpStack().listen(7300, never, '::1');
    win.getTcpStack().listen(7200, never, '::');
    const tcp = dataRows(await win.executeCommand('netstat -an')).filter((row) => /^\s*TCP/.test(row));
    expect(tcp.map((row) => cellsOf(row)[1])).toEqual([
      '0.0.0.0:22', '0.0.0.0:135', '0.0.0.0:139', '0.0.0.0:445', '0.0.0.0:7100', '0.0.0.0:9100',
      '9.9.9.9:8300', '10.0.0.7:8100', '127.0.0.1:8200', '[::]:7200', '[::1]:7300',
    ]);
  });

  it('every TCP row comes before every UDP row, and the UDP rows are in port order', async () => {
    const { win } = await bench();
    win.udpBind(9300, () => undefined, 'probe.exe', { pid: 4242 });
    win.udpBind(2000, () => undefined, 'probe.exe', { pid: 4242 });
    const rows = dataRows(await win.executeCommand('netstat -an'));
    const firstUdp = rows.findIndex((row) => /^\s*UDP/.test(row));
    expect(firstUdp).toBeGreaterThan(0);
    expect(rows.slice(0, firstUdp).every((row) => /^\s*TCP/.test(row))).toBe(true);
    expect(rows.slice(firstUdp).every((row) => /^\s*UDP/.test(row))).toBe(true);
    const ports = rows.slice(firstUdp).map((row) => Number(cellsOf(row)[1].split(':')[1]));
    expect(ports).toEqual([...ports].sort((a, b) => a - b));
    expect(ports).toContain(2000);
    expect(ports).toContain(9300);
  });
});

describe('what the listing shows without -a', () => {
  it('a connection that is neither established nor listening is listed: TIME_WAIT after the machine closed', async () => {
    const lab = await bench();
    await closedByWindows(lab);
    const rows = dataRows(await lab.win.executeCommand('netstat'));
    expect(rows).toHaveLength(1);
    expect(cellsOf(rows[0])).toEqual(['TCP', expect.stringMatching(/^10\.0\.0\.7:\d+$/), '10.0.0.3:ssh', 'TIME_WAIT']);
  });

  it('no listener and no UDP endpoint without -a', async () => {
    const lab = await bench();
    await closedByWindows(lab);
    const rows = dataRows(await lab.win.executeCommand('netstat'));
    expect(rows.some((row) => /LISTENING/.test(row) || /^\s*UDP/.test(row))).toBe(false);
  });

  it('-a adds the listeners and the UDP endpoints', async () => {
    const { win } = await bench();
    const rows = dataRows(await win.executeCommand('netstat -a'));
    expect(rows.some((row) => /LISTENING/.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*UDP\s+0\.0\.0\.0:123\s/.test(row))).toBe(true);
  });
});

describe('the names of the foreign column', () => {
  it('a listener has the computer name for foreign address, and -n turns it back into the address', async () => {
    const { win } = await bench();
    expect(cellsOf(rowFor(await win.executeCommand('netstat -a'), /:22\s/))).toEqual(['TCP', '0.0.0.0:22', 'WIN:0', 'LISTENING']);
    expect(cellsOf(rowFor(await win.executeCommand('netstat -an'), /:22\s/))).toEqual(['TCP', '0.0.0.0:22', '0.0.0.0:0', 'LISTENING']);
  });

  it('a connection through the loopback shows the computer name and the peer port', async () => {
    const { win } = await bench();
    win.getTcpStack().listen(8082, { onAccept: () => undefined }, '127.0.0.1');
    const client = win.getTcpStack().connect('127.0.0.1', 8082, {})!;
    await settle();
    const output = await win.executeCommand('netstat');
    expect(dataRows(output).map((row) => cellsOf(row).slice(1))).toEqual(expect.arrayContaining([
      ['127.0.0.1:8082', expect.stringMatching(/^WIN:\d+$/), 'ESTABLISHED'],
      [expect.stringMatching(/^127\.0\.0\.1:\d+$/), 'WIN:8082', 'ESTABLISHED'],
    ]));
    client.close();
  });

  it('a connection through the IPv6 loopback shows the computer name too', async () => {
    const { win } = await bench();
    win.getTcpStack().listen(8081, { onAccept: () => undefined }, '::');
    const client = win.getTcpStack().connect('::1', 8081, {})!;
    await settle();
    const rows = dataRows(await win.executeCommand('netstat'));
    expect(rows.map((row) => cellsOf(row).slice(1))).toEqual(expect.arrayContaining([
      ['[::1]:8081', expect.stringMatching(/^WIN:\d+$/), 'ESTABLISHED'],
    ]));
    client.close();
  });

  it('the foreign port is named by the services file of the machine, and -n keeps the number', async () => {
    const lab = await bench();
    await closedByWindows(lab);
    expect(cellsOf(rowFor(await lab.win.executeCommand('netstat'), /TIME_WAIT/))[2]).toBe('10.0.0.3:ssh');
    expect(cellsOf(rowFor(await lab.win.executeCommand('netstat -n'), /TIME_WAIT/))[2]).toBe('10.0.0.3:22');
  });

  it('editing the services file changes the name that netstat prints', async () => {
    const lab = await bench();
    const file = lab.win.getFileSystem().readFile(SERVICES_FILE);
    lab.win.getFileSystem().createFile(SERVICES_FILE, `${file.content ?? ''}\nlab-app         9000/tcp\n`);
    lab.linux.getTcpStack().listen(9000, { onAccept: () => undefined });
    await closedByWindows(lab, 9000);
    expect(cellsOf(rowFor(await lab.win.executeCommand('netstat'), /TIME_WAIT/))[2]).toBe('10.0.0.3:lab-app');
  });

  it('a name from the hosts file replaces the address, short without -f and fully qualified with it', async () => {
    const lab = await bench();
    await closedByWindows(lab);
    lab.win.addHostsEntry('10.0.0.3', 'linuxbox.lab.local');
    expect(cellsOf(rowFor(await lab.win.executeCommand('netstat'), /TIME_WAIT/))[2]).toBe('linuxbox:ssh');
    expect(cellsOf(rowFor(await lab.win.executeCommand('netstat -f'), /TIME_WAIT/))[2]).toBe('linuxbox.lab.local:ssh');
    expect(cellsOf(rowFor(await lab.win.executeCommand('netstat -n'), /TIME_WAIT/))[2]).toBe('10.0.0.3:22');
  });

  it('-f gives the computer name its primary DNS suffix, and without -f the name stays short', async () => {
    const { win } = await bench();
    await win.executeCommand('netsh dnsclient set global dnssuffix=lab.local');
    expect(cellsOf(rowFor(await win.executeCommand('netstat -af'), /:22\s/))[2]).toBe('WIN.lab.local:0');
    expect(cellsOf(rowFor(await win.executeCommand('netstat -a'), /:22\s/))[2]).toBe('WIN:0');
  });

  it('names cost a DNS question on the wire; -n sends none', async () => {
    const lab = await bench();
    await lab.win.executeCommand('netsh interface ip set dns "Ethernet0" static 10.0.0.3');
    await closedByWindows(lab);
    const sent = () => lab.win.getPort('eth0')!.getCounters()!.framesOut;
    const before = sent();
    await lab.win.executeCommand('netstat -n');
    const numeric = sent() - before;
    await lab.win.executeCommand('netstat');
    const named = sent() - before - numeric;
    expect(numeric).toBe(0);
    expect(named).toBeGreaterThan(0);
  });
});

describe('the protocols the listing is restricted to', () => {
  it('-ap udp lists the UDP endpoints and nothing else', async () => {
    const { win } = await bench();
    const rows = dataRows(await win.executeCommand('netstat -ap udp'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => /^\s*UDP/.test(row))).toBe(true);
  });

  it('-anp tcp lists the IPv4 TCP rows and nothing else', async () => {
    const { win } = await bench();
    win.getTcpStack().listen(7200, { onAccept: () => undefined }, '::');
    const rows = dataRows(await win.executeCommand('netstat -anp tcp'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => /^\s*TCP\s+[0-9.]+:/.test(row))).toBe(true);
  });

  it('-p tcpv6 lists the IPv6 TCP rows and nothing else', async () => {
    const { win } = await bench();
    win.getTcpStack().listen(7200, { onAccept: () => undefined }, '::');
    const rows = dataRows(await win.executeCommand('netstat -a -p tcpv6'));
    expect(rows.map((row) => cellsOf(row)[1])).toEqual(['[::]:7200']);
  });

  it('-p udp without -a lists no endpoint: UDP has no connection', async () => {
    const { win } = await bench();
    expect(dataRows(await win.executeCommand('netstat -p udp'))).toEqual([]);
  });
});

describe('what the tool answers to what it does not know', () => {
  const usageLines = [
    'Displays protocol statistics and current TCP/IP network connections.',
    'NETSTAT [-a] [-b] [-e] [-f] [-n] [-o] [-p proto] [-r] [-s] [-t] [-x] [-y] [interval]',
    '  -q            Displays all connections, listening ports, and bound',
    '  -y            Displays the TCP connection template for all connections.',
  ];

  it.each(['netstat /?', 'netstat -?', 'netstat -z', 'netstat -p foo', 'netstat -p', 'netstat -p icmp', 'netstat -y -b', 'netstat abc'])(
    '%s prints the usage of the tool', async (command) => {
      const { win } = await bench();
      const output = await win.executeCommand(command);
      for (const line of usageLines) expect(output.split('\n')).toContain(line);
      expect(output).not.toContain('Active Connections');
    });

  it('-y with the options it can be combined with is not a usage error', async () => {
    const { win } = await bench();
    expect(await win.executeCommand('netstat -y -a -f -p tcp')).not.toContain('NETSTAT [-a]');
  });
});

describe('the statistics', () => {
  it('-e and -s together print both reports', async () => {
    const { win } = await bench();
    const output = await win.executeCommand('netstat -e -s');
    expect(output).toContain('Interface Statistics');
    expect(output).toContain('IPv4 Statistics');
  });

  it('-s -p tcp udp prints the TCP and UDP blocks and no other', async () => {
    const { win } = await bench();
    const lines = (await win.executeCommand('netstat -s -p tcp udp')).split('\n');
    expect(lines).toContain('TCP Statistics for IPv4');
    expect(lines).toContain('UDP Statistics for IPv4');
    expect(lines).not.toContain('IPv4 Statistics');
    expect(lines).not.toContain('ICMPv4 Statistics');
  });

  it('the Unknown protocols line of -e has a single count, as in the real report', async () => {
    const { win } = await bench();
    const line = (await win.executeCommand('netstat -e')).split('\n').find((candidate) => candidate.startsWith('Unknown protocols'));
    expect(line).toMatch(/^Unknown protocols\s+\d+$/);
  });

  it('-rn still prints the routing table', async () => {
    const { win } = await bench();
    expect(await win.executeCommand('netstat -rn')).toContain('IPv4 Route Table');
  });
});

describe('the arguments', () => {
  it('the switches are not case sensitive', async () => {
    const { win } = await bench();
    expect(await win.executeCommand('netstat -ANO')).toBe(await win.executeCommand('netstat -ano'));
  });

  it('an interval does not change what one display shows', async () => {
    const { win } = await bench();
    expect(await win.executeCommand('netstat -ano 5')).toBe(await win.executeCommand('netstat -ano'));
  });
});
