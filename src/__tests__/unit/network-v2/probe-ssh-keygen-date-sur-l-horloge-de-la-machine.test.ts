/**
 * `ssh-keygen -s ... -V +1d` compte « +1d » a partir de maintenant : l'instant de reference est celui du poste. Les dialogues
 * de ssh-keygen (certificats, signatures, revocation) lisaient `host.nowSeconds` ou, a defaut, `simulationNowMs()` ; aucun hote
 * ne fournissait `nowSeconds`, donc un poste dont on avait pose l'horloge (`date -s`) delivrait des certificats dates de l'heure
 * globale. Corrige : `KeygenIdentity.nowSeconds`, fournie par la machine Linux (`simulatedDate()`) et par celle de Windows.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (poste dont l'horloge a avance de dix jours). Le TEMOIN
 * (horloge intacte, le certificat de vingt-quatre heures est delivre et valable) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';

const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function certificate(pc: LinuxPC): Promise<string> {
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/ca");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -f ~/id");
  await pc.executeCommand('ssh-keygen -s ~/ca -I probe -n alice -V +1d ~/id.pub');
  return pc.executeCommand('ssh-keygen -L -f ~/id-cert.pub');
}

describe('ssh-keygen date les certificats sur l horloge du poste', () => {
  it('TEMOIN — « Valid: from ... to ... » couvre l instant courant du poste', async () => {
    const pc = new LinuxPC('linux-pc', 'pc');
    const out = await certificate(pc);
    const year = new Date(pc.getSystemClockMs()).getUTCFullYear();
    expect(out).toContain(`Valid: from ${year}`);
  });

  it('un poste avance de dix jours delivre un certificat qui commence apres cette date', async () => {
    const pc = new LinuxPC('linux-pc', 'pc');
    pc._stepSystemClock(10 * DAY);
    const out = await certificate(pc);
    const from = /Valid: from (\d{4}-\d{2}-\d{2})/.exec(out)![1];
    const expected = new Date(pc.getSystemClockMs() - 10 * 60 * 1000).toISOString().slice(0, 10);
    expect(from).toBe(expected);
  });
});
