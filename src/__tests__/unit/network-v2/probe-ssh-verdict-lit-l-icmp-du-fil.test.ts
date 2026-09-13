/*
 * Un `ssh` bloque par une liste du ROUTEUR repondait « Connection
 * refused », le mot du pare-feu de l'hote, pour un paquet que l'hote
 * n'a jamais vu.
 *
 *     const verdict = inboundFirewallVerdict(machine, opts.sourceIp, port);
 *     if (verdict === 'drop' || verdict === 'reject') { ... }
 *     if (wireReachOutcome(...) === 'blocked') { ... timed out }
 *
 * L'ordre est inverse de la physique. `inboundFirewallVerdict` atteint
 * l'objet de la machine DISTANTE et interroge son `iptables` — le
 * raccourci que ce depot n'accepte pas — et il tranche AVANT que la
 * sonde du fil ait dit si la trame arrive jusque-la. Dans un
 * laboratoire a trois couches, le client que la liste du routeur jette
 * se faisait donc juger par un pare-feu qu'il n'a pas atteint.
 *
 * La cause de l'ordre est mesurable, et elle est en amont : la sonde
 * APATRIDE est SOURDE a l'ICMP. `StatelessProbeWatch.seen` ne connait
 * que `rst | syn-ack | none`, et `onIcmpUnreachable` ne parcourt que
 * `this.sockets` — or une sonde de `scanProbe` n'ouvre aucun socket.
 * Tout ce qui revient en ICMP est donc invisible, et « rien n'est
 * revenu » confondait le rejet actif avec le silence.
 *
 * Rien d'autre ne manque : le fil porte DEJA les deux reponses.
 * `Router.deniedByInboundACL` et son jumeau sortant emettent
 * « destination-unreachable » code 13, et `EndHost.resolveRejectCode`
 * rend le code 3 pour un `-j REJECT` nu — « Real iptables: a bare
 * `-j REJECT` with no `--reject-with` defaults to
 * icmp-port-unreachable », dit son propre commentaire. Le vocabulaire
 * a cinq valeurs existe aussi (`TcpWireOutcome`), et `nmap` le lit
 * deja. Il n'y avait qu'a ENTENDRE.
 *
 * L'autorite est la table du noyau, `icmp_err_convert` de
 * `net/ipv4/icmp.c`, que le client `ssh` ne fait que rendre en mots :
 *
 *   code  3  ICMP_PORT_UNREACH    ECONNREFUSED   Connection refused
 *   code  9  ICMP_NET_ANO         ENETUNREACH    No route to host
 *   code 10  ICMP_HOST_ANO        EHOSTUNREACH   No route to host
 *   code 13  ICMP_PKT_FILTERED    EHOSTUNREACH   No route to host
 *   (rien)                                       Connection timed out
 *
 * D'ou la table que la sonde exige, et qui tient en une phrase : ce que
 * le client annonce est ce que le FIL lui a repondu.
 *
 *   liste du routeur `deny`          ICMP 3/13   No route to host
 *   `-j REJECT` nu                   ICMP 3/3    Connection refused
 *   `-j REJECT --reject-with`        ICMP 3/10   No route to host
 *   `-j DROP`                        rien        Connection timed out
 *   `-j REJECT --reject-with` RST    RST         Connection refused
 *   rien n'ecoute                    RST         Connection refused
 *   tout ouvert                      SYN-ACK     la session
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 3 des 10 cas
 * tombent. Les 7 autres sont nommes, et c'est tout l'interet de la
 * sonde qu'ils ne tombent PAS :
 *
 *   - « tout ouvert » est le TEMOIN. Sans lui, une table faite de refus
 *     serait satisfaite par un laboratoire ou rien ne marche.
 *   - `-j REJECT` nu, `-j DROP`, `tcp-reset` et « rien n'ecoute » sont
 *     des NON-REGRESSIONS : sur un LAN plat le pare-feu local etait
 *     deja le seul filtre, donc l'ancien ordre rendait par accident la
 *     bonne reponse. Ils prouvent que lire le fil ne la perd pas.
 *   - « la liste du routeur compte son refus » et « l'hote ne voit
 *     jamais la trame » sont STRUCTURELS : ils mesurent la couche qui
 *     tranche, et non le mot rendu. Le second est celui qui dit pourquoi
 *     l'ancienne reponse etait fausse, et non seulement mal choisie.
 *
 * Ce qui tombe : le verdict du client bloque par la liste du routeur, la
 * coherence du compteur `iptables` qui ne doit PAS bouger pour lui, et
 * `--reject-with icmp-host-prohibited`, dont le code 10 n'etait meme pas
 * reconnu comme erreur dure par `EndHost` — les codes 9 et 10 y
 * manquaient, alors que `PROHIBITED_UNREACH_CODES` les nomme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const M = new SubnetMask('255.255.255.0');

function seedAlice(server: LinuxServer): void {
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
    getUser(u: string): unknown;
  } } }).executor.userMgr;
  if (!um.getUser('alice')) um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alice');
}

interface LanPlat {
  client: LinuxPC;
  server: LinuxServer;
}

async function lanPlat(): Promise<LanPlat> {
  const client = new LinuxPC('linux-pc', 'cli', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw');
  new Cable('a').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), M);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), M);
  seedAlice(server);
  return { client, server };
}

interface LabRoute {
  client: LinuxPC;
  server: LinuxServer;
  router: CiscoRouter;
}

/**
 * Un client derriere un routeur, et un serveur dont l'`iptables`
 * REJETTERAIT ce client — mais la liste du routeur jette la trame
 * avant. C'est la seule facon de voir QUI a repondu.
 */
async function labRoute(listeDuRouteur: boolean): Promise<LabRoute> {
  const router = new CiscoRouter('router');
  const swA = new GenericSwitch('switch-generic', 'sw-A');
  const swB = new GenericSwitch('switch-generic', 'sw-B');
  const client = new LinuxPC('linux-pc', 'cli', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);

  router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.20.1'), M);
  router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.30.1'), M);
  new Cable('a').connect(client.getPorts()[0], swA.getPorts()[0]);
  new Cable('b').connect(swA.getPorts()[7], router.getPorts()[0]);
  new Cable('c').connect(server.getPorts()[0], swB.getPorts()[0]);
  new Cable('d').connect(swB.getPorts()[7], router.getPorts()[1]);

  client.getPorts()[0].configureIP(new IPAddress('10.0.20.10'), M);
  server.getPorts()[0].configureIP(new IPAddress('10.0.30.10'), M);
  client.setDefaultGateway(new IPAddress('10.0.20.1'));
  server.setDefaultGateway(new IPAddress('10.0.30.1'));
  seedAlice(server);

  if (listeDuRouteur) {
    for (const c of [
      'enable', 'configure terminal',
      'access-list 100 deny tcp any host 10.0.30.10 eq 22',
      'access-list 100 permit ip any any',
      'interface GigabitEthernet0/1', 'ip access-group 100 out', 'end',
    ]) await router.executeCommand(c);
  }
  await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');
  return { client, server, router };
}

describe('le verdict que `ssh` annonce est celui que le FIL a repondu', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('tout ouvert : la session s\'ouvre — le TEMOIN', async () => {
    const { client } = await lanPlat();
    const out = await client.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    expect(out).toMatch(/^alice\s*$/m);
  });

  it('liste du routeur `deny` : ICMP 3/13 -> No route to host', async () => {
    const { client } = await labRoute(true);
    const out = await client.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    expect(out, 'le mot du pare-feu distant pour une trame qu\'il n\'a pas vue')
      .not.toMatch(/Connection refused/);
    expect(out).toMatch(/No route to host|Connection timed out/);
  });

  it('la liste du routeur compte son refus — STRUCTUREL', async () => {
    const { client, router } = await labRoute(true);
    await client.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    expect(String(await router.executeCommand('show ip access-lists 100')))
      .toMatch(/deny tcp any host 10\.0\.30\.10 eq 22.*\([1-9]\d* match/);
  });

  it('l\'hote ne voit jamais la trame que le routeur a jetee — STRUCTUREL', async () => {
    const { client, server } = await labRoute(true);
    await client.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    const listing = String(await server.executeCommand('iptables -L INPUT -n -v'));
    const compteur = /^\s*(\d+)\s+\d+\s+REJECT/m.exec(listing)?.[1] ?? '0';
    expect(parseInt(compteur, 10),
      'le pare-feu de l\'hote a compte une trame qui ne lui est pas parvenue').toBe(0);
  });

  it('sans la liste, le meme laboratoire laisse l\'hote refuser — le CONTRE-TEMOIN', async () => {
    const { client, server } = await labRoute(false);
    const out = await client.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    expect(out).toMatch(/Connection refused/);
    const listing = String(await server.executeCommand('iptables -L INPUT -n -v'));
    const compteur = /^\s*(\d+)\s+\d+\s+REJECT/m.exec(listing)?.[1] ?? '0';
    expect(parseInt(compteur, 10), 'la trame n\'a pas atteint l\'hote').toBeGreaterThan(0);
  });

  it('`-j REJECT` nu : ICMP 3/3 -> Connection refused — NON-REGRESSION', async () => {
    const { client, server } = await lanPlat();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');
    const out = await client.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    expect(out).toMatch(/Connection refused/);
    expect(out).not.toMatch(/Connection timed out|No route to host/);
  });

  it('`-j DROP` : rien ne revient -> Connection timed out — NON-REGRESSION', async () => {
    const { client, server } = await lanPlat();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
    const out = await client.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    expect(out).toMatch(/Connection timed out/);
    expect(out).not.toMatch(/Connection refused/);
  });

  it('`--reject-with icmp-host-prohibited` : ICMP 3/10 -> No route to host', async () => {
    const { client, server } = await lanPlat();
    await server.executeCommand(
      'iptables -A INPUT -p tcp --dport 22 -j REJECT --reject-with icmp-host-prohibited');
    const out = await client.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    expect(out).toMatch(/No route to host/);
    expect(out).not.toMatch(/Connection refused/);
  });

  it('`--reject-with tcp-reset` : un RST -> Connection refused — NON-REGRESSION', async () => {
    const { client, server } = await lanPlat();
    await server.executeCommand(
      'iptables -A INPUT -p tcp --dport 22 -j REJECT --reject-with tcp-reset');
    const out = await client.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    expect(out).toMatch(/Connection refused/);
    expect(out).not.toMatch(/Connection timed out|No route to host/);
  });

  it('rien n\'ecoute : un RST -> Connection refused — NON-REGRESSION', async () => {
    const { client, server } = await lanPlat();
    await server.executeCommand('systemctl stop ssh');
    const out = await client.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    expect(out).toMatch(/Connection refused/);
    expect(out).not.toMatch(/No route to host/);
  });
});
