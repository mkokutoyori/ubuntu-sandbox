/**
 * VRP — une regle `mac-limit` est identifiee par sa PORTEE, pas par son
 * texte.
 *
 * Le magasin de texte par interface ne savait remplacer un reglage que
 * si la nouvelle ligne commencait par la meme cle : `mac-limit maximum`
 * suffisait pour la forme sans qualificatif, et la forme `... vlan 10`
 * n'avait pas de cle du tout, donc deux reglages successifs sur LE MEME
 * VLAN s'empilaient — une configuration rendue qui porte deux maxima
 * pour un seul VLAN, et qu'un import rejoue tels quels.
 *
 * Ce que la mesure ne tranche pas est laisse tel quel et reste inscrit
 * au TODO : deux regles de PORTEES differentes (avec et sans `vlan`)
 * coexistent ici, faute d'une page Huawei joignable pour dire si une
 * vraie machine les accepte ensemble.
 *
 * Discrimine par `git stash` de `HuaweiSwitchShell.ts` : 3 des 6 cas
 * tombent. Les 3 qui passent des deux cotes sont nommes ici — le TEMOIN
 * sans qualificatif, que l'ancienne cle traitait deja correctement ;
 * « sur DEUX vlans », ou l'empilement donnait par hasard la bonne
 * reponse ; et le rendu d'une regle unique, qui n'a jamais eu de defaut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const PORT = 'GigabitEthernet0/0/1';

async function poser(lignes: readonly string[]): Promise<string> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 10, 0, 0);
  for (const c of ['system-view', `interface ${PORT}`, ...lignes]) {
    await sw.executeCommand(c);
  }
  return sw.executeCommand('display this');
}

const lignesMacLimit = (texte: string) =>
  texte.split('\n').map(l => l.trim()).filter(l => l.startsWith('mac-limit'));

describe('un reglage remplace celui de la meme portee', () => {
  it('TEMOIN — sans qualificatif, la seconde valeur remplace la premiere', async () => {
    const texte = await poser(['mac-limit maximum 5', 'mac-limit maximum 8']);
    expect(lignesMacLimit(texte)).toEqual(['mac-limit maximum 8']);
  });

  it('sur le MEME vlan, la seconde valeur remplace la premiere', async () => {
    const texte = await poser([
      'mac-limit maximum 5 vlan 10', 'mac-limit maximum 8 vlan 10',
    ]);
    expect(lignesMacLimit(texte)).toEqual(['mac-limit maximum 8 vlan 10']);
  });

  it('sur DEUX vlans, les deux regles vivent', async () => {
    const texte = await poser([
      'mac-limit maximum 5 vlan 10', 'mac-limit maximum 8 vlan 20',
    ]);
    expect(lignesMacLimit(texte).sort()).toEqual([
      'mac-limit maximum 5 vlan 10', 'mac-limit maximum 8 vlan 20',
    ]);
  });

  it('changer une regle de vlan ne touche pas l autre', async () => {
    const texte = await poser([
      'mac-limit maximum 5 vlan 10', 'mac-limit maximum 8 vlan 20',
      'mac-limit maximum 9 vlan 10',
    ]);
    expect(lignesMacLimit(texte).sort()).toEqual([
      'mac-limit maximum 8 vlan 20', 'mac-limit maximum 9 vlan 10',
    ]);
  });

  it('les qualificatifs qui NE SONT PAS la portee suivent la valeur', async () => {
    const texte = await poser([
      'mac-limit maximum 5 vlan 10 action discard',
      'mac-limit maximum 5 vlan 10 action forward',
    ]);
    expect(lignesMacLimit(texte)).toEqual(['mac-limit maximum 5 vlan 10 action forward']);
  });

  it('la configuration rendue reproduit ce qui a ete tape', async () => {
    const texte = await poser(['mac-limit maximum 8 vlan 10 alarm enable']);
    expect(lignesMacLimit(texte)).toEqual(['mac-limit maximum 8 vlan 10 alarm enable']);
  });
});
