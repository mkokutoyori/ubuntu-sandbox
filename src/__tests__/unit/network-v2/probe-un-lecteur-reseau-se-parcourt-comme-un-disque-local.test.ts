/**
 * Sonde : un lecteur reseau (`net use Z: \\SRV1\Data`) est un lecteur du systeme
 * de fichiers de la machine, que cmd et PowerShell parcourent comme un disque
 * local - `Z:`, `cd`, `dir`, `type`, `mkdir`, `copy`, `Set-Location`,
 * `Get-ChildItem`, `Test-Path`, `Set-Content` - et chaque operation traverse le
 * cable en trames SMB reelles vers le serveur.
 *
 * Mesure de depart (mandeng a 83200053d, partage Data de SRV1 mappe sur Z: par
 * bob) : `Z:` repondait « The system cannot find the drive specified. » et
 * `cd /d Z:\` la meme chose, alors que `net use` avait reussi ; `dir Z:\`
 * passait par une branche a part (`tryUncFileCommand`) qui imprimait un
 * « Directory of Z:\ » sans en-tete de volume ni octets libres ; `mkdir Z:\sub`
 * CREAIT UN LECTEUR Z: LOCAL FANTOME (mkdirp monte tout lecteur absent), si bien
 * que `Z:` marchait ensuite - sur un disque qui n'etait pas celui du partage ;
 * `Test-Path Z:\doc.txt` rendait False et `Get-Content Z:\doc.txt` « Cannot find
 * path » pour un fichier qui existe ; `New-Item Q:\x -ItemType Directory`,
 * `xcopy f Q:\` et `robocopy` creaient eux aussi un lecteur qui n'existe pas ;
 * `echo x > f` refuse par le serveur disait « cannot find the path » au lieu de
 * « Access is denied. ».
 *
 * Autorites : le comportement de reference est celui du MEME ordre sur un
 * disque local de la meme machine (cmd et PowerShell ne savent pas qu'un
 * lecteur est distant), donc les textes d'erreur et les formats sont ceux que
 * le systeme de fichiers local emet deja, compares ci-dessous ; ce qui est
 * propre au reseau vient du serveur : etiquette, serie et espace libre du
 * volume (FileFsVolumeInformation / FileFsFullSizeInformation, [MS-FSCC]
 * 2.5.9 et 2.5.4), refus du partage et de l'ACL NTFS rendus tels quels. Pour
 * `pushd`, la documentation Microsoft de pushd (lecteur temporaire alloue de Z:
 * vers le bas) est traitee dans le lot suivant.
 *
 * Sur l'arbre sans ce lot : 36 des 40 cas tombent. Passent des deux cotes, tous
 * temoins : la copie du disque local vers le partage et retour (l'ancienne
 * branche UNC de `copy` la faisait deja), la suppression du lecteur par
 * `net use /delete`, le message d'un chemin distant absent dans `Get-Content`
 * et la ligne de `Get-PSDrive`, qui lisent la table de `net use` et non le
 * systeme de fichiers.
 *
 * Le dernier cas du bloc « follows the network » (l'adresse de la machine
 * change sous le lecteur) tombe aussi quand le lecteur ne rejoue pas une fois
 * l'operation qui vient de decouvrir que la session est morte : sans cela la
 * premiere utilisation apres un changement d'adresse echouait, la suivante
 * reussissait. C'est ce que `scenario-06-ps-rogue-dhcp-detection` a fait voir
 * (le script de remediation change l'adresse puis relit le partage).
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { buildSmbLab, type SmbLab } from './_helpers/smbLab';
import { Console } from './_helpers/windowsConsole';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

const SHARE = 'C:\\Shares\\Data';
const NO_PATH = 'The system cannot find the path specified.';
const NO_DRIVE = 'The system cannot find the drive specified.';
const DENIED = 'Access is denied.';

interface Lab { lab: SmbLab; disk: WindowsFileSystem; shell: Console; local: WindowsFileSystem }

async function open(user = 'bob', letter = 'Z'): Promise<Lab> {
  const lab = await buildSmbLab();
  const disk = lab.server.getFileSystem();
  disk.mkdirp(`${SHARE}\\sub`);
  disk.createFile(`${SHARE}\\sub\\inner.txt`, 'inner');
  const local = lab.client.getFileSystem();
  local.mkdirp('C:\\Mirror\\sub');
  local.createFile('C:\\Mirror\\doc.txt', 'hello from srv1\n');
  local.createFile('C:\\Mirror\\sub\\inner.txt', 'inner');
  const shell = await Console.open(lab.client);
  await shell.run(`net use ${letter}: \\\\SRV1\\Data ${user} /user:SRV1\\${user}`);
  return { lab, disk, shell, local };
}

const framesOut = (lab: SmbLab): number => lab.client.getPorts()[0].getCounters().framesOut;

const withoutDates = (listing: string): string[] =>
  listing.split('\n').map(line => line.replace(/^\d\d\/\d\d\/\d{4}\s+\d\d:\d\d [AP]M\s+/, '').trimEnd());

describe('cmd moves onto the mapped drive and walks it', () => {
  it('Z: makes the mapped drive current and cd names its root', async () => {
    const { shell } = await open();
    await shell.run('Z:');
    expect(shell.prompt).toBe('Z:\\>');
    expect(await shell.run('cd')).toBe('Z:\\');
  });

  it('dir gives the volume, the listing and the free space of the machine that shares it', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    const lines = (await shell.run('dir')).split('\n');
    expect(lines[0]).toBe(` Volume in drive Z is ${disk.getVolumeLabel('C')}`);
    expect(lines[1]).toBe(` Volume Serial Number is ${disk.getVolumeSerialNumber('C')}`);
    expect(lines).toContain(' Directory of Z:\\');
    expect(withoutDates(lines.join('\n'))).toEqual(expect.arrayContaining(['<DIR>          sub', '16 doc.txt']));
    expect(lines[lines.length - 1]).toMatch(new RegExp(`^\\s+1 Dir\\(s\\) ${disk.getFreeDiskSpace('C').toLocaleString('en-US')} bytes free$`));
  });

  it('lists the same names as the same folder on a local disk', async () => {
    const { shell } = await open();
    await shell.run('Z:');
    const remote = await shell.run('dir /b');
    await shell.run('cd /d C:\\Mirror');
    expect(remote).toBe(await shell.run('dir /b'));
  });

  it('goes down and up with cd and the prompt follows', async () => {
    const { shell } = await open();
    await shell.run('Z:');
    await shell.run('cd sub');
    expect(shell.prompt).toBe('Z:\\sub>');
    expect(await shell.run('dir /b')).toBe('inner.txt');
    await shell.run('cd ..');
    expect(shell.prompt).toBe('Z:\\>');
  });

  it('enters a remote folder with cd /d from another drive, and comes back to C:', async () => {
    const { shell } = await open();
    await shell.run('cd /d Z:\\sub');
    expect(shell.prompt).toBe('Z:\\sub>');
    await shell.run('C:');
    expect(shell.prompt).toBe('C:\\Users\\Administrator>');
    await shell.run('Z:');
    expect(shell.prompt).toBe('Z:\\sub>');
  });

  it('writes the folder as the disk spells it, whatever case was typed', async () => {
    const { shell } = await open();
    await shell.run('cd /d z:\\SUB');
    expect(shell.prompt).toBe('Z:\\sub>');
  });

  it('refuses a folder that does not exist with the words of a local disk', async () => {
    const { shell } = await open();
    await shell.run('Z:');
    expect(await shell.run('cd nope')).toBe(NO_PATH);
    expect(await shell.run('cd C:\\Mirror\\nope')).toBe(NO_PATH);
    expect(shell.prompt).toBe('Z:\\>');
  });

  it('refuses a file where a folder is expected like a local disk', async () => {
    const { shell } = await open();
    await shell.run('Z:');
    const remote = await shell.run('cd doc.txt');
    expect(remote).toBe(await shell.run('cd C:\\Mirror\\doc.txt'));
    expect(remote).toBe('The directory name is invalid.');
  });

  it('shows the tree of the share with tree /f', async () => {
    const { shell } = await open();
    const out = await shell.run('tree Z:\\ /f');
    expect(out).toContain('sub');
    expect(out).toContain('inner.txt');
    expect(out).toContain('doc.txt');
  });

  it('walks every folder with dir /s', async () => {
    const { shell } = await open();
    await shell.run('Z:');
    const out = await shell.run('dir /s /b');
    expect(out.split('\n')).toEqual(expect.arrayContaining(['Z:\\doc.txt', 'Z:\\sub', 'Z:\\sub\\inner.txt']));
  });
});

describe('cmd reads and writes the mapped drive over the wire', () => {
  it('type prints a remote file and puts frames on the cable, unlike a local file', async () => {
    const { lab, shell } = await open();
    await shell.run('Z:');
    const before = framesOut(lab);
    const remote = await shell.run('type doc.txt');
    const remoteFrames = framesOut(lab) - before;
    const mark = framesOut(lab);
    const local = await shell.run('type C:\\Mirror\\doc.txt');
    expect(remote).toBe(local);
    expect(remote).toContain('hello from srv1');
    expect(remoteFrames).toBeGreaterThan(0);
    expect(framesOut(lab) - mark).toBe(0);
  });

  it('creates, copies, renames, moves and deletes on the server disk', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    await shell.run('mkdir reports');
    expect(disk.isDirectory(`${SHARE}\\reports`)).toBe(true);
    await shell.run('echo first> reports\\a.txt');
    expect(disk.readFile(`${SHARE}\\reports\\a.txt`).content).toBe('first\n');
    expect(await shell.run('copy reports\\a.txt reports\\b.txt')).toBe('        1 file(s) copied.');
    await shell.run('ren reports\\b.txt c.txt');
    expect(disk.exists(`${SHARE}\\reports\\b.txt`)).toBe(false);
    expect(disk.exists(`${SHARE}\\reports\\c.txt`)).toBe(true);
    expect(await shell.run('move reports\\c.txt sub')).toBe('        1 file(s) moved.');
    expect(disk.exists(`${SHARE}\\sub\\c.txt`)).toBe(true);
    await shell.run('del reports\\a.txt');
    expect(disk.exists(`${SHARE}\\reports\\a.txt`)).toBe(false);
    expect(await shell.run('rd reports')).toBe('');
    expect(disk.exists(`${SHARE}\\reports`)).toBe(false);
  });

  it('creates the intermediate folders of a mkdir', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    expect(await shell.run('mkdir a\\b\\c')).toBe('');
    expect(disk.isDirectory(`${SHARE}\\a\\b\\c`)).toBe(true);
  });

  it('refuses a folder that exists with the words of a local disk', async () => {
    const { shell } = await open();
    await shell.run('Z:');
    expect(await shell.run('mkdir sub')).toBe('A subdirectory or file sub already exists.');
  });

  it('refuses to remove a folder that is not empty, and removes it with /s /q', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    expect(await shell.run('rd sub')).toBe('The directory is not empty.');
    expect(await shell.run('rd /s /q sub')).toBe('');
    expect(disk.exists(`${SHARE}\\sub`)).toBe(false);
  });

  it('appends with >> and overwrites with >', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    await shell.run('echo more>> doc.txt');
    expect(disk.readFile(`${SHARE}\\doc.txt`).content).toBe('hello from srv1\nmore\n');
    await shell.run('echo over> doc.txt');
    expect(disk.readFile(`${SHARE}\\doc.txt`).content).toBe('over\n');
  });

  it('copies from the local disk to the share and back', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    expect(await shell.run('copy C:\\Mirror\\doc.txt Z:\\from-local.txt')).toBe('        1 file(s) copied.');
    expect(disk.readFile(`${SHARE}\\from-local.txt`).content).toBe('hello from srv1\n');
    expect(await shell.run('copy Z:\\sub\\inner.txt C:\\Mirror\\from-share.txt')).toBe('        1 file(s) copied.');
    expect(await shell.run('type C:\\Mirror\\from-share.txt')).toBe('inner');
  });

  it('writes with xcopy and robocopy', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    await shell.run('xcopy C:\\Mirror\\doc.txt Z:\\xc\\ /y');
    expect(disk.exists(`${SHARE}\\xc\\doc.txt`)).toBe(true);
    await shell.run('robocopy C:\\Mirror Z:\\rc /E');
    expect(disk.exists(`${SHARE}\\rc\\sub\\inner.txt`)).toBe(true);
  });

  it('carries attrib to the server: a hidden file leaves dir and shows with /a:h', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    await shell.run('attrib +h doc.txt');
    expect(disk.resolve(`${SHARE}\\doc.txt`)!.attributes.has('hidden')).toBe(true);
    expect(await shell.run('dir /b')).toBe('sub');
    expect(await shell.run('dir /b /a:h')).toBe('doc.txt');
    await shell.run('attrib -h doc.txt');
    expect(disk.resolve(`${SHARE}\\doc.txt`)!.attributes.has('hidden')).toBe(false);
  });

  it('sees at once what the server changes under it', async () => {
    const { shell, disk } = await open();
    await shell.run('Z:');
    disk.createFile(`${SHARE}\\appeared.txt`, 'x');
    expect(await shell.run('dir /b')).toContain('appeared.txt');
    disk.deleteFile(`${SHARE}\\appeared.txt`);
    expect(await shell.run('dir /b')).not.toContain('appeared.txt');
  });
});

describe('what the share refuses is refused with the words of a local disk', () => {
  it('refuses every write of a user who has only read access, and changes nothing', async () => {
    const { shell, disk, lab } = await open('alice', 'Y');
    await shell.run('Y:');
    expect(await shell.run('type doc.txt')).toBe('hello from srv1\n');
    expect(await shell.run('mkdir blocked')).toBe(DENIED);
    expect(await shell.run('echo x> blocked.txt')).toBe(DENIED);
    expect(await shell.run('del doc.txt')).toBe(DENIED);
    expect(await shell.run('ren doc.txt d.txt')).toBe(DENIED);
    expect(await shell.run('attrib +h doc.txt')).toBe(DENIED);
    expect(await shell.run('rd sub')).toBe(DENIED);
    expect(await shell.run('copy C:\\Mirror\\doc.txt Y:\\fresh.txt')).toBe(`${DENIED}\n        0 file(s) copied.`);
    expect(disk.listDirectory(SHARE).map(entry => entry.name)).toEqual(['sub', 'doc.txt']);
    expect(lab.server.getFileSystem().exists(`${SHARE}\\blocked.txt`)).toBe(false);
  });

  it('refuses a file whose NTFS ACL denies the user, as access denied', async () => {
    const { shell, disk } = await open();
    disk.addACE(`${SHARE}\\doc.txt`, { principal: 'bob', type: 'deny', permissions: ['Write'] });
    await shell.run('Z:');
    expect(await shell.run('echo x> doc.txt')).toBe(DENIED);
    expect(disk.readFile(`${SHARE}\\doc.txt`).content).toBe('hello from srv1\n');
  });
});

describe('a drive that is not mapped is not a drive', () => {
  it('refuses mkdir on a letter nobody holds and creates no drive', async () => {
    const { shell, lab } = await open();
    expect(await shell.run('mkdir Q:\\x')).toBe(NO_PATH);
    expect(await shell.run('Q:')).toBe(NO_DRIVE);
    expect(lab.client.getFileSystem().listDrives()).not.toContain('Q:');
  });

  it('refuses xcopy and robocopy toward a letter nobody holds and creates no drive', async () => {
    const { shell, lab } = await open();
    await shell.run('xcopy C:\\Mirror\\doc.txt Q:\\ /y');
    await shell.run('robocopy C:\\Mirror Q:\\r /E');
    expect(lab.client.getFileSystem().listDrives()).not.toContain('Q:');
  });

  it('takes the drive away with net use /delete', async () => {
    const { shell, lab } = await open();
    await shell.run('net use Z: /delete');
    expect(await shell.run('Z:')).toBe(NO_DRIVE);
    expect(lab.client.getFileSystem().hasDrive('Z')).toBe(false);
  });

  it('keeps the other mapped drives when one is deleted', async () => {
    const { shell } = await open();
    await shell.run('net use Y: \\\\SRV1\\Data bob /user:SRV1\\bob');
    await shell.run('net use Z: /delete');
    await shell.run('Y:');
    expect(shell.prompt).toBe('Y:\\>');
    expect(await shell.run('dir /b')).toBe('sub\ndoc.txt');
  });
});

describe('the drive follows the network', () => {
  it('answers that the network path was not found once the cable is pulled', async () => {
    const { shell, lab } = await open();
    await shell.run('Z:');
    lab.clientCable.disconnect();
    expect(await shell.run('type doc.txt')).toBe('The network path was not found.');
    expect(await shell.run('mkdir late')).toBe('The network path was not found.');
  });

  it('dials the share again on the first use once the cable is plugged back', async () => {
    const { shell, lab } = await open();
    await shell.run('Z:');
    lab.clientCable.disconnect();
    expect(await shell.run('type doc.txt')).toBe('The network path was not found.');
    lab.plugClientBack();
    expect(await shell.run('type doc.txt')).toContain('hello from srv1');
    expect(await shell.run('net use')).toContain('OK');
  });

  it('dials the share again at once when the address of the machine changed under the mapping', async () => {
    const { shell, lab } = await open();
    await shell.run('Z:');
    lab.client.getPorts()[0].configureIP(new IPAddress('192.168.10.21'), new SubnetMask('255.255.255.0'));
    expect(await shell.run('type doc.txt')).toContain('hello from srv1');
    expect(await shell.run('net use')).toContain('OK');
  });
});

describe('PowerShell navigates the same drive', () => {
  const powershell = async (user = 'bob', letter = 'Z'): Promise<Lab> => {
    const lab = await open(user, letter);
    await lab.shell.run('powershell');
    return lab;
  };

  it('Set-Location enters the drive and the prompt and Get-Location follow', async () => {
    const { shell } = await powershell();
    await shell.run('Set-Location Z:\\sub');
    expect(shell.prompt).toBe('PS Z:\\sub> ');
    expect((await shell.run('Get-Location')).split('\n').map(line => line.trim())).toContain('Z:\\sub');
  });

  it('lists a remote folder with Get-ChildItem, by name and as objects', async () => {
    const { shell } = await powershell();
    expect(await shell.run('Get-ChildItem Z:\\ -Name')).toBe('sub\ndoc.txt');
    expect(await shell.run('(Get-ChildItem Z:\\sub).Name')).toBe('inner.txt');
    expect(await shell.run('(Get-Item Z:\\doc.txt).Length')).toBe('16');
    expect(await shell.run('(Get-Item Z:\\sub).PSIsContainer')).toBe('True');
  });

  it('answers Test-Path for what the server holds and what it does not', async () => {
    const { shell } = await powershell();
    expect(await shell.run('Test-Path Z:\\doc.txt')).toBe('True');
    expect(await shell.run('Test-Path Z:\\sub -PathType Container')).toBe('True');
    expect(await shell.run('Test-Path Z:\\nope')).toBe('False');
  });

  it('reads and writes remote files with Get-Content, Set-Content and Add-Content', async () => {
    const { shell, disk } = await powershell();
    expect(await shell.run('Get-Content Z:\\doc.txt')).toBe('hello from srv1');
    await shell.run('Set-Content Z:\\ps.txt first');
    await shell.run('Add-Content Z:\\ps.txt second');
    expect(await shell.run('Get-Content Z:\\ps.txt')).toBe('first\nsecond');
    expect(disk.exists(`${SHARE}\\ps.txt`)).toBe(true);
  });

  it('creates, renames, copies, moves and removes with the item cmdlets', async () => {
    const { shell, disk } = await powershell();
    await shell.run('New-Item Z:\\folder -ItemType Directory');
    await shell.run('Set-Content Z:\\folder\\a.txt x');
    await shell.run('Rename-Item Z:\\folder\\a.txt b.txt');
    await shell.run('Copy-Item Z:\\folder\\b.txt Z:\\folder\\c.txt');
    await shell.run('Move-Item Z:\\folder\\c.txt Z:\\sub\\');
    expect(disk.exists(`${SHARE}\\folder\\b.txt`)).toBe(true);
    expect(disk.exists(`${SHARE}\\sub\\c.txt`)).toBe(true);
    await shell.run('Remove-Item Z:\\folder -Recurse');
    expect(disk.exists(`${SHARE}\\folder`)).toBe(false);
  });

  it('copies between the local disk and the share with Copy-Item', async () => {
    const { shell, disk } = await powershell();
    await shell.run('Copy-Item C:\\Mirror\\doc.txt Z:\\pushed.txt');
    expect(disk.readFile(`${SHARE}\\pushed.txt`).content).toBe('hello from srv1\n');
    await shell.run('Copy-Item Z:\\sub\\inner.txt C:\\Mirror\\pulled.txt');
    expect(await shell.run('Get-Content C:\\Mirror\\pulled.txt')).toBe('inner');
  });

  it('says a missing remote path is missing, as on a local disk', async () => {
    const { shell } = await powershell();
    const remote = await shell.run('Get-Content Z:\\nope');
    expect(remote).toContain("Cannot find path 'Z:\\nope' because it does not exist.");
    expect(remote.split('Z:\\nope').join('C:\\Mirror\\nope')).toBe(await shell.run('Get-Content C:\\Mirror\\nope'));
  });

  it('refuses a drive that does not exist, in New-Item and in Set-Location, and creates none', async () => {
    const { shell, lab } = await powershell();
    expect(await shell.run('New-Item Q:\\x -ItemType Directory')).toContain("Cannot find drive. A drive with the name 'Q' does not exist.");
    expect(await shell.run('Set-Location Q:\\')).toContain("Cannot find drive. A drive with the name 'Q' does not exist.");
    expect(lab.client.getFileSystem().listDrives()).not.toContain('Q:');
  });

  it('refuses what the share refuses, and changes nothing on the server', async () => {
    const { shell, disk } = await powershell('alice', 'Y');
    expect(await shell.run('Get-Content Y:\\doc.txt')).toBe('hello from srv1');
    expect(await shell.run('Set-Content Y:\\new.txt hi')).toContain(DENIED);
    expect(await shell.run('New-Item Y:\\d -ItemType Directory')).toContain(DENIED);
    expect(await shell.run('Remove-Item Y:\\doc.txt')).toContain(DENIED);
    expect(disk.listDirectory(SHARE).map(entry => entry.name)).toEqual(['sub', 'doc.txt']);
  });

  it('shares one view with cmd: what cmd creates PowerShell lists at once', async () => {
    const { shell, disk } = await powershell();
    await shell.run('cmd /c mkdir Z:\\fromcmd');
    expect(disk.isDirectory(`${SHARE}\\fromcmd`)).toBe(true);
    expect(await shell.run('Test-Path Z:\\fromcmd')).toBe('True');
  });

  it('leaves the drive in Get-PSDrive with its share as the root', async () => {
    const { shell } = await powershell();
    const row = (await shell.run('Get-PSDrive Z')).split('\n').find(line => line.startsWith('Z'));
    expect(row).toContain('\\\\SRV1\\Data');
  });
});
