/**
 * La persistance d'une topologie ne doit garder QUE ce qui a change depuis l'instanciation des
 * equipements, pas ce que la fabrique provisionne a chaque creation. Le point de comparaison de
 * l'export etait un systeme de fichiers NU (`new VirtualFileSystem()`), pas une machine neuve : toute
 * l'image (binaires, unites systemd, modules, /etc, journaux de demarrage) etait donc ecrite.
 *
 * MESURE (une machine neuve, rien touche, `exportTopology`) : `linux-pc` 144 947 octets (134 641 de
 * fichiers, 2 459 d'unites systemd), `linux-server` 152 847, `windows-pc` 10 927 (journaux .evtx, compte
 * `User`), `firewall-fortinet` 14 388 (certificat et cle generes a chaque instance). Les seuls points de
 * comparaison honnetes sont le JUMEAU d'usine du meme equipement (`withFactoryTwin`) : la meme machine
 * telle que `createDevice` la construit, jetee apres comparaison sans toucher au registre, au compteur
 * de MAC ni au journal. Les journaux d'execution (`/var/log`, `.evtx`) et les horodatages de compte
 * sont de l'etat d'execution, pas de la configuration : ils ne sont plus ecrits.
 *
 * Apres correction : `linux-pc` 471 octets, `windows-pc` 372, `firewall-fortinet` 693. Ce qui a change
 * est ecrit — fichier cree ou edite, fichier SUPPRIME (`removedPaths`, avant on ne savait pas ecrire
 * une suppression), unite systemd modifiee, compte cree ou supprime — et revient a l'importation.
 *
 * Discriminee contre l'etat d'avant (`git stash` des sources) : 16 des 18 cas tombent. Les 2 qui passent des
 * deux cotes sont NOMMES : le temoin « une machine neuve exportee puis rouverte garde son image » (il
 * prouve que ne pas ecrire l'image ne la perd pas) et « un fichier au format complet d'avant s'ouvre
 * encore » (non-regression : l'importation applique un fichier complet comme un fichier delta).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, Logger, MACAddress, IPAddress, SubnetMask, type Equipment } from '@/network';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const asMap = (devices: Equipment[]) => new Map(devices.map((d) => [d.getId(), d]));
const exportOf = (devices: Equipment[]) => exportTopology('lab', asMap(devices), []);

async function roundTrip(devices: Equipment[]) {
  const json = JSON.parse(JSON.stringify(exportOf(devices)));
  const reopened = await importTopology(json);
  const byName = (name: string) => [...reopened.deviceInstances.values()].find((d) => d.getName() === name)!;
  return { json, byName };
}

const IDENTITY_KEYS = ['id', 'type', 'name', 'x', 'y', 'isPoweredOn', 'interfaces'];
const FRESH_TYPES = [
  'linux-pc', 'linux-server', 'windows-pc', 'windows-server', 'switch-cisco', 'switch-huawei',
  'switch-generic', 'router-cisco', 'router-huawei', 'firewall-cisco', 'firewall-fortinet',
] as const;

describe('a machine nobody touched writes nothing it was provisioned with', () => {
  for (const type of FRESH_TYPES) {
    it(`${type}: only its identity and its interfaces`, () => {
      const device = createDevice(type, 10, 20);
      const [entry] = exportOf([device]).devices;
      expect(Object.keys(entry).filter((key) => !IDENTITY_KEYS.includes(key))).toEqual([]);
      expect(JSON.stringify(entry).length).toBeLessThan(2_500);
    });
  }

  it('witness: a fresh machine exported then reopened still has its whole image', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const { byName } = await roundTrip([pc]);
    const reopened = byName('PC1') as LinuxPC;
    expect(await reopened.executeCommand('ls /usr/bin/sudo')).toContain('/usr/bin/sudo');
    expect(await reopened.executeCommand('systemctl is-enabled cron')).toContain('enabled');
    expect(await reopened.executeCommand('cat /etc/hostname')).toContain('PC1');
  });
});

describe('exporting leaves no trace on the lab', () => {
  it('registers no device, moves no MAC, writes no log line, reserves no name', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const win = new WindowsPC('windows-pc', 'W1');
    const registered = EquipmentRegistry.getInstance().getAll().length;
    const logs = Logger.getLogs().length;
    const nextMacBefore = MACAddress.preservingCounter(() => MACAddress.generate().toString());
    exportOf([pc, win]);
    expect(EquipmentRegistry.getInstance().getAll().length).toBe(registered);
    expect(Logger.getLogs().length).toBe(logs);
    expect(MACAddress.preservingCounter(() => MACAddress.generate().toString())).toBe(nextMacBefore);
  });
});

describe('what changed is written, and comes back', () => {
  it('Linux: a created file, an edited file, a deleted file and a changed service', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sudo mkdir -p /srv/lab');
    await pc.executeCommand("sudo sh -c 'echo hello > /srv/lab/note.txt'");
    await pc.executeCommand("sudo sh -c 'echo custom banner > /etc/issue'");
    await pc.executeCommand('sudo rm /etc/skel/.profile');
    await pc.executeCommand('sudo systemctl disable cron');

    const { json, byName } = await roundTrip([pc]);
    const entry = json.devices[0];
    expect((entry.files as { path: string }[]).map((f) => f.path).sort()).toEqual(['/etc/issue', '/srv/lab/note.txt']);
    expect(entry.removedPaths).toEqual(['/etc/skel/.profile', '/etc/systemd/system/multi-user.target.wants/cron.service']);
    expect((entry.linuxServices as { name: string }[]).map((s) => s.name)).toEqual(['cron']);

    const reopened = byName('PC1') as LinuxPC;
    expect(await reopened.executeCommand('cat /srv/lab/note.txt')).toContain('hello');
    expect(await reopened.executeCommand('cat /etc/issue')).toContain('custom banner');
    expect(await reopened.executeCommand('ls /etc/skel/.profile')).toContain('No such file');
    expect(await reopened.executeCommand('ls /etc/skel/.bashrc')).toContain('.bashrc');
    expect(await reopened.executeCommand('systemctl is-enabled cron')).toContain('disabled');
    expect(await reopened.executeCommand('systemctl is-enabled ssh')).toContain('enabled');
  });

  it('Windows: a created file, a deleted file and a created account', async () => {
    const win = new WindowsPC('windows-pc', 'W1');
    win.setCurrentUser('Administrator');
    win.getFileSystem().mkdirp('C:\\lab');
    win.getFileSystem().createFile('C:\\lab\\note.txt', 'hello');
    win.getFileSystem().deleteFile('C:\\Windows\\win.ini');
    await win.executeCommand('net user labuser Passw0rd!123 /add');

    const { json, byName } = await roundTrip([win]);
    const entry = json.devices[0];
    expect((entry.files as { path: string }[]).map((f) => f.path)).toEqual(['C:\\lab\\note.txt']);
    expect(entry.removedPaths).toEqual(['C:\\Windows\\win.ini']);
    expect(entry.windowsAccounts?.users.map((u) => u.name)).toEqual(['labuser']);

    const reopened = byName('W1') as WindowsPC;
    expect(reopened.getFileSystem().readFile('C:\\lab\\note.txt').content).toBe('hello');
    expect(reopened.getFileSystem().exists('C:\\Windows\\win.ini')).toBe(false);
    expect(reopened.getUserManager().getUser('labuser')).toBeDefined();
    expect(reopened.getUserManager().getUser('Administrator')).toBeDefined();
  });

  it('a router writes its configuration only once it differs from the factory one', async () => {
    const router = new CiscoRouter('R1');
    expect(exportOf([router]).devices[0].runningConfigText).toBeUndefined();
    router.configureInterface('GigabitEthernet0/0', new IPAddress('10.1.1.1'), new SubnetMask('255.255.255.0'));
    const { json, byName } = await roundTrip([router]);
    expect(json.devices[0].runningConfigText).toContain('10.1.1.1');
    const reopened = byName('R1') as CiscoRouter;
    expect(reopened.getPort('GigabitEthernet0/0')!.getIPAddress()!.toString()).toBe('10.1.1.1');
  });

  it('the hostname is written only when it is not the name', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(exportOf([pc]).devices[0].hostname).toBeUndefined();
    pc.setHostname('web01');
    const { json, byName } = await roundTrip([pc]);
    expect(json.devices[0].hostname).toBe('web01');
    expect(byName('PC1').getHostname()).toBe('web01');
  });

  it('a file written in the old full format still opens', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const json = JSON.parse(JSON.stringify(exportOf([pc])));
    json.devices[0].hostname = 'PC1';
    json.devices[0].files = [{ path: '/srv/old.txt', content: 'legacy', uid: 0, gid: 0, mode: 0o644 }];
    const reopened = await importTopology(json);
    const device = [...reopened.deviceInstances.values()][0] as LinuxPC;
    expect(await device.executeCommand('cat /srv/old.txt')).toContain('legacy');
    expect(await device.executeCommand('ls /usr/bin/sudo')).toContain('/usr/bin/sudo');
  });
});
