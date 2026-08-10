/**
 * Sondes — le système de fichiers IOS et le registre de configuration.
 *
 * Priorité 3 de `docs/audit/11-transcripts-debug-2026-08.md`. Elle avait
 * été livrée SANS test, et c'est précisément ce qui a laissé passer le
 * défaut que ce fichier ferme :
 *
 * `show boot` était inscrit **deux fois** dans l'arbre de commandes — une
 * vieille version figée (`showBoot()` de `CiscoCommonShow`, qui rendait
 * « Configuration register is 0x2102 » en dur) et la nouvelle, branchée
 * sur le magasin vivant. `CommandTrie` laisse silencieusement la dernière
 * inscription écraser la précédente, et la figée était déclarée plus
 * tard : `show boot` répondait donc toujours **0x2102**, y compris après
 * `config-register 0x2142`, c'est-à-dire pile dans l'exercice de
 * récupération de mot de passe que la priorité 3 visait. `show bootvar`,
 * lui, disait 0x2142 : deux commandes synonymes qui se contredisaient.
 *
 * `command-trie-hygiene.test.ts` a attrapé le doublon ; la vieille
 * fonction a été supprimée plutôt qu'ajoutée à la liste d'exceptions —
 * elle ne pouvait rien dire de vrai sur un registre modifiable.
 *
 * Les cas ci-dessous couvrent en plus ce que la priorité 3 a livré et que
 * rien ne vérifiait : le magasin est bien **par équipement** et
 * **persistant** (supprimer un fichier le retire des vues suivantes), et
 * le bit 0x40 est le seul qui compte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function routeurPrivilegie(nom = 'R1'): Promise<CiscoRouter> {
  const r = new CiscoRouter(nom);
  await r.executeCommand('enable');
  return r;
}

describe('Scénario 1 — `show boot` suit le registre, il ne le récite pas', () => {
  it('les deux orthographes disent la même chose au départ', async () => {
    const r = await routeurPrivilegie();
    const boot = await r.executeCommand('show boot');
    expect(await r.executeCommand('show bootvar')).toBe(boot);
    expect(boot).toContain('Configuration register is 0x2102');
  });

  /**
   * Ce cas attendait le nouveau registre TOUT DE SUITE. Un vrai IOS ne
   * le change qu'au redémarrage suivant et le dit — c'est la raison
   * d'être de la manœuvre de récupération de mot de passe : on pose
   * 0x2142 puis on recharge, et poser la valeur ne saute rien par soi.
   * Ce que la sonde garde, c'est que les deux orthographes disent la
   * même chose ; ce qu'elle ajoute, c'est qu'après le rechargement la
   * valeur en attente est devenue la valeur courante.
   */
  it('`config-register 0x2142` change ce que LES DEUX annoncent', async () => {
    const r = await routeurPrivilegie();
    await r.executeCommand('configure terminal');
    await r.executeCommand('config-register 0x2142');
    await r.executeCommand('exit');
    const attendu = 'Configuration register is 0x2102 (will be 0x2142 at next reload)';
    expect(await r.executeCommand('show boot')).toContain(attendu);
    expect(await r.executeCommand('show bootvar')).toContain(attendu);

    await r.executeCommand('reload');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show boot')).toContain('Configuration register is 0x2142');
    expect(await r.executeCommand('show bootvar')).toContain('Configuration register is 0x2142');
  });

  it('le bit 0x40 est le seul qui décide d\'ignorer nvram:', async () => {
    const r = await routeurPrivilegie();
    await r.executeCommand('configure terminal');
    await r.executeCommand('config-register 0x2102');
    await r.executeCommand('exit');
    expect(await r.executeCommand('show boot')).toContain('0x2102');
    await r.executeCommand('configure terminal');
    await r.executeCommand('config-register 0x2142');
    await r.executeCommand('exit');
    expect(await r.executeCommand('show boot')).toContain('0x2142');
  });

  it('`boot system` se voit dans la variable BOOT', async () => {
    const r = await routeurPrivilegie();
    const avant = await r.executeCommand('show boot');
    expect(avant).toContain('BOOT variable = ');
    await r.executeCommand('configure terminal');
    await r.executeCommand('boot system flash:c2900.bin');
    await r.executeCommand('exit');
    expect(await r.executeCommand('show boot')).toContain('flash:c2900.bin');
  });
});

describe('Scénario 2 — flash: est un vrai magasin, pas un tableau recalculé', () => {
  it('`dir` et `show flash:` listent le même contenu', async () => {
    const r = await routeurPrivilegie();
    const dir = await r.executeCommand('dir');
    const flash = await r.executeCommand('show flash:');
    const nomsDe = (t: string) => t.split('\n')
      .map((l) => l.trim().split(/\s+/).pop() ?? '')
      .filter((n) => n.includes('.'));
    expect(nomsDe(dir)).toEqual(nomsDe(flash));
  });

  it('supprimer un fichier le retire vraiment, et des deux vues', async () => {
    const r = await routeurPrivilegie();
    const nom = (await r.executeCommand('dir')).split('\n')
      .map((l) => l.trim().split(/\s+/).pop() ?? '')
      .find((n) => n.endsWith('.bin'));
    expect(nom).toBeTruthy();
    await r.executeCommand(`delete flash:${nom}`);
    expect(await r.executeCommand('dir')).not.toContain(nom!);
    expect(await r.executeCommand('show flash:')).not.toContain(nom!);
  });

  it('supprimer un fichier absent est signalé, pas ignoré', async () => {
    const r = await routeurPrivilegie();
    expect(await r.executeCommand('delete flash:nexistepas.bin'))
      .toContain('No such file or directory');
  });

  it('le magasin est PAR ÉQUIPEMENT : R2 garde ce que R1 a supprimé', async () => {
    const r1 = await routeurPrivilegie('R1');
    const r2 = await routeurPrivilegie('R2');
    const nom = (await r1.executeCommand('dir')).split('\n')
      .map((l) => l.trim().split(/\s+/).pop() ?? '')
      .find((n) => n.endsWith('.bin'))!;
    await r1.executeCommand(`delete flash:${nom}`);
    expect(await r1.executeCommand('dir')).not.toContain(nom);
    expect(await r2.executeCommand('dir')).toContain(nom);
  });

  it('`pwd` répond flash:, comme sur le vrai', async () => {
    const r = await routeurPrivilegie();
    expect(await r.executeCommand('pwd')).toBe('flash:');
  });
});
