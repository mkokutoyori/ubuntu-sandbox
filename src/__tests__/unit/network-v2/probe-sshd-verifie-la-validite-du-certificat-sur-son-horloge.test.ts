/**
 * La validite d'un certificat utilisateur SSH (OpenSSH 8.9p1, `sshkey_cert_check_authority` : valid_after <= maintenant <
 * valid_before) se juge sur l'horloge du SERVEUR. `SshdCertificateService` fournissait `simulationNowMs()` a l'admission,
 * donc un sshd dont on avait avance l'horloge de deux jours acceptait toujours un certificat de vingt-quatre heures. Corrige :
 * `CertificateServiceHost.nowMs`, fournie par le contexte Linux (`executor.simulatedDate()`) et par celui de Windows
 * (`WindowsShellExecutor.nowMs`).
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (serveur en avance de deux jours). Le TEMOIN (a
 * l'heure, le certificat de vingt-quatre heures ouvre la session) passe des deux cotes. Le chemin Windows partage le service et
 * n'a pas de sonde propre ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildLab, TRUST, SSH, certify, authLog } from './_sshCertLab';

const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('sshd juge la validite d un certificat sur l horloge du serveur', () => {
  it('TEMOIN — a l heure, un certificat de vingt-quatre heures ouvre la session', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -V -1h:+1d');
    expect((await lab.pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('un serveur avance de deux jours refuse ce certificat : expired', async () => {
    const lab = await buildLab([TRUST]);
    await certify(lab, '-n alice -V -1h:+1d');
    lab.srv._stepSystemClock(2 * DAY);
    expect(await lab.pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
    expect(await authLog(lab)).toContain('error: Certificate invalid: expired');
  }, 120_000);
});
