/*
 * Un export de topologie rendait chaque fichier Linux a root, en 0644, et
 * creait ses repertoires parents a root.
 *
 * Mesure de depart, sur la topologie de l'utilisateur
 * (`lan_with_firewall_fortigate.topology (1).json`, commit 16b70e5aa) :
 * apres import, sur PC1,
 *
 *   drwxr-xr-x 2 root root  /home/user/.ssh
 *   -rw-r--r-- 1 root root  /home/user/.ssh/known_hosts
 *
 * L'entree exportee ne portait que `{ path, content }`, et la restauration
 * ecrivait tout en uid 0 / gid 0 / umask 022. L'utilisateur `user` ne
 * pouvait donc plus ecrire dans son propre ~/.ssh : `ssh-keygen` y
 * echouait, et la connexion par cle vers Server1 tombait — deux cas du banc
 * `user lab` rouges pour cette seule raison.
 *
 * L'AUTORITE EST POSIX et le fait mesure : un fichier appartient a qui
 * l'a cree, avec le mode qu'il porte ; une sauvegarde qui le restaure a
 * root change qui peut le lire et l'ecrire. L'export porte desormais
 * uid, gid et mode, pour les fichiers ET pour les repertoires que
 * l'utilisateur a crees ; un export plus ancien, qui ne les porte pas,
 * herite du proprietaire du plus proche repertoire existant — ce qu'un
 * `ssh` lance par `user` aurait fait de toute facon.
 *
 * Ecrite a l'aveugle contre ce fait, avant de lire la restauration.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/store`) :
 * 3 des 4 cas tombent. Le TEMOIN, un fichier de root, passe des deux
 * cotes : restaurer a root ce qui etait a root ne change rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function roundTrip(pc: LinuxPC): Promise<LinuxPC> {
  const exported = exportTopology('lab', new Map([[pc.getId(), pc as never]]), []);
  EquipmentRegistry.resetInstance();
  const imported = await importTopology(JSON.parse(JSON.stringify(exported)) as TopologyExport);
  return [...imported.deviceInstances.values()][0] as unknown as LinuxPC;
}

describe('un fichier revient a qui l\'a cree, avec son mode', () => {
  it('~/.ssh et sa cle restent a `user`, en 0700 et 0600', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');

    const back = await roundTrip(pc);

    expect(await back.executeCommand('stat -c "%U:%G %a" ~/.ssh ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub'))
      .toBe('user:user 700\nuser:user 600\nuser:user 644');
  }, 30000);

  it('apres import, `user` peut encore ecrire dans son ~/.ssh', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');

    const back = await roundTrip(pc);

    expect(await back.executeCommand('touch ~/.ssh/config; echo EC=$?')).toBe('EC=0');
  }, 30000);

  it('un fichier de root garde proprietaire et mode — TEMOIN', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    await pc.executeCommand('sudo bash -c "echo 10.0.0.9 lab >> /etc/hosts"');
    const before = await pc.executeCommand('stat -c "%U:%G %a" /etc/hosts');

    const back = await roundTrip(pc);

    expect(await back.executeCommand('stat -c "%U:%G %a" /etc/hosts')).toBe(before);
    expect(before).toMatch(/^root:root /);
  }, 30000);
});

describe('un export ancien, sans proprietaire, herite du repertoire existant', () => {
  it('~/.ssh/known_hosts revient a `user`', async () => {
    const legacy: TopologyExport = {
      version: 1, projectName: 'lab', exportedAt: '2026-09-27T00:00:00Z',
      devices: [{
        id: 'pc-1', type: 'linux-pc', name: 'PC1', hostname: 'PC1', x: 0, y: 0, isPoweredOn: true,
        interfaces: [],
        files: [{ path: '/home/user/.ssh/known_hosts', content: '192.168.30.4 ssh-ed25519 AAAA\n' }],
      }],
      connections: [],
    } as unknown as TopologyExport;

    const imported = await importTopology(legacy);
    const pc = [...imported.deviceInstances.values()][0] as unknown as LinuxPC;

    expect(await pc.executeCommand('stat -c "%U:%G" ~/.ssh ~/.ssh/known_hosts')).toBe('user:user\nuser:user');
  }, 30000);
});
