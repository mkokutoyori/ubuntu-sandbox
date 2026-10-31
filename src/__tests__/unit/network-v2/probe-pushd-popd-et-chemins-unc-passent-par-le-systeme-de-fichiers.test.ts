/**
 * Sonde : `pushd \\SRV1\Pub` alloue un lecteur temporaire (le plus haut libre,
 * de Z: vers le bas) que `popd` retire, `cd \\SRV1\Pub` dit que cmd ne tient pas
 * un chemin UNC pour repertoire courant, et un chemin UNC (`dir`, `type`, `copy`
 * en cmd ; `Set-Location`, `Get-ChildItem`, `Test-Path` en PowerShell) passe par
 * le systeme de fichiers de la machine comme un lecteur, sur une vraie session
 * SMB reutilisee d'une commande a l'autre.
 *
 * Mesure de depart (mandeng a 07fbdfb02, SRV1 partage Pub = C:\Shares\Data en
 * Controle total a Administrator) : `pushd \\SRV1\Pub` et `cd \\SRV1\Pub`
 * repondaient « The system cannot find the path specified. » ; `popd` n'avait
 * rien a retirer ; `dir \\SRV1\Data` apres `net use Z: \\SRV1\Data bob`
 * echouait en « System error 1326 » parce que la branche UNC rouvrait une
 * session avec l'identite de la console et un mot de passe vide au lieu de
 * reutiliser la connexion que la machine tient deja vers ce serveur ; `dir` sur
 * un UNC n'avait ni en-tete de volume ni octets libres ; en PowerShell
 * `Set-Location \\SRV1\Pub` repondait « Cannot find path 'C:\SRV1\Pub' » :
 * normalizePath rangeait le UNC sur le lecteur courant, si bien que ni
 * `Get-ChildItem \\SRV1\Pub` ni `Test-Path \\SRV1\Pub\doc.txt` ni
 * `Get-Content` ne voyaient le partage ; une liaison coupee faisait afficher
 * « File Not Found » a `dir` et « cannot find the path » a `cd`, au lieu de la
 * raison du reseau.
 *
 * Autorites : documentation Microsoft de pushd et popd (si les extensions de
 * commandes sont actives, pushd attribue temporairement a la ressource reseau
 * « la lettre de lecteur inutilisee la plus haute, en commencant par Z: », puis
 * se place dessus ; popd retire l'affectation creee par pushd) ; Raymond Chen,
 * The Old New Thing, 2007-02-15 (cmd refuse un UNC comme repertoire courant :
 * « CMD does not support UNC paths as current directories. », contournement
 * pushd) ; PowerShell 7.4.6, FileSystemProvider.cs et LocationGlobber.cs (un
 * UNC est un chemin de fournisseur valide, le prompt et Get-Location le
 * qualifient `Microsoft.PowerShell.Core\FileSystem::`). Le texte que pushd
 * imprime quand le serveur est injoignable (« The network path was not found. »,
 * le message Win32 sans l'en-tete « System error 53 » de net.exe) est une
 * inference, aucune capture n'etant joignable ; la sonde le dit.
 *
 * Sur l'arbre sans ce lot (pushd et le UNC par le systeme de fichiers retires,
 * c'est-a-dire l'etat de W6b) : 21 des 24 cas tombent. Passent des deux cotes,
 * tous temoins : le refus de `pushd` d'un dossier absent du partage, qui ne
 * laisse deja aucun lecteur (rien n'etait alloue), celui d'un dossier local
 * absent, et `Set-Location C:\` qui quitte un emplacement UNC.
 */
import { describe, it, expect } from 'vitest';
import { buildSmbLab, type SmbLab } from './_helpers/smbLab';
import { Console } from './_helpers/windowsConsole';

interface Lab { lab: SmbLab; shell: Console }

async function open(mapping?: string): Promise<Lab> {
  const lab = await buildSmbLab();
  const disk = lab.server.getFileSystem();
  disk.mkdirp('C:\\Shares\\Data\\sub');
  disk.createFile('C:\\Shares\\Data\\sub\\inner.txt', 'inner');
  const local = lab.client.getFileSystem();
  local.mkdirp('C:\\Mirror');
  local.createFile('C:\\Mirror\\doc.txt', 'hello from srv1\n');
  const shell = await Console.open(lab.client);
  if (mapping !== undefined) await shell.run(mapping);
  return { lab, shell };
}

const BOB = 'net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob';
const framesOut = (lab: SmbLab): number => lab.client.getPorts()[0].getCounters().framesOut;
const mappedLetters = async (shell: Console): Promise<string[]> =>
  (await shell.run('net use')).split('\n').filter(line => /\\\\SRV1\\/.test(line)).map(line => line.split(/\s+/)[1]);

describe('pushd gives a network path a temporary drive that popd takes back', () => {
  it('takes Z: first and goes there', async () => {
    const { shell } = await open();
    expect(await shell.run('pushd \\\\SRV1\\Pub')).toBe('');
    expect(shell.prompt).toBe('Z:\\>');
    expect(await mappedLetters(shell)).toEqual(['Z:']);
  });

  it('goes to a folder of the share and takes the highest free letter, going down', async () => {
    const { shell } = await open(BOB);
    await shell.run('pushd \\\\SRV1\\Data\\sub');
    expect(shell.prompt).toBe('Y:\\sub>');
    expect(await mappedLetters(shell)).toEqual(['Z:', 'Y:']);
  });

  it('removes the drive of the pushd it undoes, and only that one', async () => {
    const { shell } = await open(BOB);
    await shell.run('pushd \\\\SRV1\\Data');
    await shell.run('pushd \\\\SRV1\\Data\\sub');
    expect(shell.prompt).toBe('X:\\sub>');
    await shell.run('popd');
    expect(shell.prompt).toBe('Y:\\>');
    expect(await mappedLetters(shell)).toEqual(['Z:', 'Y:']);
    await shell.run('popd');
    expect(shell.prompt).toBe('C:\\Users\\Administrator>');
    expect(await mappedLetters(shell)).toEqual(['Z:']);
  });

  it('keeps the temporary drive while a later pushd still stands on it', async () => {
    const { shell } = await open();
    await shell.run('pushd \\\\SRV1\\Pub');
    await shell.run('pushd C:\\Windows');
    await shell.run('popd');
    expect(shell.prompt).toBe('Z:\\>');
    expect(await mappedLetters(shell)).toEqual(['Z:']);
    await shell.run('popd');
    expect(await mappedLetters(shell)).toEqual([]);
  });

  it('leaves no drive behind when the folder asked for is not there', async () => {
    const { shell } = await open();
    expect(await shell.run('pushd \\\\SRV1\\Pub\\nope')).toBe('The system cannot find the path specified.');
    expect(shell.prompt).toBe('C:\\Users\\Administrator>');
    expect(await mappedLetters(shell)).toEqual([]);
  });

  it('says the network path was not found for a server nobody answers for, and maps nothing', async () => {
    const { shell } = await open();
    expect(await shell.run('pushd \\\\NOSERVER\\Pub')).toBe('The network path was not found.');
    expect(await mappedLetters(shell)).toEqual([]);
  });

  it('uses the identity the machine already holds on that server', async () => {
    const { shell, lab } = await open(BOB);
    expect(await shell.run('pushd \\\\SRV1\\Data')).toBe('');
    expect(await shell.run('type doc.txt')).toBe('hello from srv1\n');
    expect([...new Set(lab.server.smbSessions.list().map(session => session.user))]).toEqual(['bob']);
  });

  it('refuses a local folder that does not exist without touching the drive table', async () => {
    const { shell } = await open();
    expect(await shell.run('pushd C:\\nope')).toBe('The system cannot find the path specified.');
    expect(await mappedLetters(shell)).toEqual([]);
  });
});

describe('cmd does not hold a UNC path as its current directory', () => {
  it('says so for cd, with or without /d', async () => {
    const { shell } = await open();
    expect(await shell.run('cd \\\\SRV1\\Pub')).toBe('CMD does not support UNC paths as current directories.');
    expect(await shell.run('cd /d \\\\SRV1\\Pub\\sub')).toBe('CMD does not support UNC paths as current directories.');
    expect(shell.prompt).toBe('C:\\Users\\Administrator>');
  });
});

describe('cmd reads and writes a UNC path through the file system', () => {
  it('dir gives the volume of the server, the listing and no dot rows at the share root', async () => {
    const { shell, lab } = await open();
    const lines = (await shell.run('dir \\\\SRV1\\Pub')).split('\n');
    const disk = lab.server.getFileSystem();
    expect(lines[0]).toBe(` Volume in drive \\\\SRV1\\Pub is ${disk.getVolumeLabel('C')}`);
    expect(lines[1]).toBe(` Volume Serial Number is ${disk.getVolumeSerialNumber('C')}`);
    expect(lines).toContain(' Directory of \\\\SRV1\\Pub');
    expect(lines.filter(line => /<DIR>\s+\.\.?$/.test(line))).toEqual([]);
    expect(lines.some(line => /<DIR>\s+sub$/.test(line))).toBe(true);
  });

  it('dir of a folder below the share shows the dot rows like any folder', async () => {
    const { shell } = await open();
    const out = await shell.run('dir \\\\SRV1\\Pub\\sub');
    expect(out).toContain(' Directory of \\\\SRV1\\Pub\\sub');
    expect(out.split('\n').filter(line => /<DIR>\s+\.\.?$/.test(line))).toHaveLength(2);
    expect(out).toContain('inner.txt');
  });

  it('type prints a file of the share', async () => {
    const { shell } = await open();
    expect(await shell.run('type \\\\SRV1\\Pub\\sub\\inner.txt')).toBe('inner');
  });

  it('copies from the share to the disk and from the disk to the share', async () => {
    const { shell, lab } = await open();
    expect(await shell.run('copy \\\\SRV1\\Pub\\doc.txt C:\\Mirror\\pulled.txt')).toBe('        1 file(s) copied.');
    expect(lab.client.getFileSystem().readFile('C:\\Mirror\\pulled.txt').content).toBe('hello from srv1\n');
    expect(await shell.run('copy C:\\Mirror\\doc.txt \\\\SRV1\\Pub\\pushed.txt')).toBe('        1 file(s) copied.');
    expect(lab.server.getFileSystem().readFile('C:\\Shares\\Data\\pushed.txt').content).toBe('hello from srv1\n');
  });

  it('reuses the connection the machine holds, with its credentials', async () => {
    const { shell } = await open(BOB);
    expect(await shell.run('type \\\\SRV1\\Data\\doc.txt')).toBe('hello from srv1\n');
    expect(await shell.run('dir \\\\SRV1\\Data /b')).toBe('sub\ndoc.txt');
  });

  it('opens one session on the server and keeps it for the next command', async () => {
    const { shell, lab } = await open();
    await shell.run('type \\\\SRV1\\Pub\\doc.txt');
    const [first] = lab.server.smbSessions.list();
    const mark = framesOut(lab);
    await shell.run('type \\\\SRV1\\Pub\\doc.txt');
    expect(framesOut(lab) - mark).toBeGreaterThan(0);
    expect(lab.server.smbSessions.list().map(session => session.id)).toEqual([first.id]);
  });

  it('answers access denied for a share the identity has no right on', async () => {
    const { shell } = await open();
    expect(await shell.run('dir \\\\SRV1\\Data')).toBe('Access is denied.');
  });

  it('answers that the network path was not found for a server nobody answers for', async () => {
    const { shell } = await open();
    expect(await shell.run('dir \\\\NOSERVER\\Pub')).toBe('The network path was not found.');
  });

  it('names the network reason, not a missing file, when the link is cut under a mapped drive', async () => {
    const { shell, lab } = await open(BOB);
    await shell.run('Z:');
    lab.clientCable.disconnect();
    expect(await shell.run('dir')).toBe('The network path was not found.');
    expect(await shell.run('cd sub')).toBe('The network path was not found.');
  });
});

describe('PowerShell stands on a UNC path', () => {
  const powershell = async (mapping?: string): Promise<Lab> => {
    const lab = await open(mapping);
    await lab.shell.run('powershell');
    return lab;
  };

  it('qualifies the prompt and Get-Location with the provider, as PowerShell does for a UNC path', async () => {
    const { shell } = await powershell();
    await shell.run('Set-Location \\\\SRV1\\Pub');
    expect(shell.prompt).toBe('PS Microsoft.PowerShell.Core\\FileSystem::\\\\SRV1\\Pub> ');
    const row = (await shell.run('Get-Location')).split('\n').map(line => line.trim());
    expect(row).toContain('Microsoft.PowerShell.Core\\FileSystem::\\\\SRV1\\Pub');
  });

  it('goes down to a folder of the share and back up', async () => {
    const { shell } = await powershell();
    await shell.run('Set-Location \\\\SRV1\\Pub');
    await shell.run('Set-Location sub');
    expect(shell.prompt).toBe('PS Microsoft.PowerShell.Core\\FileSystem::\\\\SRV1\\Pub\\sub> ');
    expect(await shell.run('(Get-ChildItem).Name')).toBe('inner.txt');
    await shell.run('Set-Location ..');
    expect(shell.prompt).toBe('PS Microsoft.PowerShell.Core\\FileSystem::\\\\SRV1\\Pub> ');
  });

  it('lists, tests and reads by full UNC path from anywhere', async () => {
    const { shell } = await powershell();
    expect(await shell.run('Get-ChildItem \\\\SRV1\\Pub -Name')).toBe('sub\ndoc.txt');
    expect(await shell.run('Test-Path \\\\SRV1\\Pub\\doc.txt')).toBe('True');
    expect(await shell.run('Test-Path \\\\SRV1\\Pub\\nope')).toBe('False');
    expect(await shell.run('Get-Content \\\\SRV1\\Pub\\doc.txt')).toBe('hello from srv1');
    expect(await shell.run('Get-ChildItem \\\\SRV1\\Pub')).toContain('Directory: \\\\SRV1\\Pub');
  });

  it('writes by UNC path with the item cmdlets', async () => {
    const { shell, lab } = await powershell();
    await shell.run('New-Item \\\\SRV1\\Pub\\made -ItemType Directory');
    await shell.run('Copy-Item C:\\Mirror\\doc.txt \\\\SRV1\\Pub\\made\\copy.txt');
    expect(lab.server.getFileSystem().readFile('C:\\Shares\\Data\\made\\copy.txt').content).toBe('hello from srv1\n');
    await shell.run('Remove-Item \\\\SRV1\\Pub\\made -Recurse');
    expect(lab.server.getFileSystem().exists('C:\\Shares\\Data\\made')).toBe(false);
  });

  it('leaves the UNC location with Set-Location C:\\ and the prompt follows', async () => {
    const { shell } = await powershell();
    await shell.run('Set-Location \\\\SRV1\\Pub');
    await shell.run('Set-Location C:\\');
    expect(shell.prompt).toBe('PS C:\\> ');
  });

  it('reuses the connection a net use mapping holds', async () => {
    const { shell } = await powershell(BOB);
    expect(await shell.run('Get-Content \\\\SRV1\\Data\\doc.txt')).toBe('hello from srv1');
  });
});
