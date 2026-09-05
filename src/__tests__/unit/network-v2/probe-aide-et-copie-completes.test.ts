/**
 * `-?` repond, `Get-Help` a un CORPS, et `Copy-Item` honore ce qu'il
 * declare.
 *
 * Mesure de depart. En pointant `powershell-basic-cmdlets.test.ts` — le
 * plus gros fichier encore branche sur l'executeur historique, 558 cas —
 * vers le moteur vivant, 128 cas tombaient. Trois familles :
 *
 *  - `<commande> -?` rendait `0`. Le lexeur ne lisait pas `-?` comme un
 *    parametre (il exige une lettre apres le tiret), si bien que la
 *    boucle d'arguments s'arretait et que `-?` devenait une expression a
 *    part : moins l'operateur point d'interrogation, soit zero.
 *  - `Get-Help <cmdlet>` rendait NAME et SYNTAX et rien d'autre. Les
 *    trente-quatre notices completes — synopsis, syntaxe, exemples,
 *    parametres — vivaient du cote de l'executeur mort. Le moteur vivant
 *    ne les voyait pas, et personne ne pouvait les lire.
 *  - `Copy-Item` DECLARAIT `-Filter`, `-Include`, `-Exclude`, `-Force`,
 *    `-PassThru`, `-Container` et n'en evaluait AUCUN : la commande avait
 *    toutes les apparences de l'existence sauf l'effet. Elle ne savait ni
 *    developper un joker, ni prendre son chemin du tuyau, ni nommer le
 *    fichier absent.
 *
 * Trois defauts de doublon fermes en meme temps, parce qu'ils portaient
 * ces familles : QUATRE ecritures du filtrage par joker (`PSWildcard`,
 * plus une copie dans `MiscCmdlets`, `ServiceCmdlets` et
 * `ServerManagerCmdlets`, plus une cinquieme en ligne dans
 * `Get-ChildItem` qui n'echappait pas les metacaracteres — d'ou
 * `C:\[special]` illisible) ; et `-LiteralPath`, declare par une
 * vingtaine de cmdlets de chemin et lu par cinq.
 *
 * Discrimine par `git stash` : 14 des 15 cas tombent au HEAD precedent.
 * TEMOIN : `Get-Help` sans argument, seul cas qui repondait deja — il
 * prouve que le laboratoire lui-meme repond. NON-REGRESSION :
 * `Copy-Item` d'un fichier vers un fichier tombait AUSSI, parce que le
 * cas nu passait par la meme reecriture ; il est garde comme temoin de
 * ce que la reecriture ne doit pas casser.
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

describe('l aide', () => {
  it('TEMOIN : Get-Help sans argument annonce le systeme d aide', async () => {
    const { ps } = lab();
    expect(await ps('Get-Help')).toContain('Get-Help <cmdlet-name>');
  });

  it('-? rend l aide de la commande', async () => {
    const { ps } = lab();
    const out = await ps('Clear-Host -?');
    expect(out).toContain('Clear-Host');
    expect(out).toContain('SYNOPSIS');
  });

  it('Get-Help porte un synopsis et une description', async () => {
    const { ps } = lab();
    const out = await ps('Get-Help Get-ChildItem');
    expect(out).toContain('SYNOPSIS');
    expect(out).toContain('DESCRIPTION');
    expect(out).toContain('Gets the items');
  });

  it('-Examples, -Detailed et -Full ouvrent chacun leur section', async () => {
    const { ps } = lab();
    expect(await ps('Get-Help Get-Process -Examples')).toContain('EXAMPLE');
    expect(await ps('Get-Help Get-Process -Detailed')).toContain('PARAMETERS');
    const full = await ps('Get-Help Get-Process -Full');
    expect(full).toContain('INPUTS');
    expect(full).toContain('OUTPUTS');
  });

  it('un sujet inconnu repond dans les mots de Windows', async () => {
    const { ps } = lab();
    const out = await ps('Get-Help Get-Zorglub');
    expect(out).toContain('could not find');
    expect(out).toContain('Update-Help');
  });

  it('l aide se prend aussi du tuyau', async () => {
    const { ps } = lab();
    expect(await ps('"Get-Process" | Get-Help')).toContain('Get-Process');
  });
});

describe('Copy-Item honore ce qu il declare', () => {
  it('NON-REGRESSION : un fichier vers un fichier', async () => {
    const { ps } = lab();
    await ps('Set-Content C:\\a.txt -Value bonjour');
    await ps('Copy-Item C:\\a.txt C:\\b.txt');
    expect((await ps('Get-Content C:\\b.txt')).trim()).toBe('bonjour');
  });

  it('un joker developpe la source', async () => {
    const { ps } = lab();
    await ps('New-Item -Path C:\\src -ItemType Directory');
    await ps('Set-Content C:\\src\\un.txt -Value 1');
    await ps('Set-Content C:\\src\\deux.txt -Value 2');
    await ps('Copy-Item C:\\src\\* C:\\dst');
    expect((await ps('Test-Path C:\\dst\\un.txt')).trim()).toBe('True');
    expect((await ps('Test-Path C:\\dst\\deux.txt')).trim()).toBe('True');
  });

  it('-Filter, -Include et -Exclude decident vraiment', async () => {
    const { ps } = lab();
    await ps('New-Item -Path C:\\mele -ItemType Directory');
    await ps('Set-Content C:\\mele\\a.txt -Value a');
    await ps('Set-Content C:\\mele\\b.log -Value b');
    await ps('Copy-Item C:\\mele\\* C:\\filtre -Filter *.txt');
    expect((await ps('Test-Path C:\\filtre\\a.txt')).trim()).toBe('True');
    expect((await ps('Test-Path C:\\filtre\\b.log')).trim()).toBe('False');
    await ps('Copy-Item C:\\mele\\* C:\\exclu -Exclude *.log');
    expect((await ps('Test-Path C:\\exclu\\b.log')).trim()).toBe('False');
  });

  it('-PassThru rend l objet copie', async () => {
    const { ps } = lab();
    await ps('Set-Content C:\\p.txt -Value p');
    const out = await ps('(Copy-Item C:\\p.txt C:\\q.txt -PassThru).Name');
    expect(out.trim()).toBe('q.txt');
  });

  it('le chemin peut venir du tuyau', async () => {
    const { ps } = lab();
    await ps('Set-Content C:\\t.txt -Value tuyau');
    await ps('Get-ChildItem C:\\t.txt | Copy-Item -Destination C:\\u.txt');
    expect((await ps('Get-Content C:\\u.txt')).trim()).toBe('tuyau');
  });

  it('une source absente est NOMMEE', async () => {
    const { ps } = lab();
    expect(await ps('Copy-Item C:\\absent.txt C:\\ailleurs.txt'))
      .toContain("Cannot find path 'C:\\absent.txt'");
  });

  it('-WhatIf annonce sans faire', async () => {
    const { ps } = lab();
    await ps('Set-Content C:\\w.txt -Value w');
    expect(await ps('Copy-Item C:\\w.txt C:\\x.txt -WhatIf')).toContain('What if:');
    expect((await ps('Test-Path C:\\x.txt')).trim()).toBe('False');
  });

  it('-ToSession est REFUSE en nommant la brique absente', async () => {
    const { ps } = lab();
    const out = await ps('Copy-Item C:\\a.txt -ToSession (New-PSSession)');
    expect(out).toContain('not supported');
    expect(out).toContain('remoting');
  });
});

describe('-LiteralPath prend le chemin au mot', () => {
  it('un dossier a crochets se lit, se remplit et se copie', async () => {
    const { ps } = lab();
    await ps('New-Item -Path "C:\\[dossier]" -ItemType Directory -Force');
    await ps('Set-Content -LiteralPath "C:\\[dossier]\\f.txt" -Value contenu');
    await ps('Copy-Item -LiteralPath "C:\\[dossier]" -Destination C:\\copie -Recurse');
    expect((await ps('Get-Content C:\\copie\\f.txt')).trim()).toBe('contenu');
  });
});
