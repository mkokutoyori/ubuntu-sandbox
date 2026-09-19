/**
 * `get system ha status' rendait DEUX LIGNES sur un pare-feu autonome, la
 * ou un vrai FortiGate en rend douze.
 *
 * MESURE DE DEPART sur `72782879' :
 *
 *   FGT # get system ha status
 *   HA Health Status: OK
 *   Mode: Standalone
 *
 * Le rendu coupait court des que `mode === 'standalone'' — un retour
 * anticipe sur une seule chaine. Or l'autonome n'est pas un cas degenere
 * pour cette commande : c'est l'etat de TOUT laboratoire qui ne monte pas
 * de grappe, donc le cas le plus frequent, et la vraie machine y rend son
 * bloc complet.
 *
 * AUTORITE : les SEPT sorties CAPTUREES que `ntc-templates' conserve pour
 * `fortinet_get_system_ha_status', dont une prise sur un equipement SANS
 * grappe — c'est elle qui fixe le cas :
 *
 *   HA Health Status: OK
 *   Model: FortiGate-60D
 *   Mode: Standalone
 *   Group: 0
 *   Debug: 0
 *   Cluster Uptime: 0 days 0:0:0
 *   Cluster state change time: N/A
 *   ses_pickup: enable, ses_pickup_delay=disable
 *   override: enable
 *   System Usage stats:
 *   HBDEV stats:
 *   number of vcluster: 0
 *
 * SEPT CAPTURES DISENT `Group: N' SUR UNE SEULE LIGNE. Nous en ecrivions
 * deux — `Group Name:' puis `Group ID:' — qu'aucune ne porte. Avec sept
 * temoins couvrant 5.6 a 7.0, ce n'est pas une variation de version.
 *
 * `Cluster state change time:' est dans les sept aussi, et vaut `N/A'
 * quand il n'y a pas de grappe. Il manquait.
 *
 * LA DUREE N'EST PAS REMPLIE DE ZEROS. `0 days 0:0:0' sur l'autonome, et
 * `40 days 19:16:5' sur la capture 6.4 : ni les heures, ni les minutes,
 * ni les SECONDES ne sont calees sur deux chiffres. Nous remplissions
 * minutes et secondes, ce qui ne se voyait que sur les valeurs a un
 * chiffre — donc jamais dans un laboratoire ordinaire, et toujours sur
 * l'autonome, qui en a trois.
 *
 * LES BLOCS DE MEMBRES SONT INDENTES DE QUATRE ESPACES : la ligne
 * d'election sous `Primary selected using:', et chaque membre sous
 * `Configuration Status:'. Nous les posions a la marge.
 *
 * ET L'HORODATAGE EST CELUI DE L'EQUIPEMENT. `stamp()' lisait la date par
 * les accesseurs `getUTC*'. C'est la QUATRIEME vue de cette machine a
 * porter ce defaut — apres les champs du journal, la liste des baux DHCP
 * et l'expiration ARP — et la correction est la meme : passer par la
 * plume unique qui date deja `execute date' et `execute time'.
 *
 * CE QUI RESTE VIDE, ET POURQUOI. `System Usage stats:' et `HBDEV stats:'
 * sont rendus comme en-tetes sans contenu. Sur l'autonome c'est
 * exactement ce que la capture montre. En grappe, la vraie machine y
 * detaille les sessions, le processeur et la memoire de CHAQUE membre :
 * ce simulateur mesure bien les siens, mais n'echange aucune de ces
 * valeurs avec ses pairs, donc il ne peut pas remplir les lignes des
 * autres. Les ecrire pour soi seul donnerait a croire que la grappe les
 * partage.
 *
 * UN DEFAUT TROUVE EN CHEMIN, refermé avec. Le nom de modele de cette
 * machine — `FortiGate-VM64' — etait ecrit TROIS fois, en litteral, dans
 * trois fichiers : la ligne `Version:' de `get system status' et les deux
 * appels au rendu HA. Trois ecritures d'un meme fait, dont deux a une
 * ligne l'une de l'autre du champ `localStamp' que ce lot ajoute. Le
 * modele descend desormais du profil de l'equipement, la ou vit deja sa
 * version.
 *
 * Et c'est le typecheck qui a revele le SECOND appelant : `diagnose sys
 * ha status' rend la meme vue par un autre chemin, et datait donc lui
 * aussi a UTC. Les deux passent maintenant par la meme plume.
 *
 * MESURE : 6 cas tombent sur 8.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : la vue repondait deja, et par la bonne premiere ligne.
 *     Sans lui, « le bloc est incomplet » et « la commande est cassee »
 *     seraient indiscernables ;
 *   - « en grappe, le groupe tient sur une ligne » tombe, mais son
 *     jumeau — l'absence de `Group Name:' — ne vaut qu'avec lui.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const AUTONOME = [
  'HA Health Status: OK',
  'Model: FortiGate-VM64',
  'Mode: Standalone',
  'Group: 0',
  'Debug: 0',
  'Cluster Uptime: 0 days 0:0:0',
  'Cluster state change time: N/A',
  'ses_pickup: disable, ses_pickup_delay=disable',
  'override: disable',
  'System Usage stats:',
  'HBDEV stats:',
  'number of vcluster: 0',
];

function pareFeu(): FortiGate {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  fgt.powerOn();
  return fgt;
}

async function adhere(fgt: FortiGate, priorite: number): Promise<void> {
  await taper(fgt, [
    'config system ha', 'set group-name "cluster-paris"', 'set group-id 10',
    'set mode a-p', 'set password "SecretHA"', 'set hbdev "port7" 50',
    `set priority ${priorite}`, 'end',
  ]);
}

async function enGrappe(zone?: string): Promise<FortiGate> {
  const a = new FortiGate('firewall-fortinet', 'FGT-A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'FGT-B', 200, 0);
  a.powerOn();
  b.powerOn();
  new Cable('hb').connect(a.getPort('port7')!, b.getPort('port7')!);
  if (zone !== undefined) {
    await taper(a, ['config system global', `set timezone ${zone}`, 'end']);
  }
  await adhere(a, 200);
  await adhere(b, 128);
  for (let tour = 0; tour < 3; tour += 1) {
    a.getHa().tick();
    b.getHa().tick();
  }
  return a;
}

const etat = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get system ha status').then(String);

describe('`get system ha status` rend son bloc, grappe ou pas', () => {
  it('TEMOIN : la vue repond et s ouvre par l etat de sante', async () => {
    const fgt = pareFeu();
    expect((await etat(fgt)).split('\n')[0]).toBe('HA Health Status: OK');
  }, 30000);

  it('un pare-feu AUTONOME rend les douze lignes attestees', async () => {
    const fgt = pareFeu();
    expect((await etat(fgt)).split('\n')).toEqual(AUTONOME);
  }, 30000);

  it('en grappe, le groupe tient sur UNE ligne', async () => {
    const fgt = await enGrappe();
    const lignes = (await etat(fgt)).split('\n');

    expect(lignes).toContain('Group: 10');
    expect(lignes.some(l => l.startsWith('Group Name:'))).toBe(false);
    expect(lignes.some(l => l.startsWith('Group ID:'))).toBe(false);
  }, 30000);

  it('en grappe, l heure du changement d etat est datee', async () => {
    const fgt = await enGrappe();
    expect(await etat(fgt))
      .toMatch(/Cluster state change time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  }, 30000);

  it('en grappe, les membres sont indentes de QUATRE espaces', async () => {
    const fgt = await enGrappe();
    const lignes = (await etat(fgt)).split('\n');
    const apres = lignes.indexOf('Configuration Status:');

    expect(apres).toBeGreaterThan(0);
    expect(lignes[apres + 1].startsWith('    ')).toBe(true);
  }, 30000);

  it('les deux en-tetes de statistiques sont rendus', async () => {
    const fgt = await enGrappe();
    const lignes = (await etat(fgt)).split('\n');

    expect(lignes).toContain('System Usage stats:');
    expect(lignes).toContain('HBDEV stats:');
  }, 30000);

  it('l horodatage suit le fuseau de l EQUIPEMENT', async () => {
    const fgt = await enGrappe('Asia/Kolkata');
    const lu = /Cluster state change time: (\S+) /.exec(await etat(fgt))?.[1] ?? '';
    const horloge = /current date is: (\S+)/.exec(
      String(await fgt.executeCommand('execute date')))?.[1] ?? '';

    expect(horloge).not.toBe('');
    expect(lu).toBe(horloge);
  }, 30000);

  it('NON-REGRESSION : en grappe, le maitre et l esclave restent nommes', async () => {
    const fgt = await enGrappe();
    expect(await etat(fgt))
      .toMatch(/Primary : FGT-A, FGVM\w+, HA cluster index = 0/);
  }, 30000);
});
