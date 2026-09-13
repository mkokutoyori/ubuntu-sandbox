/**
 * La cle que `ssh-keygen` fabrique sous Windows est celle que `ssh` offre.
 *
 * Ecrite a l'aveugle depuis OpenSSH et la documentation du portage Windows,
 * avant toute lecture de l'implantation :
 *
 *   - sans `-f`, ssh-keygen.c l. 3860 ecrit sous `~/.ssh/id_<type>` ; le
 *     portage Windows resout `~` en `%USERPROFILE%`, donc
 *     `C:\Users\<utilisateur>\.ssh\id_ed25519` ;
 *   - `ssh-add` sans argument charge les identites par defaut du meme
 *     repertoire (ssh-add.c, DEFAULT_FILES) ;
 *   - `ssh-copy-id` n'existe pas sous Windows : la cle publique s'installe
 *     a la main dans l'`authorized_keys` du serveur, ce que fait ce labo —
 *     y compris les droits, car StrictModes refuse un `authorized_keys`
 *     lisible par le groupe ou par tous (`LinuxSshServerContext`, masque
 *     0o077). `sudo tee` le cree en 0644 : sans `chmod 600`, le serveur a
 *     raison de refuser la cle.
 *
 * Le point eprouve n'est pas le format mais la CHAINE : ce que le
 * generateur ecrit, l'agent le lit, et le serveur l'accepte sur le fil.
 *
 * Mesure : 0 cas sur 3 tombe. La chaine tenait deja une fois les outils
 * livres par le lot precedent — cette sonde est une NON-REGRESSION qui fixe
 * le contrat de bout en bout, et le troisieme cas est le TEMOIN qu'une
 * authentification par cle traverse vraiment le fil jusqu'au serveur
 * (`PasswordAuthentication=no` interdit le repli par mot de passe).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function labo(): Promise<{ win: WindowsPC; srv: LinuxServer }> {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  win.powerOn(); srv.powerOn();
  new Cable('c1').connect(win.getPorts()[0], srv.getPorts()[0]);
  const m = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  return { win, srv };
}

describe('la chaine ssh-keygen -> ssh-add -> ssh tient sous Windows', () => {
  it('sans `-f`, la paire atterrit sous le profil de l utilisateur', async () => {
    const { win } = await labo();
    const out = await win.executeCommand('ssh-keygen -t ed25519 -N ""');
    expect(out).toContain('\\.ssh\\id_ed25519');
    const pub = await win.executeCommand('type %USERPROFILE%\\.ssh\\id_ed25519.pub');
    expect(pub.trim().startsWith('ssh-ed25519 ')).toBe(true);
  });

  it('`ssh-add` sans argument trouve l identite par defaut', async () => {
    const { win } = await labo();
    await win.executeCommand('ssh-keygen -t ed25519 -N ""');
    const ajout = await win.executeCommand('ssh-add');
    expect(ajout).toContain('Identity added:');
    expect((await win.executeCommand('ssh-add -l')).trim()).toMatch(/\(ED25519\)$/m);
  });

  it('la cle installee sur le serveur ouvre la session SANS mot de passe', async () => {
    const { win, srv } = await labo();
    await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\cle');
    const publique = (await win.executeCommand('type C:\\cle.pub')).trim();
    await srv.executeCommand('sudo mkdir -p /home/alice/.ssh');
    await srv.executeCommand(`echo "${publique}" | sudo tee -a /home/alice/.ssh/authorized_keys`);
    await srv.executeCommand('sudo chown -R alice:alice /home/alice/.ssh');
    await srv.executeCommand('sudo chmod 700 /home/alice/.ssh');
    await srv.executeCommand('sudo chmod 600 /home/alice/.ssh/authorized_keys');
    const out = await win.executeCommand(
      'ssh -o StrictHostKeyChecking=no -o PasswordAuthentication=no -i C:\\cle alice@10.0.0.2 hostname');
    expect(out.trim()).toBe('linux-server');
    expect(out).not.toMatch(/Permission denied/);
  });
});
