/**
 * Declarer une vue : le sous-mode, sa plateforme, et sa limite.
 *
 * Trois defauts mesures (audit §3, M9/M10/M11) qui tiennent tous au
 * moment ou l'on DECLARE une vue, la ou les etapes precedentes
 * portaient sur le moment ou l'on s'en sert.
 *
 * M10 — sur un Catalyst, `parser view NOC` etait accepte et CREAIT la
 * vue, mais `secret` et `commands exec include` etaient refuses :
 * `CiscoSwitchShell.getActiveTrie()` n'a pas de cas `config-view` et
 * retombait sur l'arbre UTILISATEUR. On obtenait donc une vue qui
 * existe, ne peut rien contenir, ne peut pas avoir de mot de passe, et
 * dans laquelle on peut entrer — une souriciere vide. Un refus franc de
 * `parser view` aurait mieux valu ; la faire fonctionner vaut mieux
 * encore.
 *
 * M11 — le sous-mode `config-view` n'etait pas confine :
 * `tryGlobalConfigNavigation` y laissait passer tout l'arbre de
 * configuration globale. Le prejudice mesure n'est PAS une elevation de
 * privilege — on n'atteint `config-view` que depuis la vue racine, donc
 * au niveau 15 — mais une CORRUPTION D'ETAT : `interface
 * GigabitEthernet0/0` y changeait de mode, si bien que le `exit` suivant
 * ne quittait plus la vue mais l'interface, et la definition restait a
 * moitie faite. C'est CE point, et lui seul, qui est corrige.
 *
 * Ce qui n'est PAS fait, et pourquoi : refuser aussi les commandes
 * globales qui ne changent pas de mode (`hostname`, `username`). La
 * documentation Cisco ne dit pas qu'IOS les refuse, et l'indice le plus
 * fort va dans l'autre sens — une configuration rendue enchaine les
 * vues puis les comptes SANS `exit` entre les deux, donc IOS doit
 * pouvoir les rejouer depuis ce sous-mode. Inventer un refus serait
 * aussi faux qu'inventer une ligne `exit` dans la configuration.
 *
 * M9 — aucune limite de vues. Cisco documente un maximum de 15 vues et
 * superviews, vue racine non comprise.
 *
 * Ce que la non-regression garde : depuis `config-if`, taper une
 * commande de configuration globale fonctionne toujours. C'est un
 * comportement REEL d'IOS, et le confinement de `config-view` ne doit
 * pas l'emporter avec lui.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const REFUS = '% Invalid input';
type Machine = CiscoRouter | CiscoSwitch;

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1', MACAddress.generate())],
  ['commutateur', () => new CiscoSwitch('SW1', MACAddress.generate())],
];

async function jouer(m: Machine, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await m.executeCommand(c);
  return derniere;
}

describe.each(PLATEFORMES)('M10 — une vue se declare vraiment — %s', (_n, fabrique) => {
  it('`secret` et `commands` sont acceptes dans le sous-mode', async () => {
    const m = fabrique();
    expect(await jouer(m, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view NOC', 'secret Vue@2026',
    ])).toBe('');
    expect(await m.executeCommand('commands exec include show version')).toBe('');
  });

  it('la vue contient ce qu on y a mis, et rien d autre', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view NOC', 'secret Vue@2026',
      'commands exec include show version', 'exit', 'end',
    ]);
    await m.executeCommand('enable view NOC', { passwordInput: 'Vue@2026' });
    expect(await m.executeCommand('show parser view')).toBe("Current view is 'NOC'");
    expect(await m.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await m.executeCommand('show ip route')).toContain(REFUS);
  });

  it('et son secret garde la porte', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view NOC', 'secret Vue@2026',
      'commands exec include show version', 'exit', 'end',
    ]);
    await m.executeCommand('enable view NOC', { passwordInput: 'FAUX' });
    expect(await m.executeCommand('show parser view')).toBe("Current view is 'root'");
  });

  it('elle se relit dans la configuration', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view NOC', 'secret Vue@2026',
      'commands exec include show version', 'exit', 'end',
    ]);
    const cfg = await m.executeCommand('show running-config');
    expect(cfg).toContain('parser view NOC');
    expect(cfg).toContain(' commands exec include show version');
    expect(cfg).not.toContain('Vue@2026');
  });
});

describe.each(PLATEFORMES)('M11 — le sous-mode est confine — %s', (_n, fabrique) => {
  it('une commande qui changerait de mode ne deplace pas la session', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal', 'aaa new-model', 'parser view NOC']);
    // Le message importe moins que la CONSEQUENCE : la session doit
    // rester dans la vue, ce que prouve la commande suivante du
    // sous-mode. Le nom d'interface differe d'une plateforme a l'autre,
    // donc on eprouve les deux.
    for (const nom of ['GigabitEthernet0/0', 'FastEthernet0/1']) {
      await m.executeCommand(`interface ${nom}`);
      expect(await m.executeCommand('commands exec include show version'), nom).toBe('');
    }
  });

  /**
   * La seule exception au confinement, et elle est imposee par le RENDU :
   * une configuration enchaine `parser view X`, ses lignes, `!`, puis
   * `parser view Y` — sans `exit` entre les deux. Refuser `parser view`
   * depuis le sous-mode rendrait la configuration de la machine NON
   * REJOUABLE a l'import d'une topologie.
   */
  it('`parser view` reste joignable depuis le sous-mode, pour que la config se rejoue', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view A', 'commands exec include show version',
      'parser view B', 'commands exec include show clock',
      'end',
    ]);
    const liste = await m.executeCommand('show parser view all');
    expect(liste).toContain('A');
    expect(liste).toContain('B');
    const cfg = await m.executeCommand('show running-config');
    expect(cfg).toContain(' commands exec include show version');
    expect(cfg).toContain(' commands exec include show clock');
  });

  it('`exit` ramene en configuration globale', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal', 'aaa new-model', 'parser view NOC', 'exit']);
    expect(await m.executeCommand('hostname APRES')).toBe('');
    await jouer(m, ['end']);
    expect(await m.executeCommand('show running-config')).toContain('hostname APRES');
  });

  // ── Non-régression : `config-if` garde la navigation globale ───────
  it('depuis `config-if`, une commande globale fonctionne toujours', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
    expect(await m.executeCommand('hostname DEPUIS-IF')).toBe('');
  });
});

describe('M9 — au plus 15 vues, vue racine non comprise', () => {
  async function vues(n: number): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1', MACAddress.generate());
    const cmds = ['enable', 'configure terminal', 'aaa new-model'];
    for (let i = 1; i <= n; i++) cmds.push(`parser view V${i}`, 'exit');
    await jouer(r, cmds);
    return r;
  }

  it('la quinzieme est acceptee', async () => {
    const r = await vues(15);
    await jouer(r, ['end']);
    expect(await r.executeCommand('show parser view all')).toContain('V15');
  });

  it('la seizieme est refusee, et n est PAS creee', async () => {
    const r = await vues(15);
    expect(await r.executeCommand('parser view V16')).toContain('maximum');
    await jouer(r, ['end']);
    const liste = await r.executeCommand('show parser view all');
    expect(liste).not.toContain('V16');
    expect(liste).toContain('V15');
  });

  it('la vue racine ne compte pas dans la limite', async () => {
    const r = await vues(15);
    await jouer(r, ['end']);
    await r.executeCommand('enable view');
    expect(await r.executeCommand('show parser view')).toBe("Current view is 'root'");
  });

  it('en retirer une libere une place', async () => {
    const r = await vues(15);
    await r.executeCommand('no parser view V1');
    expect(await r.executeCommand('parser view V16')).toBe('');
    await jouer(r, ['exit', 'end']);
    expect(await r.executeCommand('show parser view all')).toContain('V16');
  });

  it('re-entrer dans une vue EXISTANTE n est pas une creation', async () => {
    const r = await vues(15);
    expect(await r.executeCommand('parser view V7')).toBe('');
    expect(await r.executeCommand('commands exec include show version')).toBe('');
  });
});
