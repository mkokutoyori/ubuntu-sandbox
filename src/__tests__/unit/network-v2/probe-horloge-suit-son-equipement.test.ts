/**
 * Lot T4 du `docs/PRD-Geographie-Et-Temps-Local.md`, seconde piece : les
 * vues d'heure des deux constructeurs se branchent sur l'horloge de leur
 * machine, et la regle d'heure d'ete cesse d'etre un decor.
 *
 * ── Ce qui a ete mesure avant correctif ──────────────────────────────
 *
 * Cisco, `clock timezone CET 1` + `clock summer-time CEST recurring
 * last Sun Mar 2:00 last Sun Oct 3:00`, puis `clock set 12:00:00` :
 *
 *     15 juillet    AVANT: 13:00:00 CET     APRES: 14:00:00 CEST
 *     15 janvier    AVANT: 13:00:00 CET     APRES: 13:00:00 CET
 *
 * Six mois sur douze etaient faux. Avec un decalage explicite — la
 * meme regle suivie de `120` :
 *
 *     15 juillet    AVANT: 13:00:00 CET     APRES: 15:00:00 CEST
 *     running-config  AVANT: … Oct 3:00     APRES: … Oct 3:00 120
 *
 * Le `120` etait analyse, borne a [1,1440] par le parseur, puis JETE —
 * et il n'etait meme pas rendu, donc un import de topologie le perdait.
 * Ni honore ni conserve : le pire des trois etats.
 *
 * VRP, meme laboratoire :
 *
 *     clock datetime 12:00:00 2026-07-15
 *     display clock   AVANT: 2026-09-07 14:04 (l'heure du NAVIGATEUR)
 *                     APRES: 2026-07-15 13:00
 *
 * `display clock` lisait `new Date()` sur le routeur comme sur le
 * commutateur, alors que `getSystemClockMs()` existe et que Cisco s'en
 * sert depuis un lot precedent. Et `clock datetime` ne posait rien : la
 * commande etait acceptee, la vue montrait l'heure reelle, et les deux
 * trous se masquaient l'un l'autre — on pouvait regler l'horloge et la
 * relire sans qu'aucune des deux ne parle a la machine.
 *
 * Enfin la regle VRP etait MUTILEE au rangement :
 *
 *     tape    CEST repeating 02:00 last Sun Mar 03:00 last Sun Oct 60
 *     range   daylightStart="02:00 last Sun"  daylightEnd="03:00 last Sun"
 *
 * Le mois et le decalage disparaissaient, et le `running-config`
 * recrachait la bouillie : un aller-retour de topologie CORROMPAIT la
 * configuration. `configureClock` decoupait positionnellement
 * (`args.slice(3, 6)`) sans rien valider, seconde grammaire pour un fait
 * dont `clockSummerTime.ts` portait deja la premiere.
 *
 * ── Ce que ce lot ne ferme pas, et pourquoi ──────────────────────────
 *
 * Un Catalyst n'a toujours pas d'horloge : `clock timezone CET 1` y est
 * accepte en silence et `show clock` repond `UTC`. L'entree de
 * `TODO.md` reste ouverte — elle demande d'extraire le magasin
 * d'horloge du service de gestion, ce que ce lot prepare sans le faire.
 *
 * Et la convention de BORD reste assumee plutot que sourcee :
 * `cisco.com` et `support.huawei.com` sont injoignables depuis cet
 * environnement. Voir l'entree `TODO.md` correspondante.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Mesure, et non prediction : `git stash push -- src/network` fait
 * tomber **10 des 12 cas**. Les 2 qui passent des deux cotes sont
 * nommes :
 *
 *   - « en janvier, show clock reste a l'heure standard » est le TEMOIN
 *     et le cas de NON-REGRESSION a la fois. C'etait la seule reponse
 *     juste avant le lot — l'heure d'ete etant ignoree, tout etait rendu
 *     en heure standard — et elle devait le rester. Sans lui, un
 *     laboratoire casse et une regle mal evaluee seraient
 *     indiscernables ; son jumeau de juillet est celui qui mord.
 *   - « sans regle d'ete, l'heure ne bouge pas de son fuseau » garde le
 *     chemin le plus court du socle : un `DeviceClock` qui appliquerait
 *     une regle absente decalerait toutes les machines qui n'en ont pas,
 *     c'est-a-dire la quasi-totalite du depot. Sa chute signalerait que
 *     le lot a casse le cas ordinaire pour servir le cas rare.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

async function cisco(regle = REGLE): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', 0, 0);
  r.powerOn();
  await jouer(r, ['enable', 'configure terminal', 'clock timezone CET 1', regle, 'end']);
  return r;
}

async function vrp(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('AR1', 0, 0);
  r.powerOn();
  await jouer(r, ['system-view', 'clock timezone CET add 01:00:00',
    'clock daylight-saving-time CEST repeating 02:00 last Sun Mar 03:00 last Sun Oct 60']);
  return r;
}

describe('l_horloge suit son equipement — Cisco', () => {
  it('en juillet, show clock avance et porte le nom d_ete', async () => {
    const r = await cisco();
    await jouer(r, ['clock set 12:00:00 15 Jul 2026']);

    expect(await r.executeCommand('show clock')).toContain('14:00:00.000 CEST');
  }, 30000);

  it('en janvier, il reste a l_heure standard', async () => {
    const r = await cisco();
    await jouer(r, ['clock set 12:00:00 15 Jan 2026']);

    expect(await r.executeCommand('show clock')).toContain('13:00:00.000 CET');
  }, 30000);

  it('show calendar dit la MEME heure que show clock', async () => {
    const r = await cisco();
    await jouer(r, ['clock set 12:00:00 15 Jul 2026']);

    expect(await r.executeCommand('show calendar')).toContain('14:00:00 CEST');
  }, 30000);

  it('un decalage d_ete explicite est HONORE', async () => {
    const r = await cisco(`${REGLE} 120`);
    await jouer(r, ['clock set 12:00:00 15 Jul 2026']);

    expect(await r.executeCommand('show clock')).toContain('15:00:00.000 CEST');
  }, 30000);

  it('et il est RENDU, donc un import ne le perd pas', async () => {
    const r = await cisco(`${REGLE} 120`);

    expect(await r.executeCommand('show running-config')).toContain(`${REGLE} 120`);
  }, 30000);

  it('sans regle d_ete, l_heure ne bouge pas de son fuseau', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await jouer(r, ['enable', 'configure terminal', 'clock timezone CET 1', 'end',
      'clock set 12:00:00 15 Jul 2026']);

    expect(await r.executeCommand('show clock')).toContain('13:00:00.000 CET');
  }, 30000);
});

describe('l_horloge suit son equipement — VRP', () => {
  it('clock datetime deplace vraiment display clock', async () => {
    const r = await vrp();
    await jouer(r, ['clock datetime 12:00:00 2026-07-15']);

    expect(await r.executeCommand('display clock')).toContain('2026-07-15 14:00:00');
  }, 30000);

  it('en juillet, la zone affichee est celle d_ete', async () => {
    const r = await vrp();
    await jouer(r, ['clock datetime 12:00:00 2026-07-15']);

    expect(await r.executeCommand('display clock'))
      .toContain('Time Zone(CEST) : UTC add 02:00:00');
  }, 30000);

  it('en janvier, elle redevient celle d_hiver', async () => {
    const r = await vrp();
    await jouer(r, ['clock datetime 12:00:00 2026-01-15']);

    const vu = await r.executeCommand('display clock');

    expect(vu).toContain('2026-01-15 13:00:00');
    expect(vu).toContain('Time Zone(CET) : UTC add 01:00:00');
  }, 30000);

  it('la regle se relit a l_identique, sans rien perdre', async () => {
    const r = await vrp();

    expect(await r.executeCommand('display current-configuration')).toContain(
      'clock daylight-saving-time CEST repeating 02:00 last Sun Mar 03:00 last Sun Oct 60');
  }, 30000);

  it('un mois qui n_existe pas est REFUSE, pas range de travers', async () => {
    const r = new HuaweiRouter('AR1', 0, 0);
    r.powerOn();
    await jouer(r, ['system-view']);

    const refus = await r.executeCommand(
      'clock daylight-saving-time X repeating 02:00 last Sun Zorglub 03:00 last Sun Oct 60');

    expect(refus).toMatch(/Error:/);
    expect(await r.executeCommand('display current-configuration'))
      .not.toContain('daylight-saving-time');
  }, 30000);
});

describe('les deux constructeurs lisent le MEME instant', () => {
  it('meme fuseau, meme regle, meme heure locale', async () => {
    const c = await cisco();
    await jouer(c, ['clock set 12:00:00 15 Jul 2026']);
    const h = await vrp();
    await jouer(h, ['clock datetime 12:00:00 2026-07-15']);

    expect(await c.executeCommand('show clock')).toContain('14:00:00');
    expect(await h.executeCommand('display clock')).toContain('14:00:00');
  }, 30000);
});
