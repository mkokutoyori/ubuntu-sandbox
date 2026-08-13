/**
 * Le client sftp de Windows doit obéir au compte qu'il a nommé.
 *
 * `runWindowsSftpClient` calcule bien `remoteUser` — il s'en sert pour la
 * sonde d'authentification — puis résout le système de fichiers distant
 * en l'ignorant, sous `uid 0, gid 0` et sans décorateur de permissions.
 * Un compte quelconque y lit donc ce que seul root peut lire.
 *
 * La mesure ne peut pas être « le transfert marche » : il marchait déjà.
 * Elle est un fichier que le compte nommé n'a PAS le droit de lire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

const WIN = '10.93.0.10';
const SRV = '10.93.0.20';
const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab() {
  const win = new WindowsPC('windows-pc', 'WIN');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(win.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  win.getPorts()[0].configureIP(new IPAddress(WIN), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SRV), MASK);
  win.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash bob');
  await server.executeCommand(`sh -c 'echo "bob:secret" | chpasswd'`);
  await server.executeCommand(`sh -c 'echo TOP-SECRET > /root/coffre.txt'`);
  await server.executeCommand('chmod 600 /root/coffre.txt');
  await server.executeCommand('chown root:root /root/coffre.txt');
  return { win, server };
}

/**
 * `cmd.exe` n'a pas de document en ligne : la forme honnête d'un lot
 * sftp sur Windows est `-b <fichier>`, et c'est celle que la vraie
 * `sftp.exe` documente.
 */
async function sftpBatch(win: WindowsPC, verbs: string[], target: string): Promise<string> {
  await win.executeCommand(`echo ${verbs.join(' & echo ')} > C:\\lot.txt`);
  return win.executeCommand(`sftp -b C:\\lot.txt ${target}`);
}

describe('le client sftp de Windows obéit au compte nommé', () => {
  it("bob ne lit pas un fichier réservé à root", async () => {
    const { win } = await lab();
    const out = await sftpBatch(win, ['get /root/coffre.txt C:\\vole.txt'], `bob@${SRV}`);
    // La session s'ouvre bien — sans ce témoin, un refus de connexion
    // ferait passer le cas sans rien prouver.
    expect(out).toContain('Connected to');
    expect(out).not.toContain('TOP-SECRET');
    expect(await win.executeCommand('type C:\\vole.txt')).not.toContain('TOP-SECRET');
  }, 60_000);

  it("la référence : bob lit bien ce qui lui appartient", async () => {
    const { win, server } = await lab();
    await server.executeCommand(`sh -c 'echo A-MOI > /home/bob/note.txt'`);
    await server.executeCommand('chown bob:bob /home/bob/note.txt');

    const out = await sftpBatch(win, ['get /home/bob/note.txt C:\\note.txt'], `bob@${SRV}`);
    expect(out).toContain('Connected to');
    expect(await win.executeCommand('type C:\\note.txt')).toContain('A-MOI');
  }, 60_000);
});
