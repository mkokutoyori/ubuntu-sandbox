/**
 * Un chemin relatif suit le repertoire courant, et `$PWD` est ABSOLU.
 *
 * Mesure de depart, sur un interprete sans peripherique :
 *
 *     Set-Location C:\garde
 *     Set-Content -Path .\note.txt -Value ICI
 *     Test-Path C:\garde\note.txt   ->  False   (le fichier n'existe NULLE PART)
 *     Get-ChildItem                 ->  simulated.txt, folder
 *     Set-Location ..
 *     (Get-Location).Path           ->  ".."
 *
 * Trois defauts en un. `SimulatedFileSystem.norm()` ne resolvait jamais un
 * chemin relatif contre son repertoire courant — sa methode `normalizePath`
 * declarait meme le `cwd` en parametre et l'ignorait (`_cwd`), un critere
 * accepte et non evalue. `listDir` INVENTAIT deux entrees quand il ne
 * trouvait rien, si bien qu'un dossier vide se disait plein de deux
 * fichiers dont `Test-Path` niait l'existence. Et `Set-Location` rangeait
 * le chemin BRUT, si bien que `$PWD` valait `..` la ou une vraie machine
 * dit `C:\`.
 *
 * La resolution de Windows n'est pas reecrite : `WindowsFileSystem` en
 * portait deja une, pure et complete (lecteur, racine, `.`, `..`), qui
 * est extraite en `normalizeWindowsPath` et partagee par les deux
 * systemes de fichiers. Une seule ecriture de « ou mene ce chemin ».
 *
 * Discrimination par `git stash` : 3 des 5 cas TOMBENT sans le lot — le
 * chemin relatif, le dossier vide qui s'inventait deux entrees, et le
 * `..` qui ne remontait pas.
 *
 * Les 2 qui passent DES DEUX COTES :
 *  - le TEMOIN — un chemin ABSOLU a toujours marche. Sans lui, un systeme
 *    de fichiers qui n'ecrirait plus rien du tout ferait passer les trois
 *    autres cas pour verts.
 *  - la VRAIE machine — `WindowsFileSystem` resolvait deja correctement,
 *    et cmd et PowerShell y nommaient deja le meme repertoire. C'est
 *    l'ANCRE : le bouchon avait derive de la machine qu'il imite, et ce
 *    cas dit vers quoi il doit revenir. Il tient aussi la porte dans
 *    l'autre sens, la resolution etant desormais partagee par les deux.
 */

import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

describe('le repertoire courant est un vrai repertoire', () => {
  it('TEMOIN : un chemin ABSOLU a toujours marche', async () => {
    const ps = new PSInterpreter();
    await ps.execute('Set-Content -Path C:\\absolu.txt -Value OUI');
    expect((await ps.execute('Get-Content C:\\absolu.txt')).trim()).toBe('OUI');
  });

  it('un chemin relatif ecrit DANS le repertoire courant', async () => {
    const ps = new PSInterpreter();
    await ps.execute('New-Item -Path C:\\garde -ItemType Directory -Force');
    await ps.execute('Set-Location C:\\garde');
    await ps.execute('Set-Content -Path .\\note.txt -Value ICI');
    expect((await ps.execute('Test-Path C:\\garde\\note.txt')).trim()).toBe('True');
    expect((await ps.execute('Get-Content .\\note.txt')).trim()).toBe('ICI');
  });

  it('un dossier vide n invente aucune entree', async () => {
    const ps = new PSInterpreter();
    await ps.execute('New-Item -Path C:\\vide -ItemType Directory -Force');
    await ps.execute('Set-Location C:\\vide');
    const out = await ps.execute('Get-ChildItem | Select-Object -ExpandProperty Name');
    expect(out).not.toContain('simulated.txt');
    expect(out).not.toContain('folder');
  });

  it('`Set-Location ..` remonte, et `$PWD` reste absolu', async () => {
    const ps = new PSInterpreter();
    await ps.execute('New-Item -Path C:\\a\\b -ItemType Directory -Force');
    await ps.execute('Set-Location C:\\a\\b');
    expect((await ps.execute('(Get-Location).Path')).trim()).toBe('C:\\a\\b');
    await ps.execute('Set-Location ..');
    expect((await ps.execute('(Get-Location).Path')).trim()).toBe('C:\\a');
    await ps.execute('Set-Location .');
    expect((await ps.execute('(Get-Location).Path')).trim()).toBe('C:\\a');
  });

  it('sur une VRAIE machine, PowerShell et cmd nomment le meme repertoire', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
    pc.setCurrentUser('Administrator');
    const sub = PowerShellSubShell.create(pc).subShell;
    const ps = async (l: string) => (await sub.processLine(l)).output.join('\n');

    expect((await ps('(Get-Location).Path')).trim()).toBe('C:\\Users\\User');
    await ps('Set-Location C:\\Windows\\System32');
    await ps('Set-Location ..');
    expect((await ps('(Get-Location).Path')).trim()).toBe('C:\\Windows');
    expect((await pc.executeCommand('cd')).trim()).toBe('C:\\Windows');
  });
});
