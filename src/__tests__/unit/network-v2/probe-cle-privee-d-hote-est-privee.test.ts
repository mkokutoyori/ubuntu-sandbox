/**
 * Le fichier de cle PRIVEE d'un hote ne contient pas sa cle PUBLIQUE.
 *
 * Ecrite a l'aveugle depuis ce qu'un administrateur verifie sur une vraie
 * machine : `ssh-keygen -y -f <cle privee>` relit la privee et IMPRIME la
 * publique correspondante (ssh-keygen.1, option -y). C'est la seule facon
 * de retrouver un `.pub` perdu, et c'est un geste courant.
 *
 * Les deux contextes serveur de ce depot ecrivaient a la main
 *
 *     -----BEGIN OPENSSH PRIVATE KEY-----
 *     <la cle PUBLIQUE>
 *     -----END OPENSSH PRIVATE KEY-----
 *
 * c'est-a-dire la publique dans le fichier de la privee — le meme defaut
 * que portait le second generateur de `ssh-keygen` supprime plus tot dans
 * cette campagne. Deux consequences : un apprenant qui ouvre
 * `ssh_host_ed25519_key` y lit la publique, et `ssh-keygen -y` repond
 * « invalid format » la ou une vraie machine rend la cle.
 *
 * `SshKeygenMaterial` sait deja fabriquer une privee dont on rededuit la
 * publique (c'est ce que `ssh-keygen` ecrit pour les cles d'utilisateur) ;
 * `SshHostKey` s'en sert desormais, donc le depot n'a plus qu'UN format de
 * cle privee, pour les hotes comme pour les utilisateurs.
 *
 * Mesure avant correction : 4 cas tombent sur 5.
 * Le cas qui passe des deux cotes est le TEMOIN : la cle PUBLIQUE sur le
 * disque est inchangee par ce lot — les germes restent deterministes, donc
 * aucun `known_hosts` existant n'est invalide.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const CLE_LINUX = '/etc/ssh/ssh_host_ed25519_key';
const CLE_WINDOWS = 'C:\\ProgramData\\ssh\\ssh_host_ed25519_key';

function blobDe(ligne: string): string {
  return ligne.trim().split(/\s+/)[1] ?? '';
}

async function labo(): Promise<{ win: WindowsPC; srv: LinuxServer }> {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV1');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  [win, srv].forEach((d, i) => {
    d.powerOn();
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  const m = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  await srv.executeCommand('sudo systemctl start ssh');
  return { win, srv };
}

describe('la privee d un hote est privee, et `ssh-keygen -y` la relit', () => {
  it('Linux : le fichier de la privee ne contient PAS la publique', async () => {
    const { srv } = await labo();
    const publique = blobDe(await srv.executeCommand(`sudo cat ${CLE_LINUX}.pub`));
    const privee = await srv.executeCommand(`sudo cat ${CLE_LINUX}`);
    expect(publique).not.toBe('');
    expect(privee).not.toContain(publique);
  });

  it('Windows : le fichier de la privee ne contient PAS la publique', async () => {
    const { win } = await labo();
    const publique = blobDe(await win.executeCommand(`type ${CLE_WINDOWS}.pub`));
    const privee = await win.executeCommand(`type ${CLE_WINDOWS}`);
    expect(publique).not.toBe('');
    expect(privee).not.toContain(publique);
  });

  it('Linux : `ssh-keygen -y` rend la publique du disque', async () => {
    const { srv } = await labo();
    const surDisque = blobDe(await srv.executeCommand(`sudo cat ${CLE_LINUX}.pub`));
    const rededuite = blobDe(await srv.executeCommand(`sudo ssh-keygen -y -f ${CLE_LINUX}`));
    expect(rededuite).toBe(surDisque);
  });

  it('Windows : `ssh-keygen -y` rend la publique du disque', async () => {
    const { win } = await labo();
    const surDisque = blobDe(await win.executeCommand(`type ${CLE_WINDOWS}.pub`));
    const rededuite = blobDe(await win.executeCommand(`ssh-keygen -y -f ${CLE_WINDOWS}`));
    expect(rededuite).toBe(surDisque);
  });

  it('TEMOIN : la publique offerte sur le fil reste celle du disque', async () => {
    const { win, srv } = await labo();
    const surDisque = blobDe(await srv.executeCommand(`sudo cat ${CLE_LINUX}.pub`));
    const surLeFil = await win.executeCommand('ssh-keyscan 10.0.0.2');
    expect(blobDe(surLeFil.trim().split(/\s+/).slice(1).join(' '))).toBe(surDisque);
  });
});
