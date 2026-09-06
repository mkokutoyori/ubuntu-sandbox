/**
 * Lot T2 du `docs/PRD-Geographie-Et-Temps-Local.md` : la table des
 * fuseaux de Linux cesse d'etre une SECONDE ecriture du decalage.
 *
 * C'est le lot qui referme la mesure d'ouverture du PRD. Le meme
 * instant, le meme fuseau demande, deux equipements du meme
 * laboratoire, et une heure d'ecart :
 *
 *     AVANT   Time zone: Europe/Paris (CET,  +0100)   ← un 6 septembre
 *     APRES   Time zone: Europe/Paris (CEST, +0200)
 *
 * `TimezoneDatabase` rangeait un `offsetMin` FIXE par zone. Son en-tete
 * assumait la limite — « `Europe/Paris` vaut ici UTC+1 toute l'annee » —
 * et ce raisonnement etait juste QUAND il a ete ecrit : rien ne portait
 * alors les regles d'heure d'ete. Il a cesse de l'etre le jour ou le
 * pare-feu s'est mis a les calculer, et personne n'est revenu le
 * corriger. Le decalage vient desormais du registre du lot T1, ou il est
 * une fonction de l'instant.
 *
 * **Ce qui RESTE dans la table est ce que le registre ne sait pas
 * produire.** Mesure prise au lot T1 : `Intl` rend `GMT+1`/`GMT+2` pour
 * `Europe/Paris`, jamais `CET`/`CEST`. La table garde donc les
 * abreviations, et gagne celles d'heure d'ete qui lui manquaient. Elles
 * ne sont pas devinees : elles sont relevees sur le nom long qu'`Intl`
 * rend, lui, correctement (« Central European Summer Time »), parce
 * qu'un acronyme automatique donnerait `CUT` pour UTC et `MST` pour
 * Moscou.
 *
 * **Trois defauts trouves en mesurant, et fermes ici.**
 *
 * 1. `Africa/Yaounde` N'EXISTE PAS dans tzdata — le Cameroun y est
 *    couvert par `Africa/Douala` — et la table le declarait. Un vrai
 *    `timedatectl` refuse ce nom ; celui-ci l'acceptait. Le nom est
 *    retire, et rien d'autre ne s'en servait comme fuseau (les autres
 *    occurrences de « Yaounde » dans le depot sont une VILLE dans un
 *    registre Windows, sans rapport).
 * 2. `Asia/Bangkok`, `America/Argentina/Buenos_Aires` et les six cents
 *    autres zones que tzdata connait etaient REFUSEES parce qu'absentes
 *    d'une table de cinquante entrees. Une zone absente est desormais
 *    acceptee avec la forme numerique que tzdata emploie lui-meme faute
 *    d'abreviation propre : `+07`.
 * 3. `Africa/Casablanca` etait etiquete `WEST`, l'abreviation d'ete de
 *    l'Europe de l'Ouest. tzdata donne `+01` : le Maroc n'a pas
 *    d'abreviation propre. Corrige.
 *
 * **Cote Windows, deux champs cessent de mentir.** `BaseUtcOffset` est
 * le decalage NORMAL d'une zone, hors heure d'ete — il lisait un
 * `offsetMin` qui se trouvait etre le bon par accident, et lit
 * maintenant `standardOffsetMinutes`, ce qui le rend juste par
 * construction. Et `SupportsDaylightSavingTime` etait cable a `false`
 * pour TOUTES les zones, y compris Paris et New York.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * `git stash push -u -- src/network src/powershell` fait tomber **10 des
 * 12 cas**. J'en avais annonce huit avant de mesurer, et je m'etais
 * trompe sur DEUX que j'avais ranges parmi les non-discriminants : « une
 * zone sans heure d_ete ne bascule pas » tombe parce que `abreviationA`
 * et `decalageA` n'existent pas avant — c'est une raison de structure,
 * pas de comportement, et le cas garde sa valeur de NON-REGRESSION sur
 * le fond, `Africa/Douala` valant WAT +0100 des deux cotes ; et « le
 * pare-feu et Linux s_accordent » tombe, ce qui est precisement l'objet
 * du lot.
 *
 * Les 2 cas qui passent reellement des deux cotes sont nommes :
 *
 *   - « timedatectl nomme la zone configuree » est le TEMOIN : sans lui,
 *     une commande cassee et un fuseau faux seraient indiscernables ;
 *   - « le decalage normal de Paris reste +01:00 cote Windows » passait
 *     deja, l'ancienne table rangeant justement le decalage d'hiver —
 *     ce champ etait juste par accident et l'est maintenant par
 *     construction. Son jumeau, `SupportsDaylightSavingTime`, est celui
 *     qui mord.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { abreviationA, decalageA } from '@/network/devices/linux/time/TimezoneDatabase';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const JANVIER = Date.UTC(2026, 0, 15, 12, 0, 0);
const JUILLET = Date.UTC(2026, 6, 15, 12, 0, 0);

async function poste(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
  return pc;
}

async function taper(pc: LinuxPC, commande: string): Promise<string> {
  return (await pc.executeCommand(commande)).trim();
}

describe('le fuseau de Linux et celui du pare-feu', () => {
  it('timedatectl nomme la zone configuree', async () => {
    const pc = await poste();
    await taper(pc, 'timedatectl set-timezone Europe/Paris');

    expect(await taper(pc, 'timedatectl')).toContain('Time zone: Europe/Paris');
  }, 20000);

  it('en septembre, Paris est a deux heures d_UTC et non une', async () => {
    const pc = await poste();
    await taper(pc, 'timedatectl set-timezone Europe/Paris');

    const vu = await taper(pc, 'timedatectl');

    expect(vu).toContain('Time zone: Europe/Paris (CEST, +0200)');
  }, 20000);

  it('l_abreviation bascule avec la saison', () => {
    expect(abreviationA('Europe/Paris', JANVIER)).toBe('CET');
    expect(abreviationA('Europe/Paris', JUILLET)).toBe('CEST');
    expect(abreviationA('America/New_York', JANVIER)).toBe('EST');
    expect(abreviationA('America/New_York', JUILLET)).toBe('EDT');
  });

  it('une zone sans heure d_ete ne bascule pas', () => {
    expect(abreviationA('Africa/Douala', JANVIER)).toBe('WAT');
    expect(abreviationA('Africa/Douala', JUILLET)).toBe('WAT');
    expect(decalageA('Africa/Douala', JANVIER)).toBe(60);
    expect(decalageA('Africa/Douala', JUILLET)).toBe(60);
  });

  it('une zone que tzdata ignore est refusee', async () => {
    const pc = await poste();

    const refus = await taper(pc, 'timedatectl set-timezone Africa/Yaounde');

    expect(refus).toContain("Invalid time zone 'Africa/Yaounde'");
  }, 20000);

  it('une zone que tzdata connait est acceptee, meme hors table', async () => {
    const pc = await poste();

    expect(await taper(pc, 'timedatectl set-timezone Asia/Bangkok')).toBe('');
    expect(await taper(pc, 'timedatectl')).toContain('Asia/Bangkok (+07, +0700)');
  }, 20000);

  it('Casablanca porte l_abreviation que tzdata lui donne', () => {
    expect(abreviationA('Africa/Casablanca', JANVIER)).toBe('+01');
  });

  it('etc slash localtime porte le decalage du moment', async () => {
    const pc = await poste();
    await taper(pc, 'timedatectl set-timezone Europe/Paris');

    expect(await taper(pc, 'cat /etc/localtime')).toContain('+0200');
  }, 20000);

  it('timedatectl show rend le decalage du moment', async () => {
    const pc = await poste();
    await taper(pc, 'timedatectl set-timezone Europe/Paris');

    expect(await taper(pc, 'timedatectl show')).toContain('TimezoneOffset=120');
  }, 20000);

  it('le decalage normal de Paris reste plus une heure cote Windows', async () => {
    const pc = new WindowsPC('windows-pc', 'W', 0, 0);
    pc.powerOn();
    await pc.executeCommand(
      'powershell -c "Set-TimeZone -Id \'Romance Standard Time\'"');

    const vu = await pc.executeCommand('powershell -c "Get-TimeZone"');

    expect(vu).toContain('+01:00:00');
  }, 20000);

  it('Windows sait desormais qu_une zone observe l_heure d_ete', async () => {
    const pc = new WindowsPC('windows-pc', 'W', 0, 0);
    pc.powerOn();
    await pc.executeCommand(
      'powershell -c "Set-TimeZone -Id \'Romance Standard Time\'"');

    const paris = await pc.executeCommand('powershell -c "Get-TimeZone"');
    await pc.executeCommand(
      'powershell -c "Set-TimeZone -Id \'W. Central Africa Standard Time\'"');
    const douala = await pc.executeCommand('powershell -c "Get-TimeZone"');

    expect(paris).toContain('SupportsDaylightSavingTime : True');
    expect(douala).toContain('SupportsDaylightSavingTime : False');
  }, 20000);

  it('le pare-feu et Linux s_accordent enfin sur le meme fuseau', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const instant = Date.UTC(2026, 8, 6, 12, 0, 0);

    const cotePareFeu = (fw.localTimeOf(instant) - instant) / 60_000;
    const coteLinux = decalageA('Europe/Paris', instant);

    expect(fw.getTimezone()).toBe('Europe/Paris');
    expect(coteLinux).toBe(cotePareFeu);
    expect(coteLinux).toBe(120);
  }, 20000);
});
