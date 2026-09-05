/**
 * `Get-Content` et `Get-ChildItem` honorent ce qu'ils declarent, et un
 * binaire de System32 n'est pas un fichier SYSTEME.
 *
 * Mesure de depart. Les deux cmdlets DECLARAIENT une longue liste de
 * parametres et n'en evaluaient presque aucun — le pire des trois cas de
 * la regle 6, celui qui a toutes les apparences de l'existence sauf
 * l'effet :
 *
 *  - `Get-Content` ignorait `-Delimiter`, `-ReadCount`, `-AsByteStream`,
 *    les alias `-First`/`-Head` de `-TotalCount` et `-Last` de `-Tail`,
 *    ne lisait qu'un seul chemin (ni liste ni joker), et se taisait sur
 *    un fichier absent. `-Stream` et `-Wait`, que le simulateur ne PEUT
 *    pas rendre (pas de flux alternatif, moteur synchrone), etaient
 *    acceptes sans effet ; ils sont desormais REFUSES en nommant la
 *    brique manquante.
 *  - `Get-ChildItem` ignorait `-Exclude`, `-Depth`, `-Hidden`,
 *    `-ReadOnly`, `-System`, `-Force` et `-Attributes`, ne developpait
 *    pas un joker de chemin, et listait TOUT — y compris les fichiers
 *    caches et systeme, que le vrai cache par defaut.
 *
 * Le defaut que la correction a revele. En appliquant enfin le filtre
 * par defaut, `Get-ChildItem C:\Windows\System32` est revenu VIDE : le
 * systeme de fichiers marquait `cmd.exe`, `ntdll.dll` et les trente-cinq
 * autres binaires avec l'attribut SYSTEM. Sur un vrai Windows,
 * `attrib C:\Windows\System32\cmd.exe` rend `A` — Archive. Ce sont les
 * ruches du registre (`System32\config\SYSTEM`), les `desktop.ini` et
 * `NTUSER.DAT` qui portent System+Hidden. La graine est corrigee ; le
 * critere ne pouvait pas etre applique tant qu'elle mentait.
 *
 * Discrimine par `git stash` : voir l'en-tete de commit pour le compte.
 * TEMOIN : `Get-Content` d'un fichier simple et `Get-ChildItem` d'un
 * dossier simple, qui repondaient deja. NON-REGRESSION : le mode
 * `d-----` / `-a----` de la colonne Mode, que la reecriture calcule
 * maintenant depuis les attributs reels.
 */

import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(pc).subShell;
  return { pc, ps: async (line: string) => (await sub.processLine(line)).output.join('\n') };
}

describe('Get-Content', () => {
  it('TEMOIN : un fichier simple se lit', async () => {
    const { ps } = lab();
    await ps('Set-Content C:\\a.txt -Value bonjour');
    expect((await ps('Get-Content C:\\a.txt')).trim()).toBe('bonjour');
  });

  it('-First et -Last sont les alias de -TotalCount et -Tail', async () => {
    const { ps } = lab();
    await ps('1,2,3,4,5 | Set-Content C:\\n.txt');
    expect((await ps('Get-Content C:\\n.txt -First 2')).split('\n').filter(l => l)).toEqual(['1', '2']);
    expect((await ps('Get-Content C:\\n.txt -Last 2')).split('\n').filter(l => l)).toEqual(['4', '5']);
  });

  it('un joker lit tous les fichiers qui repondent', async () => {
    const { ps } = lab();
    await ps('New-Item -Path C:\\d -ItemType Directory');
    await ps('Set-Content C:\\d\\un.txt -Value un');
    await ps('Set-Content C:\\d\\deux.txt -Value deux');
    const out = await ps('Get-Content C:\\d\\*.txt');
    expect(out).toContain('un');
    expect(out).toContain('deux');
  });

  it('-Delimiter coupe sur son separateur', async () => {
    const { ps } = lab();
    await ps('Set-Content C:\\c.txt -Value "a,b,c"');
    const out = (await ps('Get-Content C:\\c.txt -Delimiter ","')).split('\n').filter(l => l);
    expect(out[0]).toBe('a');
    expect(out[1]).toBe('b');
  });

  it('-AsByteStream rend les octets', async () => {
    const { ps } = lab();
    await ps('"A" | Set-Content C:\\b.txt');
    expect((await ps('Get-Content C:\\b.txt -AsByteStream')).split('\n').filter(l => l)).toEqual(['65', '10']);
  });

  it('un fichier absent est NOMME', async () => {
    const { ps } = lab();
    expect(await ps('Get-Content C:\\absent.txt')).toContain("Cannot find path 'C:\\absent.txt'");
  });

  it('-Stream et -Wait sont REFUSES en nommant la brique absente', async () => {
    const { ps } = lab();
    await ps('Set-Content C:\\a.txt -Value x');
    expect(await ps('Get-Content C:\\a.txt -Stream Zone.Identifier')).toContain('alternate data streams');
    expect(await ps('Get-Content C:\\a.txt -Wait')).toContain('synchronous');
  });
});

describe('Get-ChildItem', () => {
  it('TEMOIN : un dossier simple se liste', async () => {
    const { ps } = lab();
    await ps('New-Item -Path C:\\e -ItemType Directory');
    await ps('Set-Content C:\\e\\f.txt -Value f');
    expect(await ps('Get-ChildItem C:\\e -Name')).toContain('f.txt');
  });

  it('un binaire de System32 est ARCHIVE, pas SYSTEME', async () => {
    const { pc, ps } = lab();
    expect(await ps('Get-ChildItem C:\\Windows\\System32 -Name')).toContain('cmd.exe');
    expect(await pc.executeCmdCommand('attrib C:\\Windows\\System32\\cmd.exe')).toMatch(/^A\s/m);
  });

  it('les fichiers caches et systeme sont hors de la liste par defaut', async () => {
    const { ps } = lab();
    const parDefaut = await ps('Get-ChildItem C:\\Windows\\System32\\config -Name');
    expect(parDefaut).not.toContain('SYSTEM');
    expect(await ps('Get-ChildItem C:\\Windows\\System32\\config -Force -Name')).toContain('SYSTEM');
    expect(await ps('Get-ChildItem C:\\Windows\\System32\\config -System -Name')).toContain('SYSTEM');
  });

  it('attrib +h cache un fichier des deux vues', async () => {
    const { pc, ps } = lab();
    await ps('New-Item -Path C:\\g -ItemType Directory');
    await ps('Set-Content C:\\g\\secret.txt -Value s');
    await pc.executeCmdCommand('attrib +h C:\\g\\secret.txt');
    expect(await ps('Get-ChildItem C:\\g -Name')).not.toContain('secret.txt');
    expect(await ps('Get-ChildItem C:\\g -Hidden -Name')).toContain('secret.txt');
    expect(await pc.executeCmdCommand('dir C:\\g')).not.toContain('secret.txt');
  });

  it('-Exclude et -Depth decident vraiment', async () => {
    const { ps } = lab();
    await ps('New-Item -Path C:\\h\\i\\j -ItemType Directory -Force');
    await ps('Set-Content C:\\h\\haut.txt -Value h');
    await ps('Set-Content C:\\h\\bas.log -Value b');
    await ps('Set-Content C:\\h\\i\\j\\profond.txt -Value p');
    expect(await ps('Get-ChildItem C:\\h -Exclude *.log -Name')).not.toContain('bas.log');
    const peu = await ps('Get-ChildItem C:\\h -Recurse -Depth 0 -Name');
    expect(peu).not.toContain('profond.txt');
    expect(await ps('Get-ChildItem C:\\h -Recurse -Name')).toContain('profond.txt');
  });

  it('un joker de chemin developpe', async () => {
    const { ps } = lab();
    expect(await ps('Get-ChildItem C:\\Windows\\System32\\*.dll -Name')).toContain('ntdll.dll');
  });

  it('un attribut inconnu est REFUSE en le nommant', async () => {
    const { ps } = lab();
    expect(await ps('Get-ChildItem C:\\ -Attributes Zorglub')).toContain('Invalid attribute name');
  });

  it('la colonne Mode se calcule sur les attributs reels', async () => {
    const { pc, ps } = lab();
    await ps('New-Item -Path C:\\k -ItemType Directory');
    await ps('Set-Content C:\\k\\l.txt -Value l');
    await pc.executeCmdCommand('attrib +r C:\\k\\l.txt');
    expect(await ps('(Get-ChildItem C:\\k).Mode')).toContain('-ar---');
  });
});
