/**
 * Mesure : exportTopology de 6 routeurs Huawei neufs = 0,7 s, dont 0,5 s de PBKDF2. Le rendu de la configuration courante, que l'export compare au jumeau
 * d'usine, calculait le condense irreversible du mot de passe de chaque routeur. Ce condense est une fonction pure du mot de passe (sel derive du mot
 * de passe) : memorise, 64 entrees.
 *
 * Non traite : un FortiGate coute encore 340 ms a l'export (quatre certificats d'usine a chaque exemplaire, jumeau compris). Les partager entre exemplaires
 * a ete essaye puis retire : tuto-fortigate-tp21 (etape 5) pose que le certificat d'usine DIFFERE d'une unite a l'autre sans desynchroniser la grappe.
 *
 * Discrimine par `git stash push -- src/crypto/passwords` : le cas de duree tombe (0,7 s avant, moins de 0,4 s apres). Passe des deux cotes, TEMOIN : le condense est stable et
 * depend du mot de passe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice } from '@/network';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology } from '@/store/topologySerializer';
import { huaweiIrreversibleCipher } from '@/crypto/passwords/huawei';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('enregistrer des routeurs Huawei', () => {
  it('six routeurs Huawei neufs s exportent en moins de 0,4 s', () => {
    const devices = Array.from({ length: 6 }, () => createDevice('router-huawei', 0, 0));
    const startedAt = performance.now();
    exportTopology('lab', new Map(devices.map((device) => [device.getId(), device])), []);
    expect(performance.now() - startedAt).toBeLessThan(400);
  }, 60_000);

  it('TEMOIN — le condense Huawei est stable et depend du mot de passe', () => {
    expect(huaweiIrreversibleCipher('Huawei@123')).toBe(huaweiIrreversibleCipher('Huawei@123'));
    expect(huaweiIrreversibleCipher('Huawei@123')).not.toBe(huaweiIrreversibleCipher('Huawei@124'));
  });
});
