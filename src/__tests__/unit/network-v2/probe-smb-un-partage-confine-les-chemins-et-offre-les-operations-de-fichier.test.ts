/**
 * Sonde : un partage SMB ne montre que son arbre, cree les fichiers qu'on lui
 * confie, et offre au client les operations de fichier qu'un lecteur reseau
 * exige - stat (avec le nom tel que le disque l'ecrit), mkdir, delete, rmdir,
 * rename (avec ou sans remplacement), attributs, date, volume - chacune a
 * travers une vraie session TCP/445.
 *
 * Mesure de depart (mandeng a 83200053d, partage Data = C:\Shares\Data sur SRV1,
 * bob en Controle total, alice en Lecture) : `read('C:\Shares\outside.txt')`
 * rendait le fichier hors du partage, `read('C:\Windows\win.ini')` celui du
 * systeme, `read('..\outside.txt')` aussi ; `list('..')` listait le dossier
 * parent et `list('\')` la RACINE DU DISQUE du serveur ; `write('new.txt')` par
 * bob (Controle total) repondait « Access is denied. » parce que le controle
 * NTFS cherchait le fichier AVANT sa creation, si bien qu'aucun fichier
 * nouveau ne pouvait etre depose, ni par `copy C:\x Z:\y` ; `list` d'un dossier
 * absent repondait « Access is denied. » au lieu d'un nom introuvable ;
 * un fichier en lecture seule etait ecrase ; mkdir, delete, rmdir, rename,
 * stat, attributs, date et volume n'existaient pas du tout.
 *
 * Autorites : [MS-SMB2] 3.3.5.9 (le PathName est analyse relativement a
 * Share.LocalPath ; les serveurs Windows normalisent « . » et « .. » et
 * refusent par STATUS_INVALID_PARAMETER un nom qui commence par
 * « sous-dossier\..\ », note produit <304>), [MS-FSA] 2.1.5.1 (une creation
 * sur un nom existant echoue par STATUS_OBJECT_NAME_COLLISION), les noms
 * NTSTATUS de [MS-ERREF] et leur texte Win32 tel que cmd l'imprime. La table
 * NTSTATUS -> Win32 (RtlNtStatusToDosError) n'est pas publiee et la source
 * Wine ne la rend pas depuis cet environnement : les textes sont ceux des
 * erreurs Win32 deja emises par le systeme de fichiers local pour les memes
 * cas, pas une invention.
 *
 * Sur l'arbre sans ce lot : 33 des 41 cas tombent. Passent des deux cotes,
 * tous temoins : la lecture d'un fichier du partage, la normalisation des
 * composantes « . » et « .. » qui restent dans le partage, l'ecrasement d'un
 * fichier existant par bob, le refus d'ecriture a alice (lecture seule), le
 * refus d'un fichier dont l'ACL NTFS interdit bob, l'ecriture sur un nom de
 * dossier et le mot de passe errone ; le refus dans un dossier dont l'ACL
 * interdit bob passait aussi, mais pour une mauvaise raison (le controle
 * cherchait le fichier avant sa creation et refusait tout), ce que
 * « creates a file inside a sub-folder of the share » discrimine.
 */
import { describe, it, expect } from 'vitest';
import { buildSmbLab, type SmbLab } from './_helpers/smbLab';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

const NOT_FOUND = 'The system cannot find the file specified.';
const PATH_NOT_FOUND = 'The system cannot find the path specified.';
const DENIED = 'Access is denied.';
const EXISTS = 'Cannot create a file when that file already exists.';
const NOT_EMPTY = 'The directory is not empty.';
const BAD_DIRECTORY = 'The directory name is invalid.';
const BAD_NAME = 'The filename, directory name, or volume label syntax is incorrect.';
const BAD_PARAMETER = 'The parameter is incorrect.';

const SHARE = 'C:\\Shares\\Data';

const open = async (): Promise<{ lab: SmbLab; disk: WindowsFileSystem }> => {
  const lab = await buildSmbLab();
  return { lab, disk: lab.server.getFileSystem() };
};

describe('a share shows only its own tree', () => {
  it('serves a file of the share', async () => {
    const { lab } = await open();
    expect(lab.dial('Data', 'bob', 'bob').read('doc.txt')).toEqual({ ok: true, content: 'hello from srv1\n' });
  });

  it('refuses an absolute path outside the share and returns nothing of it', async () => {
    const { lab } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.read('C:\\Shares\\outside.txt')).toEqual({ ok: false, error: BAD_NAME });
    expect(share.read('C:\\Windows\\win.ini')).toEqual({ ok: false, error: BAD_NAME });
  });

  it('refuses a path that climbs above the share root', async () => {
    const { lab } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.read('..\\outside.txt')).toEqual({ ok: false, error: BAD_PARAMETER });
    expect(share.list('..')).toEqual({ ok: false, error: BAD_PARAMETER });
  });

  it('refuses a path that begins with a separator instead of listing the disk root', async () => {
    const { lab } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.list('\\')).toEqual({ ok: false, error: BAD_PARAMETER });
    expect(share.read('\\doc.txt')).toEqual({ ok: false, error: BAD_PARAMETER });
  });

  it('writes nothing outside the share when given an absolute path', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'bob', 'bob').write('C:\\Shares\\escape.txt', 'e')).toEqual({ ok: false, error: BAD_NAME });
    expect(disk.exists('C:\\Shares\\escape.txt')).toBe(false);
  });

  it('refuses a name that begins with a sub-folder followed by .. like a Windows server', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\sub`);
    expect(lab.dial('Data', 'bob', 'bob').read('sub\\..\\doc.txt')).toEqual({ ok: false, error: BAD_PARAMETER });
  });

  it('normalises dot components that stay inside the share', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\a`);
    disk.createFile(`${SHARE}\\a\\c.txt`, 'c');
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.read('.\\doc.txt').ok).toBe(true);
    expect(share.read('a\\b\\..\\c.txt')).toEqual({ ok: true, content: 'c' });
  });

  it('refuses characters that no file name may hold', async () => {
    const { lab } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.write('what?.txt', 'x')).toEqual({ ok: false, error: BAD_NAME });
    expect(share.mkdir('a|b')).toEqual({ ok: false, error: BAD_NAME });
  });

  it('says a missing folder is missing, not a refusal', async () => {
    const { lab } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.list('nowhere')).toEqual({ ok: false, error: NOT_FOUND });
    expect(share.list('nowhere\\deeper')).toEqual({ ok: false, error: PATH_NOT_FOUND });
  });

  it('reports a file in place of a folder when listing', async () => {
    const { lab } = await open();
    expect(lab.dial('Data', 'bob', 'bob').list('doc.txt')).toEqual({ ok: false, error: BAD_DIRECTORY });
  });

  it('says a missing file is missing, and a folder cannot be read as a file', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\sub`);
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.read('absent.txt')).toEqual({ ok: false, error: NOT_FOUND });
    expect(share.read('sub')).toEqual({ ok: false, error: DENIED });
  });
});

describe('a share creates the files it is given', () => {
  it('creates a new file for a user with full access', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'bob', 'bob').write('new.txt', 'brand new')).toEqual({ ok: true });
    expect(disk.readFile(`${SHARE}\\new.txt`)).toEqual({ ok: true, content: 'brand new' });
  });

  it('creates a file inside a sub-folder of the share', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\sub`);
    expect(lab.dial('Data', 'bob', 'bob').write('sub\\deep.txt', 'd')).toEqual({ ok: true });
    expect(disk.readFile(`${SHARE}\\sub\\deep.txt`).content).toBe('d');
  });

  it('refuses a file in a folder that does not exist, as a missing path', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'bob', 'bob').write('nowhere\\f.txt', 'x')).toEqual({ ok: false, error: PATH_NOT_FOUND });
    expect(disk.exists(`${SHARE}\\nowhere`)).toBe(false);
  });

  it('overwrites an existing file', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'bob', 'bob').write('doc.txt', 'replaced')).toEqual({ ok: true });
    expect(disk.readFile(`${SHARE}\\doc.txt`).content).toBe('replaced');
  });

  it('refuses to overwrite a read-only file and leaves it intact', async () => {
    const { lab, disk } = await open();
    disk.resolve(`${SHARE}\\doc.txt`)!.attributes.add('readonly');
    expect(lab.dial('Data', 'bob', 'bob').write('doc.txt', 'replaced')).toEqual({ ok: false, error: DENIED });
    expect(disk.readFile(`${SHARE}\\doc.txt`).content).toBe('hello from srv1\n');
  });

  it('refuses a user who has only read access to the share', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'alice', 'alice').write('new.txt', 'x')).toEqual({ ok: false, error: DENIED });
    expect(disk.exists(`${SHARE}\\new.txt`)).toBe(false);
  });

  it('refuses a file whose NTFS ACL denies the user', async () => {
    const { lab, disk } = await open();
    disk.addACE(`${SHARE}\\doc.txt`, { principal: 'bob', type: 'deny', permissions: ['Write'] });
    expect(lab.dial('Data', 'bob', 'bob').write('doc.txt', 'x')).toEqual({ ok: false, error: DENIED });
  });

  it('refuses a new file in a folder whose NTFS ACL denies the user', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\vault`);
    disk.addACE(`${SHARE}\\vault`, { principal: 'bob', type: 'deny', permissions: ['Write'] });
    expect(lab.dial('Data', 'bob', 'bob').write('vault\\f.txt', 'x')).toEqual({ ok: false, error: DENIED });
  });

  it('refuses to write over a folder', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\sub`);
    expect(lab.dial('Data', 'bob', 'bob').write('sub', 'x')).toEqual({ ok: false, error: DENIED });
  });
});

describe('a share carries folder and file operations', () => {
  it('creates a folder that the listing then shows', async () => {
    const { lab, disk } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.mkdir('reports')).toEqual({ ok: true });
    expect(disk.isDirectory(`${SHARE}\\reports`)).toBe(true);
    expect(share.list('').entries?.find(entry => entry.name === 'reports')?.isDirectory).toBe(true);
  });

  it('refuses a folder that already exists, and one whose parent is missing', async () => {
    const { lab } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.mkdir('doc.txt')).toEqual({ ok: false, error: EXISTS });
    expect(share.mkdir('nowhere\\inner')).toEqual({ ok: false, error: PATH_NOT_FOUND });
  });

  it('refuses a folder to a user with read access only', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'alice', 'alice').mkdir('reports')).toEqual({ ok: false, error: DENIED });
    expect(disk.exists(`${SHARE}\\reports`)).toBe(false);
  });

  it('deletes a file, and says so when it is not there', async () => {
    const { lab, disk } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.remove('doc.txt')).toEqual({ ok: true });
    expect(disk.exists(`${SHARE}\\doc.txt`)).toBe(false);
    expect(share.remove('doc.txt')).toEqual({ ok: false, error: NOT_FOUND });
  });

  it('refuses to delete a folder as a file, and a read-only file at all', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\sub`);
    disk.resolve(`${SHARE}\\doc.txt`)!.attributes.add('readonly');
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.remove('sub')).toEqual({ ok: false, error: DENIED });
    expect(share.remove('doc.txt')).toEqual({ ok: false, error: DENIED });
    expect(disk.exists(`${SHARE}\\doc.txt`)).toBe(true);
  });

  it('refuses to delete for a user with read access only', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'alice', 'alice').remove('doc.txt')).toEqual({ ok: false, error: DENIED });
    expect(disk.exists(`${SHARE}\\doc.txt`)).toBe(true);
  });

  it('removes an empty folder and refuses a full one, a file and the share root', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\empty`);
    disk.mkdir(`${SHARE}\\full`);
    disk.createFile(`${SHARE}\\full\\x.txt`, 'x');
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.removeDirectory('empty')).toEqual({ ok: true });
    expect(disk.exists(`${SHARE}\\empty`)).toBe(false);
    expect(share.removeDirectory('full')).toEqual({ ok: false, error: NOT_EMPTY });
    expect(share.removeDirectory('doc.txt')).toEqual({ ok: false, error: BAD_DIRECTORY });
    expect(share.removeDirectory('')).toEqual({ ok: false, error: DENIED });
    expect(disk.isDirectory(SHARE)).toBe(true);
  });

  it('renames a file in place, and moves it into another folder of the share', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\archive`);
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.rename('doc.txt', 'notes.txt')).toEqual({ ok: true });
    expect(disk.readFile(`${SHARE}\\notes.txt`).content).toBe('hello from srv1\n');
    expect(disk.exists(`${SHARE}\\doc.txt`)).toBe(false);
    expect(share.rename('notes.txt', 'archive\\notes.txt')).toEqual({ ok: true });
    expect(disk.exists(`${SHARE}\\archive\\notes.txt`)).toBe(true);
  });

  it('refuses a rename onto a name that is taken, to a missing folder, or of a missing file', async () => {
    const { lab, disk } = await open();
    disk.createFile(`${SHARE}\\other.txt`, 'o');
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.rename('doc.txt', 'other.txt')).toEqual({ ok: false, error: EXISTS });
    expect(share.rename('doc.txt', 'nowhere\\doc.txt')).toEqual({ ok: false, error: PATH_NOT_FOUND });
    expect(share.rename('ghost.txt', 'x.txt')).toEqual({ ok: false, error: NOT_FOUND });
    expect(disk.readFile(`${SHARE}\\other.txt`).content).toBe('o');
  });

  it('refuses to rename a folder into itself, and refuses a target outside the share', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\sub`);
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.rename('sub', 'sub\\inner')).toEqual({ ok: false, error: BAD_PARAMETER });
    expect(share.rename('doc.txt', '..\\stolen.txt')).toEqual({ ok: false, error: BAD_PARAMETER });
    expect(disk.exists('C:\\Shares\\stolen.txt')).toBe(false);
  });

  it('renames only the letter case of a name', async () => {
    const { lab, disk } = await open();
    expect(lab.dial('Data', 'bob', 'bob').rename('doc.txt', 'DOC.TXT')).toEqual({ ok: true });
    expect(disk.listDirectory(SHARE).map(entry => entry.name)).toEqual(['DOC.TXT']);
  });

  it('describes a file, a folder and the root, and fails on a missing name', async () => {
    const { lab, disk } = await open();
    disk.mkdir(`${SHARE}\\sub`);
    const share = lab.dial('Data', 'bob', 'bob');
    const file = share.stat('doc.txt').node!;
    expect(file).toMatchObject({ name: 'doc.txt', isDirectory: false, size: 16 });
    expect(file.attributes).toContain('archive');
    expect(typeof file.modified).toBe('number');
    expect(share.stat('sub').node).toMatchObject({ name: 'sub', isDirectory: true });
    expect(share.stat('').node).toMatchObject({ name: '', isDirectory: true });
    expect(share.stat('ghost')).toEqual({ ok: false, error: NOT_FOUND });
  });

  it('answers a stat with the name as the disk spells it, whatever case was asked', async () => {
    const { lab, disk } = await open();
    disk.mkdirp(`${SHARE}\\Reports\\Q1`);
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.stat('REPORTS\\q1').canonical).toBe('Reports\\Q1');
    expect(share.stat('REPORTS\\q1').node?.name).toBe('Q1');
    expect(share.stat('DOC.TXT').canonical).toBe('doc.txt');
    expect(share.stat('').canonical).toBe('');
  });

  it('replaces the target of a rename only when asked, and never a folder or a read-only file', async () => {
    const { lab, disk } = await open();
    disk.createFile(`${SHARE}\\other.txt`, 'o');
    disk.createFile(`${SHARE}\\locked.txt`, 'l');
    disk.resolve(`${SHARE}\\locked.txt`)!.attributes.add('readonly');
    disk.mkdir(`${SHARE}\\sub`);
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.rename('doc.txt', 'other.txt')).toEqual({ ok: false, error: EXISTS });
    expect(share.rename('doc.txt', 'locked.txt', true)).toEqual({ ok: false, error: DENIED });
    expect(share.rename('doc.txt', 'sub', true)).toEqual({ ok: false, error: DENIED });
    expect(disk.exists(`${SHARE}\\doc.txt`)).toBe(true);
    expect(share.rename('doc.txt', 'other.txt', true)).toEqual({ ok: true });
    expect(disk.readFile(`${SHARE}\\other.txt`).content).toBe('hello from srv1\n');
    expect(disk.exists(`${SHARE}\\doc.txt`)).toBe(false);
  });

  it('lists the dates and attributes of each entry, hidden ones included', async () => {
    const { lab, disk } = await open();
    disk.createFile(`${SHARE}\\secret.txt`, 's');
    disk.resolve(`${SHARE}\\secret.txt`)!.attributes.add('hidden');
    const entries = lab.dial('Data', 'bob', 'bob').list('').entries!;
    const secret = entries.find(entry => entry.name === 'secret.txt')!;
    expect(secret.attributes).toContain('hidden');
    expect(secret.modified).toBeGreaterThan(0);
    expect(secret.created).toBeGreaterThan(0);
    expect(entries.map(entry => entry.name)).toContain('doc.txt');
  });

  it('sets the attributes of a file and refuses an unknown attribute', async () => {
    const { lab, disk } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    expect(share.setAttributes('doc.txt', ['hidden', 'readonly'])).toEqual({ ok: true });
    expect([...disk.resolve(`${SHARE}\\doc.txt`)!.attributes].sort()).toEqual(['hidden', 'readonly']);
    expect(share.setAttributes('doc.txt', ['compressed'])).toEqual({ ok: false, error: BAD_PARAMETER });
    expect(lab.dial('Data', 'alice', 'alice').setAttributes('doc.txt', [])).toEqual({ ok: false, error: DENIED });
  });

  it('sets the modification time of a file', async () => {
    const { lab, disk } = await open();
    const stamp = Date.UTC(2020, 0, 2, 3, 4, 5);
    expect(lab.dial('Data', 'bob', 'bob').setModified('doc.txt', stamp)).toEqual({ ok: true });
    expect(disk.resolve(`${SHARE}\\doc.txt`)!.mtime.getTime()).toBe(stamp);
  });

  it('reports the volume that holds the share', async () => {
    const { lab, disk } = await open();
    const volume = lab.dial('Data', 'bob', 'bob').volumeInfo().volume!;
    expect(volume.label).toBe(disk.getVolumeLabel('C'));
    expect(volume.serial).toBe(disk.getVolumeSerialNumber('C'));
    expect(volume.capacity).toBe(disk.getDriveCapacity('C'));
    expect(volume.free).toBe(disk.getFreeDiskSpace('C'));
  });
});

describe('every operation crosses the wire', () => {
  const framesOut = (lab: SmbLab): number => lab.client.getPorts()[0].getCounters().framesOut;

  it('puts frames on the cable for a folder creation', async () => {
    const { lab } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    const before = framesOut(lab);
    share.mkdir('wired');
    expect(framesOut(lab) - before).toBeGreaterThan(0);
  });

  it('creates nothing on the server when the cable is pulled', async () => {
    const { lab, disk } = await open();
    const share = lab.dial('Data', 'bob', 'bob');
    lab.clientCable.disconnect();
    expect(share.mkdir('wired').ok).toBe(false);
    expect(share.write('wired.txt', 'x').ok).toBe(false);
    expect(disk.exists(`${SHARE}\\wired`)).toBe(false);
    expect(disk.exists(`${SHARE}\\wired.txt`)).toBe(false);
    expect(share.isConnected()).toBe(false);
  });

  it('refuses a wrong password before any file operation exists', async () => {
    const { lab } = await open();
    expect(() => lab.dial('Data', 'bob', 'wrong')).toThrow(/1326/);
  });
});
