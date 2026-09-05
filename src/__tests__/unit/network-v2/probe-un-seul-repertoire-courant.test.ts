/**
 * Un mot nu en position d'ARGUMENT, un seul repertoire courant, un seul
 * netsh.
 *
 * Mesure de depart, prise au HEAD precedent.
 *
 *  - `cd ..` ne bougeait pas d'un pouce et repondait « The term '..' is
 *    not recognized ». Le lexeur rend `..` en RANGE (l'operateur
 *    d'intervalle de `1..10`) et l'analyseur ne l'acceptait pas comme
 *    debut d'argument : la boucle d'arguments s'arretait, `cd` partait
 *    sans chemin, et `..` devenait une COMMANDE. Meme cause pour `.\x`,
 *    `../..`, et pour `-Scope Process` (`process` est ecarte de
 *    `canStartExpression` parce qu'il ouvre un bloc de fonction avancee,
 *    ce qui le rendait inutilisable comme VALEUR).
 *
 *  - `$PWD` etait un SECOND magasin : `Set-Location` ecrivait la variable
 *    avec le chemin BRUT tandis que le systeme de fichiers rangeait le
 *    chemin normalise. Apres `cd ..`, `Get-Location` disait `C:\` et
 *    `$PWD.Path` disait `..`. La variable est desormais DERIVEE de
 *    l'unique repertoire courant, par la meme porte pour le script
 *    (`$PWD`) et pour l'hote (`getVariable('PWD')`).
 *
 *  - `Rename-LocalGroup` levait « not recognized in this provider
 *    context » pour se faire servir par l'executeur historique ; le port
 *    `IUserProvider` ne portait pas le renommage de groupe alors que le
 *    gestionnaire de comptes, lui, l'implemente.
 *
 *  - `netsh winhttp` et `netsh wlan` etaient ecrits DEUX fois — une fois
 *    dans WinNetsh (cmd) et une fois dans l'executeur PowerShell, chacun
 *    avec son propre magasin. Un proxy pose depuis PowerShell etait
 *    invisible depuis cmd sur la MEME machine.
 *
 * Discrimine par `git stash` : 7 des 19 cas tombent au HEAD precedent —
 * `cd .\Windows`, `-Scope Process`, `1..4`, les deux cas du repertoire
 * courant unique et les deux cas de l'etat sans fil partage.
 *
 * Les autres cas de `cd` passaient DEJA au HEAD precedent, et c'est le
 * fait le plus interessant de la mesure : ils ne passaient pas par
 * l'analyseur mais par le RETOUR a l'executeur historique, que
 * `PowerShellSubShell` declenchait sur toute erreur portant « not
 * recognized ». Le doublon rendait donc une bonne reponse par un chemin
 * mort, et masquait le defaut de l'analyseur. Retirer ce retour a fait
 * apparaitre le defaut ; ces cas restent ici parce qu'ils doivent
 * desormais passer par l'analyseur.
 *
 * Cas de NON-REGRESSION nommes ici : `1..4` en position d'argument (un
 * intervalle reste un intervalle, il ne devient pas le mot « 1..4 » —
 * il tombait au HEAD precedent pour une autre raison : `..4` y devenait
 * une commande), `cd C:\Windows` (chemin absolu, qui marchait deja) et
 * le TEMOIN `Get-Location` qui prouve que le laboratoire lui-meme
 * repond.
 */

import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(pc).subShell;
  const ps = async (line: string) => (await sub.processLine(line)).output.join('\n');
  return { pc, sub, ps };
}

describe('un mot nu en position d argument', () => {
  it('TEMOIN : Get-Location repond, donc le laboratoire est sain', async () => {
    const { ps } = lab();
    expect(await ps('Get-Location')).toContain('C:\\');
  });

  it('NON-REGRESSION : cd vers un chemin absolu', async () => {
    const { pc, ps } = lab();
    await ps('cd C:\\Windows');
    expect(pc.getCwd()).toBe('C:\\Windows');
  });

  it('cd .. remonte d un cran', async () => {
    const { pc, ps } = lab();
    await ps('cd C:\\Windows');
    await ps('cd ..');
    expect(pc.getCwd()).toBe('C:\\');
  });

  it('cd ../.. remonte de deux crans', async () => {
    const { pc, ps } = lab();
    await ps('New-Item -Path C:\\a\\b -ItemType Directory -Force | Out-Null');
    await ps('cd C:\\a\\b');
    await ps('cd ../..');
    expect(pc.getCwd()).toBe('C:\\');
  });

  it('cd .\\sous-dossier descend', async () => {
    const { pc, ps } = lab();
    await ps('cd C:\\');
    await ps('cd .\\Windows');
    expect(pc.getCwd()).toBe('C:\\Windows');
  });

  it('cd ..\\autre traverse le parent', async () => {
    const { pc, ps } = lab();
    await ps('cd C:\\Windows');
    await ps('cd ..\\Users');
    expect(pc.getCwd()).toBe('C:\\Users');
  });

  it('un chemin relatif par point est lu comme un chemin, pas source par point', async () => {
    const { ps } = lab();
    await ps('cd C:\\');
    await ps('Set-Content C:\\note.txt -Value bonjour');
    expect(await ps('Get-Content .\\note.txt')).toContain('bonjour');
  });

  it('un mot-cle de bloc est un mot nu quand il est un ARGUMENT', async () => {
    const { ps } = lab();
    expect((await ps('Write-Output process')).trim()).toBe('process');
    expect((await ps('Write-Output end')).trim()).toBe('end');
  });

  it('-Scope Process s ecrit sans guillemets', async () => {
    const { ps } = lab();
    await ps('Set-ExecutionPolicy Unrestricted -Scope LocalMachine');
    await ps('Set-ExecutionPolicy Restricted -Scope Process');
    expect((await ps('Get-ExecutionPolicy')).trim()).toBe('Restricted');
  });

  it('NON-REGRESSION : un intervalle reste un intervalle en position d argument', async () => {
    const { ps } = lab();
    expect((await ps('Write-Output 1..4')).split('\n').map(l => l.trim())).toEqual(['1', '2', '3', '4']);
  });
});

describe('un seul repertoire courant', () => {
  it('$PWD, Get-Location, l invite et cmd disent la meme chose', async () => {
    const { pc, sub, ps } = lab();
    await ps('cd C:\\Windows');
    await ps('cd ..');
    expect((await ps('$PWD.Path')).trim()).toBe('C:\\');
    expect(await ps('Get-Location')).toContain('C:\\');
    expect(sub.getPrompt()).toBe('PS C:\\> ');
    expect(pc.getCwd()).toBe('C:\\');
  });

  it('un deplacement fait depuis cmd est vu par $PWD', async () => {
    const { pc, ps } = lab();
    await pc.executeCmdCommand('cd C:\\Windows');
    expect((await ps('$PWD.Path')).trim()).toBe('C:\\Windows');
  });
});

describe('le renommage de groupe local est servi par le moteur vivant', () => {
  it('Rename-LocalGroup renomme pour de bon', async () => {
    const { ps } = lab();
    await ps('New-LocalGroup -Name Ancien');
    await ps('Rename-LocalGroup -Name Ancien -NewName Nouveau');
    const out = await ps('Get-LocalGroup');
    expect(out).toContain('Nouveau');
    expect(out).not.toContain('Ancien');
  });

  it('Rename-LocalGroup nomme le groupe absent', async () => {
    const { ps } = lab();
    expect(await ps('Rename-LocalGroup -Name Fantome -NewName Spectre')).toContain('was not found');
  });

  it('le groupe renomme est le MEME que celui que voit net localgroup', async () => {
    const { pc, ps } = lab();
    await ps('New-LocalGroup -Name Ancien');
    await ps('Rename-LocalGroup -Name Ancien -NewName Nouveau');
    const cmd = await pc.executeCmdCommand('net localgroup');
    expect(cmd).toContain('Nouveau');
    expect(cmd).not.toContain('Ancien');
  });
});

describe('un seul netsh', () => {
  it('un proxy WinHTTP pose depuis PowerShell est lu depuis cmd', async () => {
    const { pc, ps } = lab();
    await ps('netsh winhttp set proxy 10.0.0.9:8080');
    expect(await pc.executeCmdCommand('netsh winhttp show proxy')).toContain('10.0.0.9:8080');
  });

  it('une remise a zero faite depuis cmd est lue depuis PowerShell', async () => {
    const { pc, ps } = lab();
    await ps('netsh winhttp set proxy 10.0.0.9:8080');
    await pc.executeCmdCommand('netsh winhttp reset proxy');
    const out = await ps('netsh winhttp show proxy');
    expect(out).toContain('Direct access');
    expect(out).not.toContain('10.0.0.9:8080');
  });

  it('netsh wlan connect refuse un profil qui n existe pas', async () => {
    const { ps } = lab();
    expect(await ps('netsh wlan connect name=Fantome')).toContain('no profile');
  });

  it('l etat de la connexion sans fil est partage entre les deux vues', async () => {
    const { pc, ps } = lab();
    await pc.executeCmdCommand('netsh wlan add profile filename="C:\\temp\\test-wifi.xml"');
    await ps('netsh wlan connect name=TestWiFi');
    expect(await pc.executeCmdCommand('netsh wlan show interfaces')).toContain('connected');
    await pc.executeCmdCommand('netsh wlan disconnect');
    expect(await ps('netsh wlan show interfaces')).toContain('disconnected');
  });
});
