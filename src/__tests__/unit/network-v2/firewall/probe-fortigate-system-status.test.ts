/**
 * `get system status` taisait la moitie de son en-tete.
 *
 * Mesure de depart, sur les 8 captures reelles de
 * `ntc-templates/tests/fortinet/get_system_status/` (5.6 a 7.4.8) et sur
 * le gabarit `fortinet_get_system_status.textfsm`, qui se termine par
 * `^. -> Error` : la liste de libelles du gabarit est donc EXHAUSTIVE
 * pour les versions qu'il couvre, et toute ligne hors de cette liste
 * ferait echouer l'analyse d'un outil reel.
 *
 * La machine declare `v7.6.3` ; la capture la plus proche est celle de
 * 7.4.8, croisee avec la seule capture de VM (7.0_eval) pour les lignes
 * qui dependent du materiel. Les 8 captures s'accordent sur :
 *
 *  - `Version: <modele> v<version>,build<build>,<aammjj> (<branche>)` --
 *    nous rendions la ligne SANS sa date de compilation ni sa branche.
 *  - un bloc de bases FortiGuard entre `Version:` et `Serial-Number:`,
 *    chacune en `<version>(<AAAA-MM-JJ HH:MM>)`. Nous n'en rendions
 *    AUCUNE, alors que le magasin existe (`getFortiGuard()`) et que
 *    `diagnose autoupdate versions` le lit deja.
 *  - `FIPS-CC mode:`, `Release Version Information:` et
 *    `Last reboot reason:` (7.0 et au-dela), absents chez nous.
 *  - `FortiOS x86-64: Yes`, que la capture de VM porte.
 *  - `VM Resources: 1 CPU/1 allowed, 997 MB RAM/2048 MB allowed` --
 *    nous rendions `1 CPU, 1024 MB RAM`, une forme qu'aucun FortiOS
 *    n'emet.
 *
 * Le defaut de fond est un SEUL FAIT ECRIT DEUX FOIS : le magasin
 * FortiGuard rangeait sa date de mise a jour DEJA MISE EN FORME, dans la
 * forme ctime que `diagnose autoupdate versions` demande. La vue d'etat
 * en veut une autre (`AAAA-MM-JJ HH:MM`) et ne pouvait donc pas la
 * deduire. Le magasin range desormais l'INSTANT, et chaque vue le met en
 * forme -- avec l'horloge de la machine, pas celle du navigateur.
 *
 * Discrimine par `git stash push -- src/network` : 10 cas sur 13 tombent
 * avant correctif.
 *
 * Les 3 qui passent des deux cotes sont nommes, sans quoi le compte
 * flatterait le lot :
 *  - « TEMOIN » prouve que la vue repond ; c'est ce qu'on lui demande.
 *  - « aucune ligne hors du vocabulaire du gabarit » est une
 *    NON-REGRESSION : avant correctif la sortie est pauvre mais
 *    conforme, et le cas garantit que l'enrichissement n'introduit pas
 *    une ligne qu'un outil reel refuserait.
 *  - « diagnose autoupdate versions garde sa date en ctime » est l'autre
 *    NON-REGRESSION, et c'est le point du lot : le magasin cesse de
 *    ranger une chaine deja mise en forme, et cette vue-la doit rendre
 *    exactement la meme chose qu'avant.
 *
 * Un cas a du etre CORRIGE : il lisait la date des bases sans fixer le
 * fuseau, en supposant UTC. Le pare-feu neuf n'est pas en UTC, et c'etait
 * une fausse premisse du laboratoire, pas un defaut -- le cas voisin,
 * qui compare deux fuseaux, le prouve.
 *
 * Limites assumees, nommees plutot que tues :
 *  - les bases `Extended DB`, `IPS-ETDB`, `INDUSTRIAL-DB`,
 *    `IPS Malicious URL Database`, `FMWP-DB`, `IoT-Detect`, `OT-*-DB` et
 *    `AV AI/ML Model` que les captures montrent ne sont pas rendues : le
 *    magasin ne les porte pas, et les AJOUTER demanderait leur nom dans
 *    le vocabulaire de `diagnose autoupdate versions`, qu'aucune source
 *    atteignable d'ici n'atteste.
 *  - `Firmware Signature`, `Security Level`, `Private Encryption`,
 *    `BIOS version` et `System Part-Number` sont ecartes parce que la
 *    seule capture de VM ne les porte pas -- une VM n'a ni BIOS ni
 *    numero de piece.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import {
  VirtualTimeScheduler, __setDefaultScheduler,
} from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

const LIBELLES_DU_GABARIT: readonly RegExp[] = Object.freeze([
  /^Version: /, /^First GA patch build date: /, /^(Current )?Security Level: /,
  /^Firmware Signature: /, /^Virus-DB: /, /^Extended DB: /, /^AV AI\/ML Model: /,
  /^Extreme DB: /, /^IPS-DB: /, /^IPS-ETDB: /, /^APP-DB: /, /^FMWP-DB: /,
  /^INDUSTRIAL-DB: /, /^Serial-Number: /, /^License Status: /,
  /^Evaluation License Expires: /, /^VM Resources: /,
  /^IPS Malicious URL Database: /, /^IoT-Detect: /, /^OT-Detect-DB: /,
  /^OT-Patch-DB: /, /^OT-Threat-DB: /, /^IPS-Engine: /, /^Botnet DB: /,
  /^BIOS version: /, /^System Part-Number: /, /^Log hard disk: /, /^Hostname: /,
  /^Private Encryption: /, /^Operation Mode: /, /^Current virtual domain: /,
  /^Max number of virtual domains: /, /^Virtual domains status: /,
  /^Virtual domain configuration: /, /^FIPS-CC mode: /, /^Current HA mode: /,
  /^Cluster uptime: /, /^Cluster state change time: /, /^Branch point: /,
  /^Release Version Information: /, /^FortiOS x86-64: /, /^System time: /,
  /^Last reboot reason: /,
]);

async function taper(fw: FortiGate, lignes: string[]) {
  for (const l of lignes) await fw.executeCommand(l);
}

async function laboratoire(...global: string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT');
  if (global.length > 0) await taper(fw, ['config system global', ...global, 'end']);
  return fw;
}

async function etat(fw: FortiGate): Promise<string> {
  return fw.executeCommand('get system status');
}

function ligne(out: string, prefixe: string): string {
  return out.split('\n').find(l => l.startsWith(prefixe)) ?? '';
}

describe('FortiGate : get system status rend tout son en-tete', () => {
  it('TEMOIN : la vue repond et porte son numero de serie', async () => {
    const out = await etat(await laboratoire());
    expect(out).toContain('Hostname: FGT');
    expect(ligne(out, 'Serial-Number: ')).toMatch(/^Serial-Number: \S+$/);
  });

  it('NON-REGRESSION : aucune ligne hors du vocabulaire du gabarit', async () => {
    const out = await etat(await laboratoire());
    const inconnues = out.split('\n').filter(l => l.trim() !== '')
      .filter(l => !LIBELLES_DU_GABARIT.some(re => re.test(l)));
    expect(inconnues).toEqual([]);
  });

  it('la ligne Version porte sa date de compilation et sa branche', async () => {
    const out = await etat(await laboratoire());
    expect(ligne(out, 'Version: '))
      .toMatch(/^Version: FortiGate-VM64 v7\.6\.3,build\d{4},\d{6} \(GA(\.[A-Z])?\)$/);
  });

  it('Release Version Information dit la MEME branche que la ligne Version', async () => {
    const out = await etat(await laboratoire());
    const branche = /\(GA(?:\.[A-Z])?\)$/.exec(ligne(out, 'Version: '))?.[0];
    expect(branche).toBeDefined();
    expect(ligne(out, 'Release Version Information: '))
      .toBe('Release Version Information: GA');
  });

  it('une VM 64 bits le dit', async () => {
    expect(await etat(await laboratoire())).toContain('FortiOS x86-64: Yes');
  });

  it('le mode FIPS-CC est annonce', async () => {
    expect(await etat(await laboratoire())).toContain('FIPS-CC mode: disable');
  });

  it('VM Resources annonce l alloue en face du consomme', async () => {
    const out = await etat(await laboratoire());
    expect(ligne(out, 'VM Resources: '))
      .toMatch(/^VM Resources: \d+ CPU\/\d+ allowed, \d+ MB RAM\/\d+ MB allowed$/);
  });

  it('les bases FortiGuard sont rendues avec leur version et leur date', async () => {
    const out = await etat(await laboratoire());
    for (const base of ['Virus-DB', 'IPS-DB', 'APP-DB']) {
      expect(ligne(out, `${base}: `))
        .toMatch(new RegExp(`^${base}: \\d+\\.\\d{5}\\(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\)$`));
    }
  });

  it('la version rendue est CELLE DU MAGASIN, pas une autre', async () => {
    const fw = await laboratoire('set timezone "UTC"');
    const versions = await fw.executeCommand('diagnose autoupdate versions');
    const bloc = versions.split('Virus Definitions')[1] ?? '';
    const duMagasin = /Version:\s+(\S+)/.exec(bloc)?.[1];
    expect(duMagasin).toBeDefined();
    expect(ligne(await etat(fw), 'Virus-DB: '))
      .toBe(`Virus-DB: ${duMagasin}(2020-01-01 00:00)`);
  });

  it('la date des bases suit le fuseau de la machine', async () => {
    const utc = await laboratoire('set timezone "UTC"');
    const paris = await laboratoire('set timezone "Europe/Paris"');
    const dateDe = (o: string) => /\(([^)]+)\)/.exec(ligne(o, 'Virus-DB: '))?.[1];
    expect(dateDe(await etat(utc))).toBe('2020-01-01 00:00');
    expect(dateDe(await etat(paris))).toBe('2020-01-01 01:00');
  });

  it('un demarrage a froid donne power cycle', async () => {
    expect(await etat(await laboratoire())).toContain('Last reboot reason: power cycle');
  });

  it('execute reboot donne warm reboot', async () => {
    const fw = await laboratoire();
    await taper(fw, ['execute reboot', 'y']);
    expect(await etat(fw)).toContain('Last reboot reason: warm reboot');
  });

  it('diagnose autoupdate versions garde sa date en ctime', async () => {
    const fw = await laboratoire('set timezone "UTC"');
    expect(await fw.executeCommand('diagnose autoupdate versions'))
      .toContain('Last Updated using manual update on Wed Jan  1 00:00:00 2020');
  });
});
