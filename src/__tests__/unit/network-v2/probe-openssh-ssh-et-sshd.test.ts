/**
 * `ssh` et `sshd` — ecrits A L'AVEUGLE depuis OpenSSH, avant toute lecture
 * de l'implantation de ce depot.
 *
 * Sources, clonees pour ce lot (`github.com/openssh/openssh-portable`).
 *
 * `ssh.1`, section EXIT STATUS, mot pour mot : « ssh exits with the exit
 * status of the remote command or with 255 if an error occurred. » C'est
 * la promesse la plus verifiable du client, et celle dont depend tout
 * script qui enchaine sur `&&`.
 *
 * `ssh.1` encore : `-p port`, `-i identite`, `-N` (n'execute aucune
 * commande distante), `-t` (force l'allocation d'un pseudo-terminal),
 * `-q` (mode silencieux), `-o option`.
 *
 * `sshd.8` : `-t` « Test mode. Only check the validity of the
 * configuration file and sanity of the keys », et `-T` « extended test
 * mode » qui ECRIT sur la sortie standard la configuration effective.
 *
 * Windows 10 et Windows Server 2019+ livrent le client OpenSSH, donc
 * `ssh` y est eprouve aussi.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

const SRV = '10.0.0.2';

async function labo(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const m = new SubnetMask('255.255.255.0');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPort('eth0')!.configureIP(new IPAddress(SRV), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  return { pc, srv };
}

const SSH = `ssh -o StrictHostKeyChecking=no alice@${SRV}`;

describe('ssh : le code de retour est CELUI de la commande distante', () => {
  it('une commande distante qui reussit rend 0', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(`${SSH} true; echo rc=$?`)).trim()).toContain('rc=0');
  });

  it('une commande distante qui echoue rend SON code, pas 0', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(`${SSH} false; echo rc=$?`)).trim()).toContain('rc=1');
  });

  it('un code distant ARBITRAIRE remonte tel quel', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(`${SSH} "exit 42"; echo rc=$?`)).trim()).toContain('rc=42');
  });

  it('une erreur du client rend 255, et non le code d une commande', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(
      'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 alice@10.0.0.77 true; echo rc=$?');
    expect(out).toContain('rc=255');
  });
});

describe('ssh : la commande distante tourne SUR le serveur, sous l identite ouverte', () => {
  it('`whoami` rend l utilisateur SSH', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  });

  it('un fichier cree a distance existe LA-BAS, et pas ici', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`${SSH} "touch /tmp/marqueur-distant"`);
    expect(await srv.executeCommand('test -f /tmp/marqueur-distant && echo OUI')).toContain('OUI');
    expect(await pc.executeCommand('test -f /tmp/marqueur-distant && echo OUI || echo NON')).toContain('NON');
  });

  it('la sortie distante est celle du serveur, pas du client', async () => {
    const { pc, srv } = await labo();
    await srv.executeCommand('sudo hostnamectl set-hostname serveur-distant');
    expect((await pc.executeCommand(`${SSH} hostname`)).trim()).toBe('serveur-distant');
  });
});

describe('ssh : les drapeaux que la page man decrit', () => {
  it('`-p` vise le port demande, et un port ferme est REFUSE', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(
      `ssh -o StrictHostKeyChecking=no -p 2222 alice@${SRV} true`);
    expect(out).toMatch(/Connection refused|Connection timed out/);
  });

  it('`-N` n execute AUCUNE commande distante', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(`ssh -o StrictHostKeyChecking=no -N alice@${SRV} "touch /tmp/ne-doit-pas-exister"`);
    expect(await srv.executeCommand('test -f /tmp/ne-doit-pas-exister && echo OUI || echo NON'))
      .toContain('NON');
  });

  it('sans `-t`, la commande distante n a PAS de terminal', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(`${SSH} tty`)).trim()).toContain('not a tty');
  });

  it('`-t` force un pseudo-terminal', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(`ssh -o StrictHostKeyChecking=no -t alice@${SRV} tty`);
    expect(out).not.toContain('not a tty');
    expect(out).toMatch(/\/dev\/(pts\/\d+|tty\S*)/);
  });

  it('Windows : `ssh` existe et rend la reponse du serveur', async () => {
    const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV1');
    win.powerOn(); srv.powerOn();
    new Cable('c1').connect(win.getPorts()[0], srv.getPort('eth0')!);
    const m = new SubnetMask('255.255.255.0');
    win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
    srv.getPort('eth0')!.configureIP(new IPAddress(SRV), m);
    await srv.executeCommand('sudo systemctl start ssh');
    await srv.executeCommand('sudo useradd -m alice');
    await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
    expect((await win.executeCommand(`ssh -o StrictHostKeyChecking=no alice@${SRV} whoami`)).trim())
      .toBe('alice');
  });
});

describe('sshd : le mode TEST de la page man', () => {
  it('`sshd -t` sur une configuration saine ne dit RIEN et rend 0', async () => {
    const { srv } = await labo();
    const out = await srv.executeCommand('sudo sshd -t; echo rc=$?');
    expect(out).toContain('rc=0');
    expect(out.replace(/rc=0/, '').trim()).toBe('');
  });

  it('`sshd -t` sur une configuration cassee REFUSE en nommant la ligne', async () => {
    const { srv } = await labo();
    await srv.executeCommand('echo "ZorglubOption oui" | sudo tee -a /etc/ssh/sshd_config');
    const out = await srv.executeCommand('sudo sshd -t; echo rc=$?');
    expect(out).not.toContain('rc=0');
    expect(out).toContain('sshd_config');
  });

  it('`sshd -T` ECRIT la configuration effective, en mots-cles minuscules', async () => {
    const { srv } = await labo();
    const out = await srv.executeCommand('sudo sshd -T');
    expect(out).toMatch(/^port 22$/m);
    expect(out).toMatch(/^permitrootlogin /m);
    expect(out).toMatch(/^passwordauthentication /m);
  });

  it('une directive posee dans sshd_config se relit dans `sshd -T`', async () => {
    const { srv } = await labo();
    await srv.executeCommand('echo "PermitRootLogin no" | sudo tee -a /etc/ssh/sshd_config');
    expect(await srv.executeCommand('sudo sshd -T')).toMatch(/^permitrootlogin no$/m);
  });

  it('le demon ECOUTE reellement le port 22 une fois demarre', async () => {
    const { srv } = await labo();
    expect(await srv.executeCommand('ss -tln')).toMatch(/:22\b/);
  });
});
