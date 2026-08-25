/**
 * `debug ip nat` a UN corps, pas deux.
 *
 * MESURE DE DEPART : `registerNATPrivilegedCommands` enregistrait
 * `debug ip nat` et `no debug ip nat` avec leur propre corps — il
 * allumait le moteur puis deleguait au service de debogage — et ce
 * corps n'a jamais repondu. C'est le repartiteur glouton `debug ip` de
 * `CiscoShellBase` qui sert la commande, et lui seul sait ecrire
 * `IP NAT detailed debugging is on` la ou le corps mort ecrivait
 * `IP NAT debugging is on for access list detailed`.
 *
 * DEUX CORPS POUR UNE COMMANDE, C'EST DEUX REPONSES POSSIBLES. Le
 * precedent lot de migration l'avait constate en faisant GAGNER le
 * corps mort — un cas de `debug-family-slice.test.ts` avait attrape le
 * changement de message — et l'avait ECARTE par un `skip` en attendant
 * que la famille du debogage soit reprise. Ce lot retire le corps mort
 * au lieu de continuer a l'ecarter, et le `skip` avec lui : il ne
 * restait plus que `clear ip nat` a declarer.
 *
 * CE QUE LA MESURE A CONFIRME AVANT SUPPRESSION : le corps mort ne
 * contribuait rien du tout, pas meme a l'aide. `debug ip nat ?` rend
 * `LINE rest` / `<cr>` AVANT comme APRES — sa liste `['detailed']` de
 * completions n'etait jamais rendue, la regle du socle ecartant un
 * mot-cle extrait sans description.
 *
 * DISCRIMINATION : le cas de STRUCTURE tombe avant correctif ; les cinq
 * cas de COMPORTEMENT passent des deux cotes, et c'est exactement ce
 * qu'ils doivent prouver — retirer un corps mort ne change rien de ce
 * que la machine repond. Sans eux, la suppression ne serait garantie
 * par personne.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { collectRegistrations } from '@/cli/commands/trieAdapter';
import { registerNATPrivilegedCommands } from '@/network/devices/shells/cisco/CiscoNATCommands';
import type { Router } from '@/network/devices/Router';
import type { CommandTrie } from '@/network/devices/shells/CommandTrie';

async function routeurEnMode(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  return r;
}

describe('la famille NAT ne declare aucun corps de debogage', () => {
  it('aucun chemin enregistre ne commence par `debug`', () => {
    const r = new CiscoRouter('R1');
    const chemins = collectRegistrations(
      (collector) => registerNATPrivilegedCommands(
        collector as unknown as CommandTrie, () => r as unknown as Router),
    ).map(e => e.path);

    expect(chemins.length).toBeGreaterThan(0);
    expect(chemins.filter(p => /(^|\s)debug\b/.test(p))).toEqual([]);
  });
});

describe('et le repartiteur repond toujours la meme chose', () => {
  it('la forme nue', async () => {
    expect(String(await (await routeurEnMode()).executeCommand('debug ip nat')))
      .toBe('IP NAT debugging is on');
  });

  it('la forme detaillee', async () => {
    expect(String(await (await routeurEnMode()).executeCommand('debug ip nat detailed')))
      .toBe('IP NAT detailed debugging is on');
  });

  it('la forme par liste de controle', async () => {
    expect(String(await (await routeurEnMode()).executeCommand('debug ip nat 10')))
      .toBe('IP NAT debugging is on for access list 10');
  });

  it('la negation', async () => {
    const r = await routeurEnMode();
    await r.executeCommand('debug ip nat detailed');
    expect(String(await r.executeCommand('no debug ip nat')))
      .toBe('IP NAT debugging is off');
  });

  it('et le moteur suit le drapeau', async () => {
    const r = await routeurEnMode();
    await r.executeCommand('debug ip nat detailed');
    expect(String(await r.executeCommand('show debugging'))).toContain('NAT');
    await r.executeCommand('no debug ip nat');
    expect(String(await r.executeCommand('show debugging')))
      .toBe('No debug flags are enabled');
  });
});
