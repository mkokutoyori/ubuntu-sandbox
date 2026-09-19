/**
 * `get hardware nic' SANS argument deversait le bloc detaille de CHAQUE
 * carte, la ou un vrai FortiGate en donne la LISTE.
 *
 * MESURE DE DEPART sur `f8f67031', sur un pare-feu a dix ports :
 *
 *   FGT # get hardware nic
 *   port1
 *   Current_HWaddr        02:00:00:00:00:01
 *   Permanent_HWaddr      02:00:00:00:00:01
 *   Admin                 :up
 *   ...soixante-dix lignes de plus...
 *
 * C'est le meme defaut que celui des deux vues d'interface d'un lot
 * precedent : une commande qui rend la sortie d'une AUTRE. Ici la forme
 * sans argument est un catalogue — on l'appelle pour savoir quel nom
 * passer ensuite — et nous rendions la reponse de la forme argumentee,
 * repetee.
 *
 * AUTORITE : les deux sorties CAPTUREES que `ntc-templates' conserve,
 * `fortinet_get_hardware_nic' et `fortinet_get_hardware_nic_nic-name'.
 *
 *   The following NICs are available:
 *           a
 *           lan
 *           lan1
 *
 * Huit espaces devant chaque nom, un nom par ligne, sous une phrase qui
 * annonce la liste.
 *
 * LA LARGEUR DU LIBELLE EST SEIZE, et nous en ecrivions vingt-deux. La
 * capture par carte l'atteste sur plus de vingt lignes, dont toutes celles
 * que nous rendons : `Admin           :up' pose son deux-points a la
 * colonne 16, `Speed           :100' aussi. Les deux lignes d'adresse
 * materielle ne portent PAS de deux-points mais un blanc —
 * `Permanent_HWaddr 12:34:...' — et leur valeur commence donc a la colonne
 * 17, ce que notre remplissage a vingt-deux ecrasait.
 *
 * CE QUE CE LOT NE TOUCHE PAS, et pourquoi. La capture par carte vient
 * d'une plateforme a ASIC : elle porte `Description :FortiASIC NP6XLITE
 * Adapter', des identifiants de `lif', deux bandeaux de section
 * (`========== Link Status ==========') et un bloc de compteurs
 * `Rx Pkts' / `Host Rx Pkts' / `FragTx*' qui appartient au chemin de
 * donnees NP6. Cet equipement annonce `FortiGate-VM64' : rien dans cette
 * capture ne dit ce qu'une carte LOGICIELLE rend de ces sections, et
 * recopier les bandeaux d'une plateforme sur l'autre serait deviner. Ce
 * qui est corrige ici est ce que la capture atteste pour les champs que
 * nous rendons DEJA — leur largeur — et la forme sans argument, qui ne
 * depend d'aucune plateforme puisqu'elle ne liste que des noms.
 *
 * MESURE : 5 cas tombent sur 7.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : la forme ARGUMENTEE rendait deja l'etat de la carte et ses
 *     compteurs. Sans lui, « le catalogue est faux » et « la machine ne
 *     sait rien de ses cartes » seraient indiscernables ;
 *   - NON-REGRESSION : `diagnose hardware deviceinfo nic' et
 *     `get hardware nic' rendent la MEME chose, avant comme apres. Les
 *     deux chemins passent par une seule plume, et la refonte du
 *     catalogue ne devait pas les separer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function pareFeu(): FortiGate {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  fgt.powerOn();
  return fgt;
}

const nic = (fgt: FortiGate, suite = ''): Promise<string> =>
  fgt.executeCommand(`get hardware nic${suite}`).then(String);

describe('`get hardware nic` sans argument est un CATALOGUE', () => {
  it('TEMOIN : la forme argumentee rend bien l etat de la carte', async () => {
    const fgt = pareFeu();
    const bloc = await nic(fgt, ' port1');

    expect(bloc).toMatch(/Speed\s+:\d+/);
    expect(bloc).toMatch(/rxp=\d+/);
  }, 30000);

  it('la forme sans argument annonce la liste', async () => {
    const fgt = pareFeu();
    expect((await nic(fgt)).split('\n')[0]).toBe('The following NICs are available:');
  }, 30000);

  it('chaque nom est seul sur sa ligne, indente de HUIT espaces', async () => {
    const fgt = pareFeu();
    const lignes = (await nic(fgt)).split('\n').slice(1);

    expect(lignes.length).toBe(fgt.getPortNames().length);
    for (const [index, nom] of fgt.getPortNames().entries()) {
      expect(lignes[index]).toBe(`        ${nom}`);
    }
  }, 30000);

  it('elle ne deverse PLUS le bloc de chaque carte', async () => {
    const fgt = pareFeu();
    const rendu = await nic(fgt);

    expect(rendu).not.toContain('Current_HWaddr');
    expect(rendu).not.toContain('rxp=');
  }, 30000);

  it('le libelle du bloc est large de SEIZE', async () => {
    const fgt = pareFeu();
    const lignes = (await nic(fgt, ' port1')).split('\n');

    for (const etiquette of ['Admin', 'Speed', 'Duplex', 'link_status']) {
      const ligne = lignes.find(l => l.startsWith(etiquette)) ?? '';
      expect(ligne.indexOf(':')).toBe(16);
    }
  }, 30000);

  it('les adresses materielles sont separees par un BLANC, colonne 17', async () => {
    const fgt = pareFeu();
    const lignes = (await nic(fgt, ' port1')).split('\n');

    for (const etiquette of ['Current_HWaddr', 'Permanent_HWaddr']) {
      const ligne = lignes.find(l => l.startsWith(etiquette)) ?? '';
      expect(/([0-9a-f]{2}:){5}[0-9a-f]{2}/.exec(ligne)?.index).toBe(17);
    }
  }, 30000);

  it('NON-REGRESSION : `diagnose hardware deviceinfo nic` suit la meme plume', async () => {
    const fgt = pareFeu();

    expect(String(await fgt.executeCommand('diagnose hardware deviceinfo nic')))
      .toBe(await nic(fgt));
  }, 30000);
});
