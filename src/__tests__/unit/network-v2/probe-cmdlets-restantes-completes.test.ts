/**
 * Les dernieres familles du plus gros fichier de cmdlets, et les deux
 * defauts de MODELE qu'elles ont reveles.
 *
 * Mesure de depart. `powershell-basic-cmdlets.test.ts` — 558 cas, pointe
 * vers le moteur vivant depuis la suppression de l'executeur historique —
 * en comptait 128 rouges au debut de la migration, 32 au debut de ce lot,
 * 0 a la fin.
 *
 * Deux defauts de MODELE, chacun trouve par une famille :
 *
 *  1. `-WhatIf` etait ecrit cmdlet par cmdlet, donc absent de la plupart.
 *     C'est un parametre COMMUN de PowerShell : une cmdlet declare
 *     `supportsShouldProcess` et le runtime rend la ligne « What if: … »
 *     et n'execute pas. Une seule ecriture pour `Stop-Process`,
 *     `Start/Stop/Restart/Set-Service`, `Enable/Disable/Remove-LocalUser`.
 *     Une cmdlet qui REFUSE l'operation ne le declare PAS : annoncer
 *     « What if: … » pour un geste que le moteur ne sait pas poser serait
 *     l'apparence sans l'effet — `Initialize-Disk` et `Format-Volume`
 *     rendent donc leur refus, `-WhatIf` ou non.
 *
 *  2. `Write-Output` ECRIVAIT ses lignes et rendait sa valeur ; le tuyau
 *     recevait bien la valeur, mais les lignes s'affichaient AUSSI, si
 *     bien que `Write-Output 1,2,3 | Measure-Object -Sum` imprimait
 *     « 1 2 3 » et rien d'autre. La regle manquante n'etait pas dans la
 *     cmdlet mais dans le TUYAU : seule la DERNIERE etape ecrit a
 *     l'ecran ; une etape dont la valeur est consommee ne s'affiche pas.
 *     `Write-Host`, qui ne rend rien, garde ses lignes — c'est ce qui le
 *     distingue.
 *
 * Discrimination par `git stash` : 8 des 15 cas TOMBENT sans le lot —
 * les trois `-WhatIf`, `Write-Output` consomme, et les quatre refus
 * (`-ComputerName`, lien symbolique, dossier peuple sans `-Recurse`,
 * et `Initialize-Disk`/`Format-Volume` qui n'annoncent pas de What-if).
 *
 * Les 7 qui passent DES DEUX COTES, et pourquoi ils sont la :
 *  - `TEMOIN : Get-Service repond` — TEMOIN : prouve que le labo repond,
 *    sans quoi une salve de refus ne prouverait rien.
 *  - `Write-Output seul imprime ses valeurs` et `Write-Host garde ses
 *    lignes` — NON-REGRESSION : la regle du tuyau ne doit pas faire
 *    taire une etape unique, ni une etape qui ne rend rien.
 *  - les trois cas `exit` / `if` — NON-REGRESSION eux aussi. La premiere
 *    ecriture de la regle du tuyau (Write-Output rendant sa valeur SANS
 *    l'ecrire) les a tous les trois casses : un script perdait ce qu'il
 *    avait imprime avant `exit`, le `finally` traverse n'etait pas rendu,
 *    et une branche de `if` ne gardait que sa derniere ligne. Le moteur
 *    d'avant le lot les honorait deja ; ils gardent la porte.
 *  - `Test-Connection` — STRUCTUREL : epingle un contrat que ce lot ne
 *    change pas, et dont la forme reste une question ouverte (TODO.md).
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

describe('-WhatIf est un parametre COMMUN', () => {
  it('TEMOIN : Get-Service repond', async () => {
    const { ps } = lab();
    expect(await ps('Get-Service')).toContain('Spooler');
  });

  it('Stop-Service -WhatIf annonce et ne fait rien', async () => {
    const { ps } = lab();
    await ps('Start-Service Spooler');
    expect(await ps('Stop-Service Spooler -WhatIf')).toContain('What if:');
    expect(await ps('Get-Service Spooler')).toContain('Running');
  });

  it('Stop-Process -WhatIf annonce et ne tue rien', async () => {
    const { ps } = lab();
    expect(await ps('Stop-Process -Name conhost -WhatIf')).toContain('What if:');
    expect(await ps('Get-Process')).toContain('conhost');
  });

  it('la cible du What-if vient du tuyau quand elle n y est pas ecrite', async () => {
    const { ps } = lab();
    expect(await ps('Get-Service Spooler | Stop-Service -WhatIf')).toContain('Spooler');
  });
});

describe('le tuyau : seule la derniere etape ecrit a l ecran', () => {
  it('Write-Output seul imprime ses valeurs', async () => {
    const { ps } = lab();
    expect((await ps('Write-Output 1,2,3')).split('\n').filter(l => l)).toEqual(['1', '2', '3']);
  });

  it('Write-Output consomme par une etape suivante ne s imprime pas', async () => {
    const { ps } = lab();
    const out = await ps('Write-Output 1,2,3 | Measure-Object -Sum');
    expect(out).toContain('Sum');
    expect(out).toContain('6');
    expect(out.split('\n').filter(l => l.trim() === '1')).toEqual([]);
  });

  it('Write-Host garde ses lignes, meme au milieu', async () => {
    const { ps } = lab();
    expect(await ps('Write-Host bonjour')).toContain('bonjour');
  });
});

describe('exit garde ce que le script a deja ecrit', () => {
  async function script(body: string) {
    const { ps } = lab();
    await ps('Set-ExecutionPolicy RemoteSigned -Scope LocalMachine');
    await ps('New-Item -Path C:\\S -ItemType Directory -Force');
    await ps(`Set-Content -Path C:\\S\\e.ps1 -Value @'\n${body}\n'@`);
    return ps;
  }

  it('ce qui precede exit est rendu, ce qui suit ne l est pas', async () => {
    const ps = await script('Write-Output "AVANT"\nexit 7\nWrite-Output "APRES"');
    const out = await ps('& C:\\S\\e.ps1');
    expect(out).toContain('AVANT');
    expect(out).not.toContain('APRES');
    expect((await ps('$LASTEXITCODE')).trim()).toBe('7');
  });

  it('le finally traverse par exit est rendu, le catch ne l attrape pas', async () => {
    const ps = await script(
      'try { exit 4 } catch { Write-Output "RATTRAPE" } finally { Write-Output "FINALLY" }');
    const out = await ps('& C:\\S\\e.ps1');
    expect(out).toContain('FINALLY');
    expect(out).not.toContain('RATTRAPE');
    expect((await ps('$LASTEXITCODE')).trim()).toBe('4');
  });

  it('chaque branche d un if ecrit, pas seulement la derniere ligne', async () => {
    const ps = await script('if ($true) {\n  Write-Output "UN"\n  Write-Output "DEUX"\n}');
    const out = await ps('& C:\\S\\e.ps1');
    expect(out).toContain('UN');
    expect(out).toContain('DEUX');
  });
});

describe('les refus nomment la brique absente', () => {
  it('Get-Service et Get-Process refusent -ComputerName', async () => {
    const { ps } = lab();
    expect(await ps('Get-Service -ComputerName ailleurs')).toContain('no remote service control');
    expect(await ps('Get-Process -ComputerName ailleurs')).toContain('no remote process channel');
  });

  it('New-Item refuse un lien symbolique', async () => {
    const { ps } = lab();
    expect(await ps('New-Item -Path C:\\l -ItemType SymbolicLink -Target C:\\Windows'))
      .toContain('the file system has no links');
  });

  it('une cmdlet qui refuse n annonce PAS un What-if : Initialize-Disk et Format-Volume', async () => {
    const { ps } = lab();
    const disque = await ps('Initialize-Disk -Number 0 -WhatIf');
    expect(disque).toContain('no partition table');
    expect(disque).not.toContain('What if');
    const volume = await ps('Format-Volume -DriveLetter C -WhatIf');
    expect(volume).toContain('erase the machine');
    expect(volume).not.toContain('What if');
  });

  it('Remove-Item refuse un dossier peuple sans -Recurse', async () => {
    const { ps } = lab();
    await ps('New-Item -Path C:\\plein -ItemType Directory');
    await ps('Set-Content C:\\plein\\f.txt -Value f');
    expect(await ps('Remove-Item C:\\plein')).toContain('Recurse parameter was not specified');
    expect((await ps('Test-Path C:\\plein')).trim()).toBe('True');
  });
});

describe('Test-Connection : la forme de l echec reste celle du simulateur', () => {
  it('un hote injoignable rend une LIGNE par tentative portant Status Failure, et -Quiet rend False', async () => {
    const { ps } = lab();
    expect(await ps('Test-Connection 10.255.255.1 -Count 1')).toMatch(/Status\s*:\s*Failure/);
    expect((await ps('Test-Connection 10.255.255.1 -Count 1 -Quiet')).trim()).toBe('False');
  });
});
