/**
 * `sudo bash script.sh` doit attendre ce que le script lance.
 *
 * La Phase 2 a routé `bash <script>` vers son jumeau asynchrone pour
 * qu'une commande réseau à l'intérieur du fichier soit vraiment attendue.
 * Elle s'est délibérément arrêtée devant `sudo`, parce que la politique
 * sudoers vit dans le dispatch synchrone : la contourner aurait été pire
 * que le trou. Le résultat est qu'aujourd'hui la même ligne donne deux
 * résultats selon qu'on l'élève ou non.
 *
 * La mesure est la comparaison des deux écritures — sans elle, une
 * sortie vide ressemblerait à un script qui n'a rien à dire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

const CLI = '10.94.0.10';
const SRV = '10.94.0.20';
const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab() {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress(CLI), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SRV), MASK);
  client.powerOn();
  server.powerOn();
  await client.executeCommand(
    `sh -c 'printf "#!/bin/bash\\nping -c 1 ${SRV}\\n" > /tmp/sonde.sh'`);
  await client.executeCommand('chmod +x /tmp/sonde.sh');
  return { client };
}

describe('sudo n\'enlève pas au script son attente', () => {
  it('la référence : sans sudo, le ping du script rend son résultat', async () => {
    const { client } = await lab();
    const out = await client.executeCommand('bash /tmp/sonde.sh');
    expect(out).toMatch(/1 packets transmitted/);
  }, 60_000);

  it('avec sudo, la même ligne rend le même résultat', async () => {
    const { client } = await lab();
    const out = await client.executeCommand('sudo bash /tmp/sonde.sh');
    expect(out).toMatch(/1 packets transmitted/);
  }, 60_000);

  /**
   * Le garde-fou : router `sudo` vers le chemin asynchrone ne doit pas
   * lui faire sauter la politique sudoers. Sans ce cas, le correctif
   * précédent aurait pu ouvrir un trou au lieu de combler un manque.
   */
  it("un compte hors sudoers est refusé, et le script ne tourne pas", async () => {
    const { client } = await lab();
    await client.executeCommand('useradd -m -s /bin/bash mallory');
    // `su` ne persiste pas d'un `executeCommand` à l'autre : c'est le
    // compte courant de la machine qu'il faut poser, sinon la ligne
    // tourne sous `user`, qui EST sudoer, et le cas ne mesure rien.
    const um = (client as unknown as {
      executor: { userMgr: { currentUser: string; currentUid: number; currentGid: number } };
    }).executor.userMgr;
    um.currentUser = 'mallory';
    um.currentUid = 1001;
    um.currentGid = 1001;

    const out = await client.executeCommand('sudo bash /tmp/sonde.sh');
    expect(out).toMatch(/is not in the sudoers file/);
    expect(out).not.toMatch(/1 packets transmitted/);
  }, 60_000);
});
