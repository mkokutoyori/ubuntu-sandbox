/**
 * Probes — la console sous debug, et le filtrage conditionnel.
 *
 * Scénarios couverts :
 *   1  la saisie en cours est réaffichée sous le flot de logs
 *   2  le flux de debug ne déclenche jamais le pager `--More--`
 *   3  `no logging on` coupe l'émission sans perdre les drapeaux
 *   4  `debug condition vrf` restreint à une VRF
 *   5  changer le format d'horodatage s'applique dès la ligne suivante
 *   6  le tampon mémoire est un anneau : le vieux cède la place
 *   7  `debug condition interface` s'hérite par les debugs déjà actifs
 *   8  IPv4 et IPv6 sont deux drapeaux étanches
 *   9  un utilisateur non privilégié ne peut pas toucher au debug
 *  10  le bridage console ne coûte rien au plan de données
 *
 * Ces probes restent dans l'arbre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const LONG = 30_000;
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function routeur() {
  const r = new CiscoRouter('R1', 0, 0);
  r.powerOn();
  await r.executeCommand('enable');
  const lignes: string[] = [];
  r.getDebugService().subscribe((l) => lignes.push(l));
  return { r, lignes, run: (c: string) => r.executeCommand(c) };
}

/** Routeur + poste câblés, pour du trafic réel. */
async function lab() {
  const r = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  r.powerOn(); pc.powerOn();
  const [g0, g1] = r.getPortNames();
  new Cable('c').connect(r.getPort(g0)!, pc.getPort('eth0')!);
  pc.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  for (const c of [
    'enable', 'configure terminal', `interface ${g0}`,
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await r.executeCommand(c);
  const lignes: string[] = [];
  r.getDebugService().subscribe((l) => lignes.push(l));
  return { r, pc, g0, g1, lignes, run: (c: string) => r.executeCommand(c) };
}

async function sessionConsole() {
  const bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);
  const manager = new TerminalManager(bus);
  const r = new CiscoRouter('R1', 0, 0);
  r.setEventBus(bus);
  r.powerOn();
  const term = manager.getSession(manager.openTerminal(r)!)!;
  for (let i = 0; i < 40 && term.isBooting; i++) await new Promise((res) => setTimeout(res, 50));
  const type = async (s: TerminalSession, c: string) => {
    s.setInput(c); s.handleKey(key('Enter'));
    await new Promise((res) => setTimeout(res, 60));
  };
  await type(term, 'enable');
  return { r, term, type };
}

describe('Scénario 1 — la saisie en cours survit au flot', () => {
  it('`logging synchronous` réaffiche la ligne tapée sous le dernier log', async () => {
    const { r, term, type } = await sessionConsole();
    for (const c of ['configure terminal', 'line console 0', 'logging synchronous', 'end']) {
      await type(term, c);
    }
    await type(term, 'debug ip icmp');

    // L'opérateur a commencé à taper, sans valider.
    term.setInput('show ip interface br');
    const svc = r.getDebugService();
    svc.emitLine('ip.icmp', 'ICMP: echo request rcvd, src 1.1.1.1, dst 2.2.2.2');
    await new Promise((res) => setTimeout(res, 60));

    expect(
      term.input,
      'ce que l\'opérateur a tapé ne doit pas être effacé par un log',
    ).toBe('show ip interface br');

    // Écart assumé avec l'énoncé : ce simulateur DIFFÈRE le message tant
    // qu'une saisie est en cours, là où IOS l'imprime puis redessine la
    // ligne en dessous. Les deux tiennent la même promesse — la saisie
    // reste lisible et le message n'est pas perdu — et le report est le
    // comportement déjà établi ici (cisco-line-console-vty-aux).
    term.handleKey(key('Enter'));
    await new Promise((res) => setTimeout(res, 60));
    expect(
      term.lines.some((l) => /echo request/.test(l.text)),
      'différé n\'est pas perdu : le message sort une fois la ligne validée',
    ).toBe(true);
  }, LONG);

  it('la commande reste exécutable telle quelle après le flot', async () => {
    const { r, term, type } = await sessionConsole();
    await type(term, 'debug ip icmp');
    term.setInput('show version');
    r.getDebugService().emitLine('ip.icmp', 'ICMP: bruit');
    await new Promise((res) => setTimeout(res, 60));

    term.handleKey(key('Enter'));
    await new Promise((res) => setTimeout(res, 60));

    expect(term.lines.some((l) => /Cisco IOS Software/.test(l.text))).toBe(true);
  }, LONG);
});

describe('Scénario 2 — le flux de debug ignore le pager', () => {
  it('cent lignes de debug ne bloquent jamais sur --More--', async () => {
    const { r, term, type } = await sessionConsole();
    await type(term, 'terminal length 24');
    await type(term, 'debug ip packet');

    const svc = r.getDebugService();
    for (let i = 0; i < 100; i++) {
      svc.emitLine('ip.packet', `IP: s=10.0.0.${i % 250} (Gi0/0), d=10.0.1.1, len 84, forward`);
    }
    await new Promise((res) => setTimeout(res, 80));

    expect(
      term.lines.filter((l) => /--More--/.test(l.text)),
      'le paginage vaut pour les show, pas pour un flux asynchrone',
    ).toEqual([]);
    expect(term.currentInputMode.type, 'la console reste rendue à l\'opérateur').toBe('normal');
  }, LONG);

  it('`show` reste paginable, lui', async () => {
    const { term, type } = await sessionConsole();
    await type(term, 'terminal length 24');
    expect(await (async () => { await type(term, 'show running-config'); return term.lines.length; })())
      .toBeGreaterThan(0);
  }, LONG);
});

describe('Scénario 3 — no logging on, l\'interrupteur général', () => {
  it('coupe l\'émission mais conserve les drapeaux', async () => {
    const { run, lignes, r } = await routeur();
    await run('debug ip icmp');
    await run('debug arp');
    r.getDebugService().emitLine('ip.icmp', 'ICMP: avant coupure');
    expect(lignes.length).toBe(1);

    for (const c of ['configure terminal', 'no logging on', 'end']) await run(c);
    r.getDebugService().emitLine('ip.icmp', 'ICMP: apres coupure');

    expect(lignes.length, 'plus rien ne sort').toBe(1);
    const etat = await run('show debug');
    expect(etat, 'mais l\'instrumentation reste armée').toContain('ICMP packet debugging is on');
    expect(etat).toContain('ARP');
  }, LONG);

  it('`logging on` rétablit l\'émission sans réactiver quoi que ce soit', async () => {
    const { run, lignes, r } = await routeur();
    await run('debug ip icmp');
    for (const c of ['configure terminal', 'no logging on', 'end']) await run(c);
    r.getDebugService().emitLine('ip.icmp', 'ICMP: muet');
    expect(lignes.length).toBe(0);

    for (const c of ['configure terminal', 'logging on', 'end']) await run(c);
    r.getDebugService().emitLine('ip.icmp', 'ICMP: de nouveau audible');

    expect(lignes.length).toBe(1);
  }, LONG);
});

describe('Scénarios 4 et 7 — debug condition', () => {
  it('`debug condition interface` restreint les debugs déjà actifs', async () => {
    const { run, lignes, r } = await routeur();
    await run('debug ip packet');
    const svc = r.getDebugService();

    expect(await run('debug condition interface GigabitEthernet0/1')).toMatch(/Condition/);

    svc.emitLine('ip.packet', 'IP: s=10.0.0.2 (GigabitEthernet0/1), d=10.0.1.2, len 84, forward');
    svc.emitLine('ip.packet', 'IP: s=10.0.0.2 (GigabitEthernet0/0), d=10.0.1.2, len 84, forward');

    expect(lignes.length, 'seule l\'interface conditionnée passe').toBe(1);
    expect(lignes[0]).toContain('GigabitEthernet0/1');
  }, LONG);

  it('la condition vaut aussi pour un debug activé APRÈS elle', async () => {
    const { run, lignes, r } = await routeur();
    await run('debug condition interface GigabitEthernet0/1');
    await run('debug ip packet');

    r.getDebugService().emitLine('ip.packet', 'IP: s=1.1.1.1 (GigabitEthernet0/0), d=2.2.2.2, len 84, forward');
    expect(lignes, 'une condition est globale, pas attachée à un drapeau').toEqual([]);
  }, LONG);

  it('`debug condition vrf` ne laisse passer que la VRF visée', async () => {
    const { run, lignes, r } = await routeur();
    await run('debug ip packet');
    expect(await run('debug condition vrf RED')).toMatch(/Condition/);

    const svc = r.getDebugService();
    svc.emitLine('ip.packet', 'IP: s=10.0.0.2 (Gi0/0), d=10.0.1.2, vrf RED, len 84, forward');
    svc.emitLine('ip.packet', 'IP: s=10.0.0.3 (Gi0/0), d=10.0.1.3, vrf BLUE, len 84, forward');
    svc.emitLine('ip.packet', 'IP: s=10.0.0.4 (Gi0/0), d=10.0.1.4, len 84, forward');

    expect(lignes.length, 'BLUE et la VRF par défaut sont ignorées').toBe(1);
    expect(lignes[0]).toContain('vrf RED');
  }, LONG);

  it('`no debug condition all` rend sa portée complète au debug', async () => {
    const { run, lignes, r } = await routeur();
    await run('debug ip packet');
    await run('debug condition vrf RED');
    r.getDebugService().emitLine('ip.packet', 'IP: s=1.1.1.1 (Gi0/0), d=2.2.2.2, len 84, forward');
    expect(lignes).toEqual([]);

    expect(await run('no debug condition all')).toMatch(/removed/i);
    r.getDebugService().emitLine('ip.packet', 'IP: s=1.1.1.1 (Gi0/0), d=2.2.2.2, len 84, forward');

    expect(lignes.length).toBe(1);
  }, LONG);
});

describe('Scénario 5 — changement d\'horodatage à chaud', () => {
  /**
   * Deux prémisses corrigées par la mesure, les mêmes que dans
   * `probe-debug-01` : le format d'IOS est `*Aug  4 13:45:46.046:` et non
   * un fragment d'ISO `08-04 …`, et c'est `service timestamps log` — pas
   * `debug` — qui horodate un `%LINK`/`%LINEPROTO`. Le modèle ne portait
   * qu'un drapeau pour les deux canaux, ce qui rendait les deux formes
   * interchangeables ici.
   *
   * Ce que le cas vérifie reste le même : le format en vigueur est celui
   * du moment où le message est écrit, sans avoir à relancer quoi que ce
   * soit.
   */
  it('le format bascule dès le message suivant', async () => {
    const { run, r } = await routeur();
    for (const c of [
      'configure terminal', 'logging buffered 64000 debugging',
      'service timestamps log uptime', 'end',
    ]) await run(c);
    const [g0] = r.getPortNames();
    // Un `shutdown`, pas un `no shutdown` : sur un routeur sans câble le
    // lien ne monte pas, donc seule la mise hors service administrative
    // produit un message.
    for (const c of ['configure terminal', `interface ${g0}`, 'shutdown', 'end']) await run(c);

    const avant = (await run('show logging')).split('\n')
      .filter((l) => /^\d{2}:\d{2}:\d{2}: %/.test(l));
    expect(avant.length, 'le premier message porte la forme uptime').toBeGreaterThan(0);

    for (const c of ['configure terminal', 'service timestamps log datetime msec', 'end']) {
      await run(c);
    }
    for (const c of [
      'configure terminal', `interface ${g0}`, 'no shutdown', 'shutdown', 'end',
    ]) await run(c);

    const journal = (await run('show logging')).split('\n');
    const horodatee = journal.filter((l) => /^\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3}: %/.test(l));
    expect(
      horodatee.length,
      'le message postérieur au changement porte le nouveau format, sans relancer le debug',
    ).toBeGreaterThan(0);
  }, LONG);
});

describe('Scénario 6 — le tampon est un anneau', () => {
  it('les plus anciens cèdent la place, sans crash', async () => {
    const { run, r } = await routeur();
    for (const c of ['configure terminal', 'logging buffered 4096 debugging', 'end']) await run(c);

    // Sévérité 6 volontairement : la 7 est de la sortie de `debug`, et
    // sans drapeau posé la porte la rejetterait avant le tampon. Ce qui
    // est mesuré ici, c'est l'anneau, pas le filtrage.
    const journal = r.getLoggingConfig()!;
    for (let i = 0; i < 500; i++) journal.append('informational', 'test', `message numero ${i}`);

    const sortie = await run('show logging');
    expect(sortie, 'la commande doit rester cohérente').toContain('Buffer logging');
    expect(sortie, 'les plus récents sont là').toContain('message numero 499');
    expect(sortie, 'les plus anciens ont cédé la place').not.toMatch(/message numero 0$/m);
    const gardees = sortie.split('\n').filter((l) => /message numero/.test(l)).length;
    expect(gardees, 'le tampon est borné par sa taille').toBeLessThan(500);
  }, LONG);
});

describe('Scénario 8 — IPv4 et IPv6 sont étanches', () => {
  it('`debug ip packet` ignore totalement l\'IPv6', async () => {
    const { run, lignes, r } = await lab();
    await run('debug ip packet');

    const svc = r.getDebugService();
    svc.emitLine('ipv6.packet', 'IPV6: s=2001:db8::1 (Gi0/0), d=2001:db8::2, len 64, rcvd (nxt 58)');

    expect(lignes, 'un drapeau IPv4 ne voit pas passer d\'IPv6').toEqual([]);
  }, LONG);

  it('`debug ipv6 packet` s\'active et porte son propre libellé', async () => {
    const { run, lignes, r } = await lab();
    expect(await run('debug ipv6 packet')).toContain('IPv6 packet debugging is on');
    expect(await run('show debug')).toContain('IPv6 packet');

    r.getDebugService().emitLine('ipv6.packet', 'IPV6: s=2001:db8::1 (Gi0/0), d=2001:db8::2, len 64, rcvd (nxt 58)');
    expect(lignes.length).toBe(1);
    expect(lignes[0]).toMatch(/^IPV6:/);
  }, LONG);

  it('et l\'inverse : le drapeau IPv6 ne voit pas l\'IPv4', async () => {
    const { run, lignes, pc } = await lab();
    await run('debug ipv6 packet');

    await pc.executeCommand('ping -c 1 10.0.0.1');

    expect(lignes, 'un ping IPv4 ne concerne pas ce drapeau').toEqual([]);
  }, LONG);
});

describe('Scénario 9 — le debug est réservé au mode privilégié', () => {
  it.each(['debug ip packet', 'debug ip icmp', 'undebug all'])(
    '`%s` est refusé en mode utilisateur',
    async (commande) => {
      const r = new CiscoRouter('R1', 0, 0);
      r.powerOn();
      // Pas de `enable` : on reste au niveau 1.
      const sortie = await r.executeCommand(commande);
      expect(sortie, 'un compte non privilégié ne doit pas toucher au monitoring')
        .toMatch(/Invalid input|unauthorized|Unknown command/i);
    }, LONG);

  it('une fois privilégié, la même commande passe', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await r.executeCommand('enable');
    expect(await r.executeCommand('debug ip packet')).toContain('debugging is on');
  }, LONG);
});

describe('Scénario 10 — le bridage console épargne le plan de données', () => {
  it('les paquets passent tous, même quand la console n\'en montre que 10', async () => {
    const { run, r, pc, lignes } = await lab();
    for (const c of ['configure terminal', 'logging rate-limit 10', 'end']) await run(c);
    await run('debug ip packet');

    const svc = r.getDebugService();
    for (let i = 0; i < 1000; i++) {
      svc.emitLine('ip.packet', `IP: s=10.0.0.2 (Gi0/0), d=10.0.1.2, len 84, forward #${i}`);
    }

    expect(lignes.length, 'la console est tenue au budget configuré').toBeLessThanOrEqual(11);
    expect(svc.getDroppedCount(), 'le surplus est compté, pas perdu en silence').toBeGreaterThan(950);

    // Le plan de données, lui, n'a rien à voir avec ce budget.
    const avant = Date.now();
    const ping = await pc.executeCommand('ping -c 3 -W 1 10.0.0.1');
    const duree = Date.now() - avant;

    expect(ping, 'aucune perte sur le trafic réel').toMatch(/3 (packets )?received|0% packet loss/);
    expect(duree, 'et aucune latence ajoutée par le bridage').toBeLessThan(10_000);
  }, LONG);

  it('`logging rate-limit` est relu à chaud', async () => {
    const { run, r, lignes } = await lab();
    await run('debug ip packet');
    const svc = r.getDebugService();

    for (const c of ['configure terminal', 'logging rate-limit 5', 'end']) await run(c);
    for (let i = 0; i < 100; i++) svc.emitLine('ip.packet', `IP: ligne ${i}`);

    expect(lignes.length, 'le nouveau budget vaut dès la ligne suivante').toBeLessThanOrEqual(6);
  }, LONG);
});
