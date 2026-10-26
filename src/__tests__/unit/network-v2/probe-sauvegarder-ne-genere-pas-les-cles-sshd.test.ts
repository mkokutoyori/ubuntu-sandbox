/**
 * Sauvegarder une topologie generait les cles d'hote sshd de CHAQUE machine Linux. Mesure (Node) : exportTopology de 6 postes Linux neufs = 5,2 s, dont
 * 4,7 s en recherche de nombres premiers RSA ; 21 equipements = 19 s, 63 equipements = 39 s, donc l'onglet fige plusieurs minutes pour enregistrer un
 * laboratoire de quelques dizaines de postes. captureLinuxFiles lisait le contenu de /etc/ssh/ssh_host_rsa_key (contenu differe, genere a la premiere
 * lecture, deterministe d'apres le nom de la machine) pour le comparer au jumeau d'usine, qui le generait a son tour.
 *
 * Un fichier dont le contenu n'a pas encore ete genere, et dont le proprietaire et les droits sont ceux du jumeau, ne peut pas differer du jumeau : il
 * n'est plus lu. Un fichier genere, edite ou dont les droits ont change est capture comme avant.
 *
 * Meme defaut sur Windows (captureWindowsFiles lisait les cles d'hote differees de C:\\ProgramData\\ssh) : 3 postes neufs = 2,7 s avant, moins de 0,3 s apres.
 *
 * Discrimine par `git stash push -- src/store src/network/core/DeferredContent.ts` : le cas de la duree tombe (4,1 s avant pour 5 postes, 0,3 s apres).
 * Passent des deux cotes, TEMOINS : un fichier edite est capture, un fichier de cle aux droits modifies est capture, la machine rouverte garde ses cles.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const asMap = (devices: Equipment[]) => new Map(devices.map((device) => [device.getId(), device]));

describe('enregistrer une topologie ne genere pas les cles d hote sshd', () => {
  it('cinq postes Linux neufs s exportent en moins de 2,5 s', () => {
    const pcs = Array.from({ length: 5 }, (_, index) => new LinuxPC('linux-pc', `PC${index + 1}`));
    const startedAt = performance.now();
    exportTopology('lab', asMap(pcs), []);
    expect(performance.now() - startedAt).toBeLessThan(2500);
  }, 60_000);

  it('TEMOIN — un fichier edite est capture', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo "bienvenue" | sudo tee /etc/motd');
    const [entry] = exportTopology('lab', asMap([pc]), []).devices;
    const files = (entry as unknown as { files?: { path: string; content: string }[] }).files ?? [];
    expect(files.find((file) => file.path === '/etc/motd')?.content).toContain('bienvenue');
  }, 60_000);

  it('TEMOIN — une cle aux droits modifies est capturee avec ses droits', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sudo chmod 640 /etc/ssh/ssh_host_ed25519_key.pub');
    const [entry] = exportTopology('lab', asMap([pc]), []).devices;
    const files = (entry as unknown as { files?: { path: string; mode: number }[] }).files ?? [];
    expect(files.find((file) => file.path === '/etc/ssh/ssh_host_ed25519_key.pub')?.mode).toBe(0o640);
  }, 60_000);

  it('TEMOIN — la machine rouverte a ses cles d hote', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const json = JSON.parse(JSON.stringify(exportTopology('lab', asMap([pc]), [])));
    const reopened = await importTopology(json);
    const device = [...reopened.deviceInstances.values()][0] as LinuxPC;
    expect(await device.executeCommand('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).toMatch(/ED25519/);
  }, 60_000);
});

describe('sur Windows aussi', () => {
  it('trois postes Windows neufs s exportent en moins de 1,5 s', () => {
    const pcs = Array.from({ length: 3 }, (_, index) => new WindowsPC('windows-pc', `W${index + 1}`));
    const startedAt = performance.now();
    exportTopology('lab', asMap(pcs), []);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  }, 60_000);

  it('TEMOIN — un fichier cree est capture', async () => {
    const pc = new WindowsPC('windows-pc', 'W1');
    await pc.executeCommand('echo bonjour > C:\\Users\\User\\note.txt');
    const [entry] = exportTopology('lab', asMap([pc]), []).devices;
    const files = (entry as unknown as { files?: { path: string; content: string }[] }).files ?? [];
    expect(files.find((file) => file.path.endsWith('note.txt'))?.content).toContain('bonjour');
  }, 60_000);
});
