/**
 * Probes — le cycle de vie d'un debug : l'allumer, le lire, l'éteindre,
 * et ce qui doit rester vrai autour.
 *
 * Scénarios couverts :
 *   1  `undebug all` / `u all` coupent tout, d'un coup
 *   2  isolation par session : la console voit, la VTY non, sauf
 *      `terminal monitor`
 *   3  `show debug` dit précisément quoi est actif : protocole, ACL,
 *      niveau de détail
 *   4  un debug ne survit pas au `reload` et n'entre jamais en NVRAM
 *   5  `no debug X`, `undebug X` et `u X` sont la même commande
 *   6  la sévérité console filtre l'affichage sans vider le tampon
 *   7  modifier l'ACL en direct change immédiatement ce qui est tracé
 *   8  deux debugs qui se recouvrent ne dupliquent pas la même ligne
 *   9  une capture et un debug coexistent sans se gêner
 *  10  supprimer l'interface visée nettoie le debug, sans casser la CLI
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

async function routeurSeul(): Promise<{ r: CiscoRouter; run: (c: string) => Promise<string> }> {
  const r = new CiscoRouter('R1', 0, 0);
  r.powerOn();
  await r.executeCommand('enable');
  return { r, run: (c) => r.executeCommand(c) };
}

/** Routeur + poste câblés, pour produire du vrai trafic. */
async function lab() {
  const r = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  r.powerOn(); pc.powerOn();
  const [g0] = r.getPortNames();
  new Cable('c').connect(r.getPort(g0)!, pc.getPort('eth0')!);
  pc.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  for (const c of [
    'enable', 'configure terminal', `interface ${g0}`,
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await r.executeCommand(c);
  const lignes: string[] = [];
  r.getDebugService().subscribe((l) => lignes.push(l));
  return { r, pc, g0, lignes, run: (c: string) => r.executeCommand(c) };
}

describe('Scénario 1 — désactivation globale', () => {
  it.each(['undebug all', 'u all', 'no debug all'])(
    '`%s` coupe les cinq debugs d\'un coup',
    async (commande) => {
      const { run } = await routeurSeul();
      for (const d of ['debug ip icmp', 'debug ip packet', 'debug arp', 'debug ip routing', 'debug cdp']) {
        await run(d);
      }
      expect((await run('show debug')).split('\n').length,
        'les cinq drapeaux doivent être posés avant de couper').toBeGreaterThanOrEqual(5);

      expect(await run(commande)).toContain('All possible debugging has been turned off');
      expect(await run('show debug')).toBe('No debug flags are enabled');
    }, LONG);

  it('après la coupure, plus une ligne n\'est émise', async () => {
    const { run, pc, lignes } = await lab();
    await run('debug ip icmp');
    await pc.executeCommand('ping -c 1 10.0.0.1');
    const avant = lignes.length;
    expect(avant).toBeGreaterThan(0);

    await run('undebug all');
    await pc.executeCommand('ping -c 1 10.0.0.1');

    expect(lignes.length, 'l\'affichage s\'arrête sur-le-champ').toBe(avant);
  }, LONG);
});

describe('Scénario 2 — isolation par session', () => {
  /**
   * Portée assumée : les deux sessions ouvertes ici sont des consoles du
   * même équipement. Le simulateur n'expose pas encore de vraie ligne VTY
   * interactive pour le debug (tâche #53), donc ce qui est vérifié est la
   * règle que `terminal monitor` gouverne — par session, sans effet de
   * bord sur les autres — et non le transport SSH lui-même.
   */
  async function deuxSessions() {
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    const r = new CiscoRouter('R1', 0, 0);
    r.setEventBus(bus);
    r.powerOn();

    const a = manager.getSession(manager.openTerminal(r)!)!;
    const b = manager.getSession(manager.openTerminal(r)!)!;
    for (let i = 0; i < 40 && (a.isBooting || b.isBooting); i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    const key = (k: string): KeyEvent =>
      ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    const type = async (s: TerminalSession, c: string) => {
      s.setInput(c); s.handleKey(key('Enter'));
      await new Promise((res) => setTimeout(res, 60));
    };
    await type(a, 'enable');
    await type(b, 'enable');
    const voit = (s: TerminalSession, motif: RegExp) => s.lines.some((l) => motif.test(l.text));
    const emettre = async (texte: string) => {
      (r as unknown as { getDebugService: () => { emitLine: (c: string, l: string) => void } })
        .getDebugService().emitLine('ip.icmp', texte);
      await new Promise((res) => setTimeout(res, 60));
    };
    return { r, a, b, type, voit, emettre };
  }

  it('`terminal no monitor` coupe la session qui l\'a demandé', async () => {
    const { a, b, type, voit, emettre } = await deuxSessions();
    await type(a, 'debug ip icmp');
    await type(b, 'terminal monitor');
    await emettre('ICMP: echo request rcvd, src 1.1.1.1, dst 2.2.2.2');
    expect(voit(b, /echo request/), 'avec terminal monitor, B reçoit').toBe(true);

    await type(b, 'terminal no monitor');
    await emettre('ICMP: echo reply sent, src 2.2.2.2, dst 1.1.1.1');

    expect(voit(b, /echo reply/), 'après terminal no monitor, B ne reçoit plus').toBe(false);
  }, LONG);

  it('couper une session n\'affecte pas l\'autre', async () => {
    const { a, b, type, voit, emettre } = await deuxSessions();
    await type(a, 'debug ip icmp');
    await type(b, 'terminal monitor');
    await type(b, 'terminal no monitor');

    await emettre('ICMP: ligne temoin');

    expect(voit(b, /ligne temoin/), 'B s\'est tu').toBe(false);
    expect(voit(a, /ligne temoin/), 'A, lui, continue de voir').toBe(true);
  }, LONG);

  it('`terminal monitor` rallume le flux sur la session concernée', async () => {
    const { a, b, type, voit, emettre } = await deuxSessions();
    await type(a, 'debug ip icmp');
    await type(b, 'terminal no monitor');
    await emettre('ICMP: premiere');
    expect(voit(b, /premiere/)).toBe(false);

    await type(b, 'terminal monitor');
    await emettre('ICMP: seconde');

    expect(voit(b, /seconde/), 'le choix est réversible').toBe(true);
  }, LONG);
});

describe('Scénario 3 — intégrité de show debug', () => {
  it('liste le protocole, l\'ACL et le niveau de détail', async () => {
    const { run } = await routeurSeul();
    for (const c of [
      'configure terminal', 'ip access-list extended 100',
      '10 permit tcp any any eq 80', 'end',
    ]) await run(c);

    await run('debug ip packet 100 detail');

    const etat = await run('show debug');
    expect(etat, 'le protocole visé').toContain('IP packet');
    expect(etat, 'l\'ACL de filtrage').toContain('100');
    expect(etat, 'et le niveau de détail demandé').toMatch(/detail/i);
  }, LONG);

  // `show debug` ne dit plus « IP ICMP » mais regroupe par protocole et
  // écrit la phrase d'IOS, `ICMP packet debugging is on` — la réécriture
  // « Debug lot 3 » l'a rapprochée du vrai routeur. Les assertions de ce
  // fichier étaient restées sur l'ancienne étiquette, qu'aucun IOS
  // n'imprime ; elles portent maintenant sur la phrase, et non sur
  // l'en-tête de regroupement, qui n'est pas ce qu'elles vérifient.
  it('le debug coupé disparaît de la liste, les autres restent', async () => {
    const { run } = await routeurSeul();
    await run('debug ip icmp');
    await run('debug arp');
    expect(await run('show debug')).toContain('ICMP packet debugging is on');

    await run('no debug ip icmp');

    const etat = await run('show debug');
    expect(etat).not.toContain('ICMP packet debugging is on');
    expect(etat, 'couper l\'un ne coupe pas l\'autre').toContain('ARP');
  }, LONG);
});

describe('Scénario 4 — non-persistance au redémarrage', () => {
  it('aucune commande debug n\'est écrite en NVRAM', async () => {
    const { run } = await routeurSeul();
    await run('debug ip icmp');
    await run('debug ip packet');
    await run('copy running-config startup-config');

    const nvram = await run('show startup-config');
    const lignesDebug = nvram.split('\n').filter((l) => /^\s*(un)?debug\b/i.test(l));
    expect(lignesDebug, 'un debug est un état de session, pas de la configuration').toEqual([]);
  }, LONG);

  it('le running-config ne les porte pas non plus', async () => {
    const { run } = await routeurSeul();
    await run('debug ip icmp');

    const conf = await run('show running-config');
    expect(conf.split('\n').filter((l) => /^\s*(un)?debug\b/i.test(l))).toEqual([]);
  }, LONG);

  it('après reload, aucun debug n\'est actif', async () => {
    const { run } = await routeurSeul();
    await run('debug ip icmp');
    await run('debug arp');
    expect(await run('show debug')).not.toBe('No debug flags are enabled');

    await run('reload');
    await run('enable');

    expect(await run('show debug')).toBe('No debug flags are enabled');
  }, LONG);
});

describe('Scénario 5 — synonymes de la CLI', () => {
  it.each(['no debug ip icmp', 'undebug ip icmp', 'u ip icmp'])(
    '`%s` coupe le debug, sans erreur de syntaxe',
    async (commande) => {
      const { run } = await routeurSeul();
      await run('debug ip icmp');
      expect(await run('show debug')).toContain('ICMP packet debugging is on');

      const sortie = await run(commande);
      expect(sortie, 'la syntaxe doit être reconnue').not.toContain('Invalid input');
      expect(await run('show debug')).toBe('No debug flags are enabled');
    }, LONG);

  it('les trois formes donnent exactement la même réponse', async () => {
    const reponses: string[] = [];
    for (const commande of ['no debug arp', 'undebug arp', 'u arp']) {
      const { run } = await routeurSeul();
      await run('debug arp');
      reponses.push(await run(commande));
    }
    expect(new Set(reponses).size, 'trois orthographes, une seule commande').toBe(1);
  }, LONG);
});

describe('Scénario 6 — filtrage par sévérité', () => {
  it('`logging console warnings` tait la console sans vider le tampon', async () => {
    const { r, run, g0 } = await lab();
    const console: string[] = [];
    r.getLoggingConfig()!.subscribeConsole((l) => console.push(l));

    for (const c of [
      'configure terminal',
      'logging buffered 64000 debugging',
      'logging console warnings',
      'end',
    ]) await run(c);

    // %LINEPROTO-5 est de niveau 5 : sous le seuil « warnings » (4).
    for (const c of ['configure terminal', `interface ${g0}`, 'shutdown', 'no shutdown', 'end']) {
      await run(c);
    }

    expect(
      console.filter((l) => /%LINEPROTO-5/.test(l)),
      'la console filtrée reste propre',
    ).toEqual([]);
    expect(
      await run('show logging'),
      'mais le tampon, lui, garde tout',
    ).toContain('%LINEPROTO-5');
  }, LONG);

  it('sans filtre, la console reçoit le même message', async () => {
    const { r, run, g0 } = await lab();
    const console: string[] = [];
    r.getLoggingConfig()!.subscribeConsole((l) => console.push(l));

    for (const c of ['configure terminal', `interface ${g0}`, 'shutdown', 'no shutdown', 'end']) {
      await run(c);
    }

    expect(console.some((l) => /%LINEPROTO-5/.test(l))).toBe(true);
  }, LONG);
});

describe('Scénario 7 — mise à jour dynamique de l\'ACL de debug', () => {
  it('une ligne ajoutée à l\'ACL s\'applique sans relancer le debug', async () => {
    const { run, pc, lignes } = await lab();
    for (const c of [
      'configure terminal', 'ip access-list extended 101',
      '10 permit tcp any any eq 443', 'end',
    ]) await run(c);

    await run('debug ip packet 101');
    await pc.executeCommand('ping -c 1 10.0.0.1');
    expect(lignes.filter((l) => /ICMP|icmp/.test(l)),
      'ICMP n\'est pas dans l\'ACL : rien ne doit sortir').toEqual([]);

    // L'ACL s'élargit à l'ICMP, le debug reste allumé.
    for (const c of [
      'configure terminal', 'ip access-list extended 101',
      '20 permit icmp any any', 'end',
    ]) await run(c);

    await pc.executeCommand('ping -c 1 10.0.0.1');

    expect(
      lignes.length,
      'le moteur doit relire l\'ACL à chaque paquet, pas la figer à l\'activation',
    ).toBeGreaterThan(0);
  }, LONG);
});

describe('Scénario 8 — pas de doublon quand deux debugs se recouvrent', () => {
  it('un paquet ICMP n\'apparaît pas deux fois pour la même ligne', async () => {
    const { run, pc, lignes } = await lab();
    await run('debug ip packet');
    await run('debug ip icmp');

    await pc.executeCommand('ping -c 1 10.0.0.1');

    const doublons = lignes.filter((l, i) => lignes.indexOf(l) !== i);
    expect(
      doublons,
      'les deux drapeaux décrivent le même paquet sous deux angles, ils ne le répètent pas',
    ).toEqual([]);
  }, LONG);

  it('chaque drapeau garde sa propre voix', async () => {
    const { run, pc, lignes } = await lab();
    await run('debug ip packet');
    await run('debug ip icmp');

    await pc.executeCommand('ping -c 1 10.0.0.1');

    expect(lignes.some((l) => l.startsWith('IP:')), 'la vue paquet').toBe(true);
    expect(lignes.some((l) => l.startsWith('ICMP:')), 'et la vue ICMP').toBe(true);
  }, LONG);
});

describe('Scénario 9 — capture et debug coexistent', () => {
  it('activer un debug n\'altère pas une capture en cours', async () => {
    const { run, pc } = await lab();
    const capture = await pc.executeCommand('sudo tcpdump -i eth0 -c 2 -w /tmp/c1.cap');
    expect(capture, 'la capture doit démarrer').not.toContain('command not found');

    await run('debug ip packet');
    await pc.executeCommand('ping -c 2 10.0.0.1');

    const relecture = await pc.executeCommand('sudo tcpdump -r /tmp/c1.cap');
    expect(
      relecture,
      'le fichier de capture reste lisible malgré le debug allumé',
    ).not.toContain('No such file');
  }, LONG);

  it('et la capture n\'éteint pas le debug', async () => {
    const { run, pc, lignes } = await lab();
    await run('debug ip icmp');
    await pc.executeCommand('sudo tcpdump -i eth0 -c 1 -w /tmp/c2.cap');
    await pc.executeCommand('ping -c 1 10.0.0.1');

    expect(await run('show debug')).toContain('ICMP packet debugging is on');
    expect(lignes.length, 'le debug continue de produire').toBeGreaterThan(0);
  }, LONG);
});

describe('Scénario 10 — cohérence après suppression d\'interface', () => {
  it('supprimer l\'interface visée nettoie le debug qui la ciblait', async () => {
    const { run } = await routeurSeul();
    for (const c of ['configure terminal', 'interface Tunnel0', 'exit', 'end']) await run(c);

    await run('debug interface Tunnel0');
    expect(await run('show debug')).toContain('Tunnel0');

    await run('configure terminal');
    expect(await run('no interface Tunnel0'), 'la commande doit être reconnue').not.toContain('Invalid input');
    await run('end');

    expect(
      await run('show debug'),
      'un drapeau visant une interface disparue n\'a plus de sens',
    ).toBe('No debug flags are enabled');
  }, LONG);

  it('la CLI reste vivante après la suppression', async () => {
    const { run } = await routeurSeul();
    for (const c of ['configure terminal', 'interface Tunnel0', 'exit'] ) await run(c);
    await run('no interface Tunnel0');
    await run('end');

    expect(await run('show ip interface brief')).not.toContain('Tunnel0');
    expect(await run('show version')).toContain('Cisco IOS Software');
    expect(await run('show debug')).toBe('No debug flags are enabled');
  }, LONG);

  it('une interface physique ne se supprime pas', async () => {
    const { run, r } = await routeurSeul();
    const [g0] = r.getPortNames();
    await run('configure terminal');

    expect(
      await run(`no interface ${g0}`),
      'le matériel ne s\'enlève pas par la CLI',
    ).toContain('Invalid input');
    await run('end');
    expect(await run('show ip interface brief')).toContain(g0);
  }, LONG);
});
