/**
 * `netstat -s` rend ce que la machine a REELLEMENT compte.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : deux postes cables sur un
 * commutateur, `ping -c 3` (Linux) ou `ping -n 3` (Windows), puis la
 * question aux deux plateformes.
 *
 * ```
 * Linux   netstat -s          Ip:  0 total packets received
 *                                  0 requests sent out
 *                             Icmp: 0 ICMP messages received
 *                                   0 ICMP messages sent
 * Linux   cat /proc/net/snmp  Ip: 1 64 0 0 0 0 0 0 0 0 ...
 * Windows netstat -s          Active Connections
 *                               Proto  Local Address  Foreign Address  State
 * ```
 *
 * Trois defauts d'un coup. Cote Linux, `netstat -s` ecrit ses propres
 * zeros dans son propre fichier sans jamais lire `/proc/net/snmp`, qui
 * est POURTANT la source que le vrai `netstat` ouvre — deux ecritures
 * du meme fait, toutes deux fausses, et rien pour dire laquelle est
 * juste. Cote Windows, `-s` n'est pas traite du tout : la commande
 * tombe dans la branche par defaut et repond la table des CONNEXIONS,
 * c'est-a-dire a une autre question que celle posee — alors que `-s`
 * est annonce dans la liste de completion de `netstat`. Et sous les
 * deux, la machine ne compte rien : trois `ping` aller-retour laissent
 * chaque compteur a zero.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Le vrai `netstat -s` de net-tools lit `/proc/net/snmp` et
 * `/proc/net/netstat` ; les noms de champs sont ceux de la MIB-II
 * (RFC 1213 / RFC 4293) : `Ip: InReceives InDelivers OutRequests`,
 * `Icmp: InMsgs OutMsgs InEchos OutEchoReps OutEchos InEchoReps`,
 * `Tcp: ActiveOpens PassiveOpens CurrEstab InSegs OutSegs`,
 * `Udp: InDatagrams NoPorts InErrors OutDatagrams`.
 *
 * Windows rend les memes compteurs sous ses propres intitules, releves
 * sur une sortie capturee : `IPv4 Statistics` avec
 * `Packets Received` / `Received Packets Delivered` / `Output Requests`,
 * puis `ICMPv4 Statistics` en deux colonnes `Received` et `Sent` avec
 * les lignes `Messages`, `Echos` et `Echo Replies`, puis
 * `TCP Statistics for IPv4` (`Active Opens`, `Passive Opens`,
 * `Current Connections`, `Segments Received`, `Segments Sent`) et
 * `UDP Statistics for IPv4` (`Datagrams Received`, `No Ports`,
 * `Receive Errors`, `Datagrams Sent`).
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 11 cas sur 15 tombent contre l'etat d'avant. Les QUATRE
 * autres passent des deux cotes, et chacun a sa raison :
 *  - TEMOINS — « les compteurs d'interface ne bougent pas » (ce qui se
 *    compte au niveau du LIEN etait deja juste, et le reste), « netstat
 *    sans -s rend toujours la table des connexions » (la branche par
 *    defaut n'a pas ete deplacee) et « netstat -e de Windows compte
 *    toujours les octets du lien » (l'autre vue de Windows, deja
 *    juste) ;
 *  - VACUEUX AVANT, NON-REGRESSION APRES — « une machine qui n'a rien
 *    echange compte zero, pas rien » : avant le correctif TOUS les
 *    compteurs valaient zero, donc ce cas passait sans rien prouver.
 *    Il est garde parce qu'apres, il est le seul a garantir qu'un
 *    compteur non mesure se lit `0` et non pas absent — ce qu'un agent
 *    de supervision distingue.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';

interface Poste {
  executeCommand(cmd: string): Promise<string>;
  getPort(name: string): never;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboLinux(): Promise<{ a: Poste; b: Poste }> {
  const a = createDevice('linux-pc', 0, 0) as unknown as Poste;
  const b = createDevice('linux-pc', 200, 0) as unknown as Poste;
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  new Cable('c1').connect(a.getPort('eth0'), sw.getPort('eth0')!);
  new Cable('c2').connect(b.getPort('eth0'), sw.getPort('eth1')!);
  await a.executeCommand('sudo ip addr add 10.0.0.1/24 dev eth0');
  await a.executeCommand('sudo ip link set eth0 up');
  await b.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await b.executeCommand('sudo ip link set eth0 up');
  await a.executeCommand('ping -c 3 10.0.0.2');
  return { a, b };
}

async function laboWindows(): Promise<Poste> {
  const w = createDevice('windows-pc', 0, 0) as unknown as Poste;
  const l = createDevice('linux-pc', 200, 0) as unknown as Poste;
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  new Cable('c1').connect(w.getPort('eth0'), sw.getPort('eth0')!);
  new Cable('c2').connect(l.getPort('eth0'), sw.getPort('eth1')!);
  await w.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.1 255.255.255.0');
  await l.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await l.executeCommand('sudo ip link set eth0 up');
  await w.executeCommand('ping -n 3 10.0.0.2');
  return w;
}

function champSnmp(snmp: string, bloc: string, champ: string): number {
  const lignes = snmp.split('\n').filter((l) => l.startsWith(`${bloc}: `));
  const noms = lignes[0]?.slice(bloc.length + 2).split(' ') ?? [];
  const valeurs = lignes[1]?.slice(bloc.length + 2).split(' ') ?? [];
  const at = noms.indexOf(champ);
  return at < 0 ? -1 : Number(valeurs[at]);
}

function entier(texte: string, motif: RegExp): number {
  const m = motif.exec(texte);
  return m ? Number(m[1]) : -1;
}

describe('Linux compte ses paquets, et netstat -s les lit dans /proc', () => {
  it('trois echos aller-retour se voient dans Ip', async () => {
    const { a } = await laboLinux();

    const s = await a.executeCommand('netstat -s');

    expect(entier(s, /(\d+) total packets received/)).toBeGreaterThanOrEqual(3);
    expect(entier(s, /(\d+) requests sent out/)).toBeGreaterThanOrEqual(3);
  });

  it('netstat -s et /proc/net/snmp donnent le meme Ip', async () => {
    const { a } = await laboLinux();

    const snmp = await a.executeCommand('cat /proc/net/snmp');
    const s = await a.executeCommand('netstat -s');

    expect(champSnmp(snmp, 'Ip', 'InReceives')).toBeGreaterThan(0);
    expect(champSnmp(snmp, 'Ip', 'OutRequests')).toBeGreaterThan(0);
    expect(champSnmp(snmp, 'Ip', 'InReceives'))
      .toBe(entier(s, /(\d+) total packets received/));
    expect(champSnmp(snmp, 'Ip', 'OutRequests'))
      .toBe(entier(s, /(\d+) requests sent out/));
  });

  it('l emetteur a envoye trois echos et recu trois reponses', async () => {
    const { a } = await laboLinux();

    const snmp = await a.executeCommand('cat /proc/net/snmp');

    expect(champSnmp(snmp, 'Icmp', 'OutEchos')).toBe(3);
    expect(champSnmp(snmp, 'Icmp', 'InEchoReps')).toBe(3);
  });

  it('le repondeur a recu trois echos et renvoye trois reponses', async () => {
    const { b } = await laboLinux();

    const snmp = await b.executeCommand('cat /proc/net/snmp');

    expect(champSnmp(snmp, 'Icmp', 'InEchos')).toBe(3);
    expect(champSnmp(snmp, 'Icmp', 'OutEchoReps')).toBe(3);
  });

  it('netstat -s rend le compte ICMP de /proc', async () => {
    const { a } = await laboLinux();

    const s = await a.executeCommand('netstat -s');

    expect(entier(s, /(\d+) ICMP messages received/)).toBe(3);
    expect(entier(s, /(\d+) ICMP messages sent/)).toBe(3);
  });

  it('un datagramme UDP vers un port ferme se compte comme NoPorts', async () => {
    const { a, b } = await laboLinux();

    await a.executeCommand('echo bonjour | nc -u -w 1 10.0.0.2 9999');
    const snmp = await b.executeCommand('cat /proc/net/snmp');

    expect(champSnmp(snmp, 'Udp', 'NoPorts')).toBeGreaterThan(0);
    expect(champSnmp(snmp, 'Icmp', 'OutDestUnreachs')).toBeGreaterThan(0);
  });

  it('une machine qui n a rien echange compte zero, pas rien', async () => {
    const seul = createDevice('linux-pc', 0, 0) as unknown as Poste;

    const snmp = await seul.executeCommand('cat /proc/net/snmp');

    expect(champSnmp(snmp, 'Ip', 'InReceives')).toBe(0);
    expect(champSnmp(snmp, 'Udp', 'InDatagrams')).toBe(0);
  });
});

describe('Windows repond a la question posee par netstat -s', () => {
  it('les quatre blocs sont ceux du vrai netstat -s', async () => {
    const w = await laboWindows();

    const s = await w.executeCommand('netstat -s');

    expect(s).toContain('IPv4 Statistics');
    expect(s).toContain('ICMPv4 Statistics');
    expect(s).toContain('TCP Statistics for IPv4');
    expect(s).toContain('UDP Statistics for IPv4');
    expect(s).not.toContain('Active Connections');
  });

  it('IPv4 Statistics porte le compte des trois echos', async () => {
    const w = await laboWindows();

    const s = await w.executeCommand('netstat -s');

    expect(entier(s, /Packets Received\s+= (\d+)/)).toBeGreaterThanOrEqual(3);
    expect(entier(s, /Output Requests\s+= (\d+)/)).toBeGreaterThanOrEqual(3);
  });

  it('ICMPv4 Statistics a deux colonnes, Received et Sent', async () => {
    const w = await laboWindows();

    const s = await w.executeCommand('netstat -s');
    const bloc = s.split('ICMPv4 Statistics')[1] ?? '';

    expect(bloc).toMatch(/Received\s+Sent/);
    expect(entier(bloc, /Echos\s+\d+\s+(\d+)/)).toBe(3);
    expect(entier(bloc, /Echo Replies\s+(\d+)/)).toBe(3);
  });

  it('TCP et UDP rendent leurs compteurs, pas la table des connexions', async () => {
    const w = await laboWindows();

    const s = await w.executeCommand('netstat -s');

    expect(entier(s, /Active Opens\s+= (\d+)/)).toBeGreaterThanOrEqual(0);
    expect(entier(s, /Segments Received\s+= (\d+)/)).toBeGreaterThanOrEqual(0);
    expect(entier(s, /Datagrams Received\s+= (\d+)/)).toBeGreaterThanOrEqual(0);
    expect(entier(s, /No Ports\s+= (\d+)/)).toBeGreaterThanOrEqual(0);
  });

  it('-p limite le rendu au protocole demande', async () => {
    const w = await laboWindows();

    const s = await w.executeCommand('netstat -s -p icmp');

    expect(s).toContain('ICMPv4 Statistics');
    expect(s).not.toContain('TCP Statistics for IPv4');
  });
});

describe('TEMOINS', () => {
  it('les compteurs d interface ne bougent pas', async () => {
    const { a } = await laboLinux();

    const parEthtool = /rx_packets: (\d+)/
      .exec(await a.executeCommand('ethtool -S eth0'))?.[1] ?? '<absent>';

    expect(Number(parEthtool)).toBeGreaterThan(0);
    expect((await a.executeCommand('cat /sys/class/net/eth0/statistics/rx_packets')).trim())
      .toBe(parEthtool);
  });

  it('netstat sans -s rend toujours la table des connexions', async () => {
    const { a } = await laboLinux();

    expect(await a.executeCommand('netstat -tln'))
      .toContain('Active Internet connections');
  });

  it('netstat -e de Windows compte toujours les octets du lien', async () => {
    const w = await laboWindows();

    const s = await w.executeCommand('netstat -e');

    expect(s).toContain('Interface Statistics');
    expect(entier(s, /Bytes\s+(\d+)/)).toBeGreaterThan(0);
  });
});
