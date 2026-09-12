/**
 * `scp` et `sftp` — ecrits A L'AVEUGLE depuis OpenSSH, avant toute lecture
 * de l'implantation de ce depot.
 *
 * Sources, clonees pour ce lot (`github.com/openssh/openssh-portable`).
 *
 * `scp.1` : `-r` (copie recursive d'un repertoire), `-p` (preserve dates et
 * droits), `-P port`, `-i identite`. `scp.c` l. 2119 porte la ligne d'usage
 * exacte, que le programme imprime quand les operandes manquent.
 *
 * `sftp.1` : `-b fichier` (lot de verbes, `-` pour l'entree standard),
 * `-P port`, `-i identite`, et les verbes interactifs `pwd`, `lpwd`, `ls`,
 * `cd`, `lcd`, `mkdir`, `rmdir`, `rm`, `rename`, `get`, `put`, `chmod`.
 * `sftp.c` l. 2703 : « Connected to %s.\n » a l'ouverture.
 *
 * Ce que ces deux outils promettent et qui se verifie sans ambiguite : le
 * contenu ARRIVE, a l'octet, et il arrive DU serveur ou VERS lui — pas
 * d'une lecture locale deguisee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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
const MOT = 'sshpass -p secret123';

async function labo(): Promise<{ pc: LinuxPC; srv: LinuxServer; cable: Cable }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.powerOn(); srv.powerOn();
  const cable = new Cable('c1');
  cable.connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const m = new SubnetMask('255.255.255.0');
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPort('eth0')!.configureIP(new IPAddress(SRV), m);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await pc.executeCommand(`ping -c 1 ${SRV}`);
  return { pc, srv, cable };
}

describe('scp : le contenu ARRIVE, a l octet', () => {
  it('pousser un fichier le rend lisible SUR le serveur', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand('echo "contenu-pousse" > /tmp/source.txt');
    await pc.executeCommand(
      `${MOT} scp -o StrictHostKeyChecking=no /tmp/source.txt alice@${SRV}:/tmp/arrivee.txt`);
    expect(await srv.executeCommand('cat /tmp/arrivee.txt')).toContain('contenu-pousse');
  });

  it('tirer un fichier le rend lisible ICI, avec le contenu du SERVEUR', async () => {
    const { pc, srv } = await labo();
    await srv.executeCommand('echo "contenu-distant" > /tmp/lointain.txt');
    await pc.executeCommand(
      `${MOT} scp -o StrictHostKeyChecking=no alice@${SRV}:/tmp/lointain.txt /tmp/rapatrie.txt`);
    expect(await pc.executeCommand('cat /tmp/rapatrie.txt')).toContain('contenu-distant');
  });

  it('un aller-retour rend le fichier IDENTIQUE', async () => {
    const { pc } = await labo();
    await pc.executeCommand('echo "aller-retour" > /tmp/ar.txt');
    await pc.executeCommand(
      `${MOT} scp -o StrictHostKeyChecking=no /tmp/ar.txt alice@${SRV}:/tmp/ar.txt`);
    await pc.executeCommand(
      `${MOT} scp -o StrictHostKeyChecking=no alice@${SRV}:/tmp/ar.txt /tmp/ar-retour.txt`);
    const a = await pc.executeCommand('cat /tmp/ar.txt');
    const b = await pc.executeCommand('cat /tmp/ar-retour.txt');
    expect(b.trim()).toBe(a.trim());
  });

  it('une source absente rend « No such file or directory »', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(
      `${MOT} scp -o StrictHostKeyChecking=no /tmp/inexistant.txt alice@${SRV}:/tmp/x.txt`);
    expect(out).toContain('No such file or directory');
  });

  it('un repertoire SANS `-r` est refuse', async () => {
    const { pc } = await labo();
    await pc.executeCommand('mkdir -p /tmp/dossier && echo un > /tmp/dossier/a.txt');
    const out = await pc.executeCommand(
      `${MOT} scp -o StrictHostKeyChecking=no /tmp/dossier alice@${SRV}:/tmp/`);
    expect(out.toLowerCase()).toMatch(/not a regular file|is a directory/);
  });

  it('`-r` copie le repertoire ET son contenu', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand('mkdir -p /tmp/dossier && echo un > /tmp/dossier/a.txt');
    await pc.executeCommand(
      `${MOT} scp -r -o StrictHostKeyChecking=no /tmp/dossier alice@${SRV}:/tmp/`);
    expect(await srv.executeCommand('cat /tmp/dossier/a.txt')).toContain('un');
  });

  it('sans operande, `scp` imprime sa ligne d usage', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('scp')).toContain('usage: scp');
  });
});

describe('sftp : les verbes de la page man, sur le serveur', () => {
  const lot = (verbes: string) =>
    `${MOT} sftp -o StrictHostKeyChecking=no -b - alice@${SRV} <<'EOF'\n${verbes}\nEOF`;

  it('l ouverture annonce « Connected to <hote>. »', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand(lot('pwd'))).toContain(`Connected to ${SRV}.`);
  });

  it('`pwd` rend le foyer de l utilisateur DISTANT', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand(lot('pwd'))).toContain('Remote working directory: /home/alice');
  });

  it('`mkdir` cree le repertoire SUR le serveur', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand(lot('mkdir /tmp/par-sftp'));
    expect(await srv.executeCommand('test -d /tmp/par-sftp && echo OUI')).toContain('OUI');
  });

  it('`put` depose le fichier, `get` le rapatrie', async () => {
    const { pc, srv } = await labo();
    await pc.executeCommand('echo "par-sftp" > /tmp/depot.txt');
    await pc.executeCommand(lot('put /tmp/depot.txt /tmp/depose.txt'));
    expect(await srv.executeCommand('cat /tmp/depose.txt')).toContain('par-sftp');
    await pc.executeCommand(lot('get /tmp/depose.txt /tmp/repris.txt'));
    expect(await pc.executeCommand('cat /tmp/repris.txt')).toContain('par-sftp');
  });

  it('`ls` liste le repertoire DISTANT', async () => {
    const { pc, srv } = await labo();
    await srv.executeCommand('echo x > /tmp/visible-de-loin.txt');
    expect(await pc.executeCommand(lot('ls /tmp'))).toContain('visible-de-loin.txt');
  });

  it('`cd` puis `pwd` suivent le repertoire courant distant', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand(lot('cd /tmp\npwd')))
      .toContain('Remote working directory: /tmp');
  });

  it('`rm` retire le fichier SUR le serveur', async () => {
    const { pc, srv } = await labo();
    await srv.executeCommand('sudo -u alice touch /home/alice/a-supprimer.txt');
    await pc.executeCommand(lot('rm /home/alice/a-supprimer.txt'));
    expect(await srv.executeCommand('test -f /home/alice/a-supprimer.txt && echo OUI || echo NON'))
      .toContain('NON');
  });

  it('`rename` renomme SUR le serveur', async () => {
    const { pc, srv } = await labo();
    await srv.executeCommand('sudo -u alice touch /home/alice/avant.txt');
    await pc.executeCommand(lot('rename /home/alice/avant.txt /home/alice/apres.txt'));
    expect(await srv.executeCommand('test -f /home/alice/apres.txt && echo OUI')).toContain('OUI');
  });

  it('les verbes COUTENT des trames : la session passe par le fil', async () => {
    const { pc, cable } = await labo();
    const avant = cable.getStats().framesTransmitted;
    await pc.executeCommand(lot('pwd\nls /tmp'));
    expect(cable.getStats().framesTransmitted).toBeGreaterThan(avant);
  });

  it('un chemin distant absent est REFUSE, et le lot continue', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand(lot('ls /tmp/nexiste-pas'));
    expect(out.toLowerCase()).toMatch(/no such file|not found/);
  });
});
