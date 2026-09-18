/**
 * `execute log display' rendait ses enregistrements NUS : ni le compte
 * qui les precede, ni le numero qui les ouvre.
 *
 * MESURE DE DEPART sur `757380fa' :
 *
 *   FGT # execute log display
 *   date=2026-09-17 time=23:53:58 eventtime=... type="traffic" ...
 *
 *   FGT # execute log display          (journal vide)
 *   No matching log data.
 *
 * AUTORITE : les DEUX sorties CAPTUREES que `ntc-templates' conserve pour
 * `fortinet_execute_log_display'. La vue s'ouvre par un compte-rendu de
 * recherche, puis une ligne vide, puis des enregistrements NUMEROTES :
 *
 *   2492 logs found.
 *   10 logs returned.
 *   5.8% of logs has been searched.
 *
 *   1: date=2023-08-10 time=19:41:18 logid="0000000013" ...
 *
 * et sur un journal vide, DEUX lignes seulement — la troisieme disparait :
 *
 *   0 logs found.
 *   0 logs returned.
 *
 * `No matching log data.' n'est atteste nulle part ; c'etait une phrase
 * de notre cru pour un cas que la vraie machine rend autrement.
 *
 * LE POURCENTAGE EST VRAI ICI, ET C'EST POUR CA QU'IL VAUT CENT.
 * `FirewallLogStore.select' parcourt TOUT le magasin a chaque appel : il
 * n'y a ni curseur, ni reprise, ni arret anticipe. Cent pour cent du
 * journal a donc reellement ete parcouru, et l'ecrire est un constat, pas
 * un remplissage. La capture montre `5.8%' parce que la vraie machine
 * s'arrete des qu'elle tient son lot et reprend a l'appel suivant : c'est
 * une PAGINATION que ce moteur n'a pas, et que ce lot n'invente pas.
 *
 * TROUVES ET RENDUS PEUVENT DIVERGER, et la CLI le permet deja :
 * `execute log filter view-lines N' borne ce que la vue rend. Le magasin
 * appliquait cette borne DANS `select', si bien que l'appelant ne pouvait
 * plus savoir combien d'enregistrements avaient repondu au filtre. Un
 * `countMatching' est ajoute a cote de `deleteMatching', qui existait
 * deja et compte exactement de la meme facon.
 *
 * MESURE : 7 cas tombent sur 9.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : l'enregistrement depose etait DEJA rendu. Sans lui,
 *     « le compte-rendu manque » et « le journal est vide » seraient
 *     indiscernables ;
 *   - NON-REGRESSION : les champs de l'enregistrement sont inchanges. Ce
 *     lot ajoute un prefixe et un en-tete ; il ne devait pas toucher au
 *     corps de la ligne, que d'autres vues et d'autres sondes lisent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
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

const INSTANT = Date.parse('2026-07-15T12:00:00Z');

function pareFeu(journal = 0): FortiGate {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0,
    { now: () => INSTANT });
  fgt.powerOn();
  for (let index = 0; index < journal; index += 1) {
    fgt.getLogStore().append({
      id: String(index).padStart(10, '0'), type: 'traffic', subtype: 'forward',
      level: 'notice', at: INSTANT, fields: { srcip: `10.0.0.${index}` },
    });
  }
  return fgt;
}

const vue = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('execute log display').then(String);

describe('`execute log display` rend son compte-rendu de recherche', () => {
  it('TEMOIN : l enregistrement depose est bien rendu', async () => {
    const fgt = pareFeu(1);
    expect(await vue(fgt)).toContain('srcip=10.0.0.0');
  }, 30000);

  it('la vue s ouvre par le nombre TROUVE', async () => {
    const fgt = pareFeu(3);
    expect((await vue(fgt)).split('\n')[0]).toBe('3 logs found.');
  }, 30000);

  it('puis par le nombre RENDU', async () => {
    const fgt = pareFeu(3);
    expect((await vue(fgt)).split('\n')[1]).toBe('3 logs returned.');
  }, 30000);

  it('puis par la part parcourue, a une decimale', async () => {
    const fgt = pareFeu(3);
    expect((await vue(fgt)).split('\n')[2])
      .toBe('100.0% of logs has been searched.');
  }, 30000);

  it('une ligne VIDE separe le compte-rendu des enregistrements', async () => {
    const fgt = pareFeu(2);
    expect((await vue(fgt)).split('\n')[3]).toBe('');
  }, 30000);

  it('chaque enregistrement est numerote a partir de UN', async () => {
    const fgt = pareFeu(3);
    const lignes = (await vue(fgt)).split('\n').slice(4);

    expect(lignes.length).toBe(3);
    lignes.forEach((ligne, index) => {
      expect(ligne.startsWith(`${index + 1}: date=`)).toBe(true);
    });
  }, 30000);

  it('un journal VIDE rend deux lignes, et pas la troisieme', async () => {
    const fgt = pareFeu(0);
    expect((await vue(fgt)).split('\n')).toEqual(['0 logs found.', '0 logs returned.']);
  }, 30000);

  it('`view-lines` fait diverger TROUVES et RENDUS', async () => {
    const fgt = pareFeu(5);
    await taper(fgt, ['execute log filter view-lines 2']);
    const lignes = (await vue(fgt)).split('\n');

    expect(lignes[0]).toBe('5 logs found.');
    expect(lignes[1]).toBe('2 logs returned.');
    expect(lignes.slice(4).length).toBe(2);
  }, 30000);

  it('NON-REGRESSION : les champs de l enregistrement sont inchanges', async () => {
    const fgt = pareFeu(1);
    expect(await vue(fgt))
      .toMatch(/type="traffic" subtype="forward" level="notice"/);
  }, 30000);
});
