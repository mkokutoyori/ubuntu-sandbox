/**
 * Probes — le coeur de la sortie `debug` d'un routeur.
 *
 * Scénarios couverts ici :
 *   1  `debug ip icmp` trace les Echo Request/Reply avec src/dst et type
 *   2  `debug ip packet <ACL>` ne trace que ce que l'ACL retient
 *   7  la ligne dit POURQUOI un paquet est rejeté
 *   8  `debug ip nat` montre la translation exacte de l'en-tête
 *   9  un flux massif ne fait pas tomber le simulateur : il est bridé,
 *      et la perte est annoncée
 *  10  `service timestamps log datetime msec` préfixe chaque ligne, et le
 *      canal `debug` ne couvre pas le canal `log`
 *  11  `debug ip ospf events` n'expose que le plan de contrôle
 *
 * Ces probes restent dans l'arbre : elles décrivent le contrat de la
 * fonction debug, pas un incident ponctuel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const LONG = 30_000;

interface Lab {
  routeur: CiscoRouter;
  poste: LinuxPC;
  distant: LinuxPC;
  /** Port interne (côté PC1) et externe (côté PC2). */
  gIn: string;
  gOut: string;
  lignes: string[];
  run: (cmd: string) => Promise<string>;
}

/** Deux LAN de part et d'autre du routeur, pour que le trafic transite. */
async function lab(): Promise<Lab> {
  const routeur = new CiscoRouter('R1', 0, 0);
  const poste = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const distant = new LinuxPC('linux-pc', 'PC2', 0, 0);
  routeur.powerOn(); poste.powerOn(); distant.powerOn();

  const [g0, g1] = routeur.getPortNames();
  new Cable('c1').connect(routeur.getPort(g0)!, poste.getPort('eth0')!);
  new Cable('c2').connect(routeur.getPort(g1)!, distant.getPort('eth0')!);

  for (const c of [
    'enable', 'configure terminal',
    `interface ${g0}`, 'ip address 10.0.0.1 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
    `interface ${g1}`, 'ip address 10.0.1.1 255.255.255.0', 'ip nat outside', 'no shutdown', 'end',
  ]) await routeur.executeCommand(c);

  poste.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  distant.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  await poste.executeCommand('sudo ip route add default via 10.0.0.1');
  await distant.executeCommand('sudo ip route add default via 10.0.1.1');

  const lignes: string[] = [];
  routeur.getDebugService().subscribe((l) => lignes.push(l));
  return { routeur, poste, distant, gIn: g0, gOut: g1, lignes, run: (c) => routeur.executeCommand(c) };
}

describe('Scénario 1 — debug ip icmp', () => {
  it('trace la requête et la réponse avec leurs adresses', async () => {
    const { run, poste, lignes } = await lab();
    expect(await run('debug ip icmp')).toBe('IP ICMP debugging is on');

    await poste.executeCommand('ping -c 1 10.0.0.1');

    const req = lignes.find((l) => /echo request/.test(l));
    const rep = lignes.find((l) => /echo reply/.test(l));
    expect(req, 'la requête doit être tracée').toBeDefined();
    expect(req).toContain('src 10.0.0.2');
    expect(req).toContain('dst 10.0.0.1');
    expect(rep, 'la réponse aussi').toBeDefined();
    expect(rep).toContain('src 10.0.0.1');
  }, LONG);

  it('ne trace rien tant que le debug n\'est pas actif', async () => {
    const { poste, lignes } = await lab();
    await poste.executeCommand('ping -c 1 10.0.0.1');
    expect(lignes).toEqual([]);
  }, LONG);
});

describe('Scénario 2 — filtrage du debug par ACL', () => {
  it('ne retient que le trafic que l\'ACL permet', async () => {
    const { run, poste, lignes } = await lab();
    for (const c of [
      'configure terminal',
      'ip access-list extended DEBUG-HTTP',
      '10 permit tcp any any eq 80',
      'end',
    ]) await run(c);

    expect(await run('debug ip packet DEBUG-HTTP')).toContain('access list DEBUG-HTTP');

    // ICMP ne répond pas au critère : il ne doit rien produire.
    await poste.executeCommand('ping -c 2 10.0.1.2');

    expect(
      lignes.filter((l) => /ICMP|icmp/.test(l)),
      'le trafic hors ACL doit rester muet',
    ).toEqual([]);
  }, LONG);

  it('l\'ACL de debug est bien rattachée au drapeau, visible dans show debugging', async () => {
    const { run } = await lab();
    for (const c of [
      'configure terminal', 'ip access-list extended DEBUG-HTTP',
      '10 permit tcp any any eq 80', 'end',
    ]) await run(c);
    await run('debug ip packet DEBUG-HTTP');

    expect(await run('show debugging')).toContain('DEBUG-HTTP');
  }, LONG);
});

describe('Scénario 7 — la cause du rejet est explicite', () => {
  it('une destination sans route est annoncée `unroutable`', async () => {
    const { run, poste, lignes } = await lab();
    await run('debug ip packet');

    await poste.executeCommand('ping -c 2 203.0.113.9');

    expect(lignes.some((l) => l.includes('unroutable'))).toBe(true);
  }, LONG);

  it('un paquet refusé par une ACL est annoncé `access denied`', async () => {
    const { run, poste, lignes, gIn } = await lab();
    for (const c of [
      'configure terminal',
      'ip access-list extended BLOQUE',
      '10 deny ip host 10.0.0.2 any',
      '20 permit ip any any',
      'exit',
      `interface ${gIn}`, 'ip access-group BLOQUE in', 'end',
    ]) await run(c);
    await run('debug ip packet');

    await poste.executeCommand('ping -c 2 10.0.1.2');

    expect(lignes.some((l) => l.includes('access denied'))).toBe(true);
  }, LONG);
});

describe('Scénario 8 — traçabilité des translations NAT', () => {
  it('affiche la transformation de l\'en-tête, source puis destination', async () => {
    const { run, poste, lignes, gOut } = await lab();
    for (const c of [
      'configure terminal',
      'ip access-list standard LAN-INTERNE',
      '10 permit 10.0.0.0 0.0.0.255',
      'exit',
      `ip nat inside source list LAN-INTERNE interface ${gOut} overload`,
      'end',
    ]) await run(c);

    await run('debug ip nat');
    await poste.executeCommand('ping -c 1 -W 1 10.0.1.2');

    const nat = lignes.filter((l) => l.startsWith('NAT'));
    expect(nat.length, 'la translation doit être tracée').toBeGreaterThan(0);
    expect(
      nat.join('\n'),
      'la ligne IOS porte s=<local>-><global> puis la destination',
    ).toMatch(/NAT\*?: s=10\.0\.0\.2->10\.0\.1\.1/);
    expect(nat.join('\n'), 'et la destination du paquet').toMatch(/d=10\.0\.1\.2/);
  }, LONG);
});

describe('Scénario 9 — le debug sous charge est bridé, pas mortel', () => {
  it('un flux massif ne bloque pas et la perte est annoncée', async () => {
    const { run, routeur, lignes } = await lab();
    await run('debug ip packet');
    const svc = routeur.getDebugService();
    svc.setRateLimit(100);

    const debut = Date.now();
    for (let i = 0; i < 50_000; i++) {
      svc.emitLine('ip.packet', `IP: s=10.0.0.2 (Gi0/0), d=10.0.1.2, len 84, forward`);
    }
    const duree = Date.now() - debut;

    expect(lignes.length, 'la console est bridée, pas noyée').toBeLessThanOrEqual(110);
    expect(svc.getDroppedCount(), 'le reste est compté comme perdu').toBeGreaterThan(49_000);
    expect(duree, 'et 50 000 lignes ne doivent pas figer le simulateur').toBeLessThan(5_000);

    svc.flushDrops();
    expect(
      lignes.join('\n'),
      'une perte silencieuse ferait lire une trace tronquée comme complète',
    ).toMatch(/dropped by rate limiting/);
  }, LONG);

  it('sous le seuil, rien n\'est perdu', async () => {
    const { run, routeur, lignes } = await lab();
    await run('debug ip packet');
    const svc = routeur.getDebugService();
    svc.setRateLimit(1000);

    for (let i = 0; i < 50; i++) svc.emitLine('ip.packet', `IP: ligne ${i}`);

    expect(lignes.length).toBe(50);
    expect(svc.getDroppedCount()).toBe(0);
  }, LONG);
});

describe('Scénario 10 — horodatage à la milliseconde', () => {
  /**
   * Deux prémisses de ce cas étaient fausses, et la mesure les a corrigées.
   *
   *  1. Le format attendu était `08-04 13:45:46.046: %…`, un fragment
   *     d'ISO. IOS écrit `*Aug  4 13:45:46.046: %…` : mois abrégé, jour
   *     cadré sur deux colonnes, et `*` tant que l'horloge n'est pas
   *     autoritaire.
   *  2. Le message inspecté est un `%LINEPROTO-5-UPDOWN`, c'est-à-dire du
   *     syslog, pas de la sortie de `debug`. Sur IOS, `service timestamps
   *     debug` ne l'horodate pas — c'est `service timestamps log` qui le
   *     fait. Le modèle ne portait alors qu'un seul drapeau pour les deux
   *     canaux, ce qui masquait la distinction.
   */
  const HORODATAGE_MSEC = /^\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3}: %/;

  it('`service timestamps log datetime msec` préfixe les messages', async () => {
    const { run, gIn } = await lab();
    for (const c of [
      'configure terminal',
      'service timestamps log datetime msec',
      'logging buffered 64000 debugging',
      'end',
    ]) await run(c);

    for (const c of ['configure terminal', `interface ${gIn}`, 'shutdown', 'no shutdown', 'end']) {
      await run(c);
    }

    const journal = await run('show logging');
    // La DERNIÈRE : le montage du lab a déjà produit des messages de lien
    // avant que l'horodatage soit configuré, et le tampon les garde tels
    // qu'ils ont été écrits.
    const lignes = journal.split('\n').filter((l) => l.includes('%LINK') || l.includes('%LINEPROTO'));
    expect(lignes.length, 'il faut au moins un message à horodater').toBeGreaterThan(0);
    expect(
      lignes.at(-1),
      'datetime msec = date, heure, et millièmes',
    ).toMatch(HORODATAGE_MSEC);
  }, LONG);

  it('`service timestamps debug` seul n\'horodate pas le syslog', async () => {
    const { run, gIn } = await lab();
    for (const c of [
      'configure terminal',
      'service timestamps debug datetime msec',
      'logging buffered 64000 debugging',
      'end',
    ]) await run(c);

    for (const c of ['configure terminal', `interface ${gIn}`, 'shutdown', 'no shutdown', 'end']) {
      await run(c);
    }

    const journal = await run('show logging');
    const lignes = journal.split('\n').filter((l) => l.includes('%LINK') || l.includes('%LINEPROTO'));
    expect(lignes.length, 'il faut au moins un message à examiner').toBeGreaterThan(0);
    expect(lignes.at(-1), 'le canal debug ne couvre pas le canal log').toMatch(/^%[A-Z]/);
  }, LONG);

  it('sans l\'option, aucun préfixe d\'horodatage', async () => {
    const { run, gIn } = await lab();
    await run('configure terminal');
    await run('logging buffered 64000 debugging');
    for (const c of ['configure terminal', `interface ${gIn}`, 'shutdown', 'no shutdown', 'end']) {
      await run(c);
    }

    const ligne = (await run('show logging')).split('\n').find((l) => l.includes('%LINK'));
    expect(ligne).toBeDefined();
    expect(ligne!.trimStart().startsWith('%')).toBe(true);
  }, LONG);
});

describe('Scénario 11 — debug ip ospf events isole le plan de contrôle', () => {
  it('trace les événements OSPF et rien du plan de données', async () => {
    const routeurA = new CiscoRouter('RA', 0, 0);
    const routeurB = new CiscoRouter('RB', 0, 0);
    routeurA.powerOn(); routeurB.powerOn();
    new Cable('ospf').connect(routeurA.getPorts()[0], routeurB.getPorts()[0]);

    for (const [r, ip] of [[routeurA, '10.10.0.1'], [routeurB, '10.10.0.2']] as const) {
      for (const c of [
        'enable', 'configure terminal',
        `interface ${r.getPortNames()[0]}`,
        `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit',
        'router ospf 1', `network ${ip} 0.0.0.0 area 0`, 'end',
      ]) await r.executeCommand(c);
    }

    const lignes: string[] = [];
    routeurA.getDebugService().subscribe((l) => lignes.push(l));
    await routeurA.executeCommand('debug ip ospf events');
    // L'adjacence est déjà formée : il faut la perturber pour produire des
    // événements, sinon le drapeau n'a rien à tracer.
    for (const c of [
      'configure terminal', `interface ${routeurA.getPortNames()[0]}`,
      'shutdown', 'no shutdown', 'end',
    ]) await routeurA.executeCommand(c);
    await routeurA.executeCommand('show ip ospf neighbor');

    expect(lignes.length, 'l\'adjacence doit produire des événements').toBeGreaterThan(0);
    expect(lignes.every((l) => l.startsWith('OSPF')),
      'seul le plan de contrôle OSPF doit sortir sur ce drapeau').toBe(true);
    expect(lignes.some((l) => /IP: s=/.test(l)),
      'aucune ligne de plan de données ne doit fuiter ici').toBe(false);
  }, LONG);
});
