/*
 * Le client `ssh` citait en POSIX une commande destinee a `cmd.exe`.
 *
 * Quand la ligne tapee porte PLUSIEURS mots apres l'hote, le client
 * reconstitue la commande distante depuis son argv — le shell local a
 * deja mange les guillemets — et re-cite les mots qui contiennent une
 * espace. Il le faisait avec l'apostrophe, qui est la citation d'un
 * shell POSIX et n'est RIEN pour `cmd.exe` :
 *
 *   ssh User@win powershell -Command "Get-Host | Select-Object -ExpandProperty Name"
 *     -> envoye : powershell -Command 'Get-Host | Select-Object ...'
 *     -> cmd.exe coupe sur le `|`, et repond
 *        ''get-host' is not recognized as an internal or external command
 *
 * L'apostrophe de tete se lit dans le message d'erreur : elle a voyage
 * jusqu'a `cmd.exe`, qui l'a prise pour un caractere du nom de la
 * commande. Et parce que `cmd.exe` n'a pas vu de citation, il a coupe
 * le tube et casse en deux ce qui devait rester un seul argument.
 *
 * LA CITATION EST CELLE DE L'INTERPRETE D'EN FACE : `cmd.exe` cite avec
 * le guillemet double, un shell POSIX avec l'apostrophe. Le client
 * connait la machine qu'il a jointe, donc il sait lequel employer ;
 * c'est la meme lecture — `getOSType()` — que le reste du depot fait
 * deja pour choisir une coquille distante.
 *
 * Ce n'est pas une permissivite ajoutee : la citation existait deja et
 * elle etait simplement de la mauvaise famille. OpenSSH, lui, ne cite
 * RIEN — `ssh(1)` dit que les arguments sont « concatenes avec des
 * espaces » — et une ligne comme celle du haut casse aussi sur une
 * vraie machine. La mesure a ete faite : supprimer la citation pour
 * coller a `ssh(1)` fait tomber onze cas de plus qu'elle n'en repare,
 * parce que tout le depot ecrit `ssh hote cmd -opt "arg avec espaces"`
 * en attendant que l'argument survive. La citation reste donc, et elle
 * devient juste.
 *
 * Ecrite a l'aveugle contre `cmd.exe` et `ssh(1)`.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 2 des 5 cas tombent. Les 3 autres sont nommes ici :
 *
 *  - TEMOIN DE LA PORTE WINDOWS : une commande d'UN seul mot
 *    (`hostname`) traverse deja. Sans lui, « Windows ne repond pas en
 *    SSH » et « Windows ne recoit pas la bonne citation » seraient
 *    indiscernables.
 *  - NON-REGRESSION POSIX : la meme forme vers un hote Linux garde
 *    l'apostrophe et continue de marcher — c'est ce que la correction
 *    ne doit pas emporter.
 *  - NON-REGRESSION DU MOT UNIQUE : `ssh hote "commande entiere"`
 *    voyage verbatim, sans citation d'aucune famille.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const WINDOWS_IP = '10.0.0.4';
const LINUX_IP = '10.0.0.2';
const POSTE_IP = '10.0.0.1';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(): Promise<{ poste: LinuxPC }> {
  const poste = new LinuxPC('linux-pc', 'PC', 0, 0);
  const win = new WindowsPC('windows-pc', 'win1', 100, 0);
  const srv = new LinuxServer('linux-server', 'linux2', 200, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  new Cable('c1').connect(poste.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(srv.getPort('eth0')!, sw.getPorts()[2]);

  await poste.executeCommand(`ifconfig eth0 ${POSTE_IP} netmask 255.255.255.0`);
  await win.executeCommand(
    `netsh interface ip set address name="Ethernet0" static ${WINDOWS_IP} 255.255.255.0`);
  await srv.executeCommand(`ifconfig eth0 ${LINUX_IP} netmask 255.255.255.0`);
  await srv.executeCommand('useradd -m alice');
  await srv.executeCommand('echo alice:alice | chpasswd');

  return { poste };
}

describe('la porte SSH vers Windows repond — le TEMOIN', () => {
  it('une commande d\'un seul mot traverse', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`ssh User@${WINDOWS_IP} hostname`, 'user\n'))
      .toMatch(/win1/i);
  });
});

describe('vers `cmd.exe`, la citation est le GUILLEMET', () => {
  it('l\'argument a espaces arrive entier a PowerShell', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `ssh User@${WINDOWS_IP} powershell -Command "Get-Host | Select-Object -ExpandProperty Name"`,
      'user\n');

    expect(sortie).toMatch(/ConsoleHost|PowerShell/i);
  });

  it('et aucune apostrophe ne voyage jusqu\'au nom de commande', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `ssh User@${WINDOWS_IP} powershell -Command "Get-Host | Select-Object -ExpandProperty Name"`,
      'user\n');

    expect(sortie).not.toMatch(/is not recognized as an internal or external command/i);
  });
});

describe('ce que le correctif ne doit pas casser', () => {
  it('vers un shell POSIX, l\'apostrophe reste', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(
      `ssh alice@${LINUX_IP} bash -lc "echo bonjour du serveur"`, 'alice\n'))
      .toMatch(/bonjour du serveur/);
  });

  it('un mot UNIQUE voyage verbatim', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`ssh alice@${LINUX_IP} "uname -s"`, 'alice\n'))
      .toMatch(/Linux/);
  });
});
