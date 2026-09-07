/**
 * Lot T4, troisieme piece : le commutateur recoit une horloge, et
 * l'entree `[horloge]` de `TODO.md` se referme.
 *
 * ── Ce qui a ete mesure avant correctif ──────────────────────────────
 *
 * L'entree disait « `clock timezone` y est inerte ». La mesure a trouve
 * TROIS manques la ou elle en annoncait un :
 *
 *     clock timezone CET 1                    accepte, sans effet
 *     clock summer-time CEST recurring …      accepte, sans effet
 *     clock set 12:00:00 15 Jul 2026          accepte, sans effet
 *
 *     show clock        AVANT: *14:59:22 UTC Mon Sep 7 2026  (l'heure
 *                              REELLE — la machine n'avait pas
 *                              d'horloge systeme du tout)
 *                       APRES: *14:00:00 CEST Wed Jul 15 2026
 *     running-config    AVANT: (aucune ligne clock)
 *                       APRES: clock timezone CET 1 0
 *                              clock summer-time CEST recurring …
 *
 * Il manquait donc le MAGASIN de fuseau, l'HORLOGE systeme, et le
 * RENDU. Les trois se masquaient : une horloge qu'on ne peut pas regler
 * affiche une heure plausible, et une configuration qui ne se rend pas
 * ne manque a personne tant que rien ne la relit.
 *
 * ── Le geste que `TODO.md` demandait ────────────────────────────────
 *
 * « Extraire la configuration d'horloge dans un porteur a part que les
 * deux plateformes tiennent — le second est le bon geste. » C'est fait :
 * `DeviceClockStore` vit dans `core/time`, la base `Switch` en tient un,
 * et le service de gestion du commutateur Huawei recoit CETTE instance
 * au lieu d'en fabriquer une seconde — sans quoi le lot aurait ferme un
 * defaut en ouvrant un doublon.
 *
 * Le precedent etait dans le meme fichier : `ip http server`, « accepte
 * puis perdu a l'enregistrement », referme par le MEME magasin que le
 * routeur. C'est la forme suivie ici.
 *
 * **Ce que le compilateur a trouve pour moi.** Rendre `DeviceClockConfig`
 * immuable a fait tomber vingt-et-une erreurs de type, une par site qui
 * ecrivait `config.timezone = …` a la main — quatre endroits, deux
 * constructeurs. Aucun n'aurait ete trouve en relisant.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Mesure : `git stash push -- src/network` fait tomber **7 des 8 cas**.
 * Le seul qui passe des deux cotes est nomme :
 *
 *   - « un commutateur neuf reste a UTC, sans ligne d'horloge » est a la
 *     fois le TEMOIN et la NON-REGRESSION. Avant le lot il passait pour
 *     la mauvaise raison — le commutateur repondait UTC parce qu'il
 *     n'avait pas d'horloge du tout. Il doit continuer de passer pour la
 *     BONNE : une horloge existe, son defaut est UTC, et un `show
 *     running-config` ne se met pas a porter une ligne que personne n'a
 *     tapee. Sa chute signalerait qu'on a donne une horloge au
 *     commutateur en salissant la configuration de tous les autres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function jouer(
  d: { executeCommand(c: string): Promise<string> }, lignes: string[],
): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

const REGLE = 'clock summer-time CEST recurring last Sun Mar 2:00 last Sun Oct 3:00';

async function catalyst(): Promise<CiscoSwitch> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal', 'clock timezone CET 1', REGLE, 'end']);
  return s;
}

describe('un Catalyst a desormais une horloge', () => {
  it('clock set la deplace vraiment', async () => {
    const s = await catalyst();
    await jouer(s, ['clock set 12:00:00 15 Jul 2026']);

    expect(await s.executeCommand('show clock')).toContain('Wed Jul 15 2026');
  }, 30000);

  it('en juillet elle porte le nom d_ete et le bon decalage', async () => {
    const s = await catalyst();
    await jouer(s, ['clock set 12:00:00 15 Jul 2026']);

    expect(await s.executeCommand('show clock')).toContain('14:00:00.000 CEST');
  }, 30000);

  it('en janvier elle revient a l_heure standard', async () => {
    const s = await catalyst();
    await jouer(s, ['clock set 12:00:00 15 Jan 2026']);

    expect(await s.executeCommand('show clock')).toContain('13:00:00.000 CET');
  }, 30000);

  it('show calendar dit la MEME heure que show clock', async () => {
    const s = await catalyst();
    await jouer(s, ['clock set 12:00:00 15 Jul 2026']);

    expect(await s.executeCommand('show calendar')).toContain('14:00:00 CEST');
  }, 30000);

  it('la configuration d_horloge SURVIT a l_enregistrement', async () => {
    const s = await catalyst();

    const conf = await s.executeCommand('show running-config');

    expect(conf).toContain('clock timezone CET 1 0');
    expect(conf).toContain(REGLE);
  }, 30000);

  it('un commutateur neuf reste a UTC, sans ligne d_horloge', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    s.powerOn();

    expect(await s.executeCommand('show clock')).toContain('UTC');
    expect(await s.executeCommand('show running-config')).not.toContain('clock timezone');
  }, 30000);
});

describe('le magasin est UNIQUE, pas un second a cote', () => {
  it('le commutateur Huawei et son service de gestion partagent la meme horloge', async () => {
    const s = new HuaweiSwitch('switch-huawei', 'SW1');
    s.powerOn();

    expect(s.getManagementService().getClockStore()).toBe(s.getDeviceClock());
  }, 30000);

  it('ce qu_une vue VRP pose, l_autre le lit', async () => {
    const s = new HuaweiSwitch('switch-huawei', 'SW1');
    s.powerOn();
    await jouer(s, ['system-view', 'clock timezone CET add 01:00:00']);

    expect(s.getDeviceClock().get().timezone).toBe('CET');
    expect(s.getDeviceClock().get().offsetMin).toBe(60);
  }, 30000);
});
