/**
 * Ce que l'executeur historique servait encore, l'interpreteur le sert —
 * et `Set-ExecutionPolicy` decide pour de bon si un script tourne.
 *
 * Mesure de depart. `PowerShellSubShell` ne court-circuite l'interpreteur
 * que pour DEUX commandes (`ping`, `tracert`) ; tout le reste passe par
 * l'interpreteur et ne retombe sur l'executeur historique que par
 * l'erreur « not recognized ». En comparant le vocabulaire des deux, sur
 * 128 branches de l'executeur, 114 sont donc INATTEIGNABLES et 14
 * seulement repondent encore. De ces quatorze :
 *
 *  - `gdr`, `man`, `rvpa` sont de vrais alias de PowerShell que les
 *    cmdlets vivantes ne declaraient pas ;
 *  - `Clear-Content` / `clc` n'existait pas du tout cote interpreteur
 *    alors que ses trois soeurs (`Get`/`Set`/`Add-Content`) y sont ;
 *  - `Get-ComputerInfo` et `Get-History` n'existaient pas non plus ;
 *  - `Get-ExecutionPolicy` rendait la CONSTANTE `RemoteSigned` et
 *    `Set-ExecutionPolicy` rendait la chaine vide en ne rangeant RIEN,
 *    si bien que `Set-ExecutionPolicy Restricted` suivi de
 *    `Get-ExecutionPolicy` repondait `RemoteSigned` : la machine niait le
 *    reglage qu'on venait de faire. Et la constante etait fausse pour un
 *    poste CLIENT, dont le defaut documente est `Restricted` (`RemoteSigned`
 *    etant celui d'un SERVEUR) ;
 *  - `net` et `netsh` restent DELIBEREMENT servis par l'executeur : ce
 *    sont des programmes de cmd que PowerShell delegue, pas des cmdlets.
 *
 * Le reglage a un CONSOMMATEUR reel : `PSRuntime` execute vraiment les
 * fichiers `.ps1` (invocation nue, `&` et `.`), et ne consultait aucune
 * politique. Un poste sorti d'usine executait donc un script alors que
 * `Restricted` est son defaut — l'inverse de ce qu'un vrai Windows fait,
 * et le laboratoire le plus classique de PowerShell.
 *
 * Un cas ecrit `-Scope "Process"` ENTRE GUILLEMETS. Ce n'etait pas une
 * coquetterie : en position d'ARGUMENT, `Process` n'etait pas lu comme un
 * mot et l'interpreteur essayait de l'EXECUTER (« The term 'process' is
 * not recognized »). Le defaut etait dans l'analyseur ; il est ferme, et
 * `probe-un-seul-repertoire-courant.test.ts` mesure la forme NUE.
 *
 * Discrimine par `git stash` : voir l'en-tete de commit pour le compte.
 * Les cas de NON-REGRESSION sont nommes ici — `Get-Content`, dont l'alias
 * n'a pas bouge, et `net`, qui doit continuer d'etre delegue.
 */

import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function shell(device: WindowsPC | WindowsServer) {
  const sub = PowerShellSubShell.create(device).subShell;
  return async (line: string): Promise<string> =>
    (await sub.processLine(line)).output.join('\n');
}

function client(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.powerOn();
  return pc;
}

describe('les cmdlets restees dans l executeur sont servies par l interpreteur', () => {
  it('NON-REGRESSION : Get-Content garde ses alias', async () => {
    const ps = shell(client());
    await ps('Set-Content C:\\a.txt -Value bonjour');
    expect(await ps('cat C:\\a.txt')).toContain('bonjour');
  });

  it('Clear-Content vide le fichier, et clc en est l alias', async () => {
    const ps = shell(client());
    await ps('Set-Content C:\\a.txt -Value bonjour');
    await ps('clc C:\\a.txt');
    const after = await ps('Get-Content C:\\a.txt');
    expect(after).not.toContain('bonjour');
  });

  it('Clear-Content nomme le chemin absent au lieu de se taire', async () => {
    const ps = shell(client());
    const out = await ps('Clear-Content C:\\absent.txt');
    expect(out).toContain("Cannot find path 'C:\\absent.txt'");
  });

  it('man, gdr et rvpa sont des alias vivants', async () => {
    const ps = shell(client());
    expect(await ps('man Get-Content')).toContain('Get-Content');
    expect(await ps('gdr')).toMatch(/Name|Used|Free/);
    expect(await ps('rvpa C:\\')).toContain('C:');
  });

  it('Get-ComputerInfo lit le MEME registre que systeminfo', async () => {
    const pc = client();
    const ps = shell(pc);
    const out = await ps('(Get-ComputerInfo).WindowsProductName');
    const info = await pc.executeCmdCommand('systeminfo');
    expect(out.trim()).not.toBe('');
    expect(info).toContain(out.trim());
  });

  it('Get-History rend ce que la session a tape', async () => {
    const sub = PowerShellSubShell.create(client()).subShell;
    const run = async (l: string) => (await sub.processLine(l)).output.join('\n');
    await run('Get-Date');
    await run('hostname');
    const out = await run('(Get-History).CommandLine');
    expect(out).toContain('Get-Date');
    expect(out).toContain('hostname');
  });
});

describe('Set-ExecutionPolicy range, et Get-ExecutionPolicy relit', () => {
  it('le defaut d un poste CLIENT est Restricted', async () => {
    const ps = shell(client());
    expect((await ps('Get-ExecutionPolicy')).trim()).toBe('Restricted');
  });

  it('le defaut d un SERVEUR est RemoteSigned', async () => {
    const srv = new WindowsServer('SRV', 0, 0);
    srv.powerOn();
    expect((await shell(srv)('Get-ExecutionPolicy')).trim()).toBe('RemoteSigned');
  });

  it('ce que Set-ExecutionPolicy pose, Get-ExecutionPolicy le rend', async () => {
    const ps = shell(client());
    await ps('Set-ExecutionPolicy RemoteSigned');
    expect((await ps('Get-ExecutionPolicy')).trim()).toBe('RemoteSigned');
  });

  it('la portee Process prime la portee LocalMachine', async () => {
    const ps = shell(client());
    await ps('Set-ExecutionPolicy Unrestricted -Scope LocalMachine');
    await ps('Set-ExecutionPolicy Restricted -Scope "Process"');
    expect((await ps('Get-ExecutionPolicy')).trim()).toBe('Restricted');
    expect((await ps('Get-ExecutionPolicy -Scope LocalMachine')).trim()).toBe('Unrestricted');
  });

  it('-List rend les cinq portees', async () => {
    const ps = shell(client());
    const out = await ps('(Get-ExecutionPolicy -List).Scope');
    for (const scope of ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine']) {
      expect(out).toContain(scope);
    }
  });

  it('une politique inconnue est REFUSEE', async () => {
    const ps = shell(client());
    const out = await ps('Set-ExecutionPolicy Zorglub');
    expect(out).toContain("Cannot validate argument on parameter 'ExecutionPolicy'");
    expect((await ps('Get-ExecutionPolicy')).trim()).toBe('Restricted');
  });

  it('une portee de strategie de groupe ne se pose pas depuis la cmdlet', async () => {
    const ps = shell(client());
    const out = await ps('Set-ExecutionPolicy Bypass -Scope MachinePolicy');
    expect(out).toContain('Group Policy');
  });

  it('le reglage traverse le registre, donc reg query le voit', async () => {
    const pc = client();
    const ps = shell(pc);
    await ps('Set-ExecutionPolicy AllSigned -Scope LocalMachine');
    const out = await pc.executeCmdCommand(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell"');
    expect(out).toContain('AllSigned');
  });
});

describe('la politique decide si un script tourne', () => {
  async function withScript(): Promise<(l: string) => Promise<string>> {
    const pc = client();
    const ps = shell(pc);
    await ps("Set-Content C:\\run.ps1 -Value 'Write-Output BONJOUR'");
    return ps;
  }

  it('Restricted REFUSE le script, dans les mots de Windows', async () => {
    const ps = await withScript();
    await ps('Set-ExecutionPolicy Restricted');
    const out = await ps('C:\\run.ps1');
    expect(out).toContain('cannot be loaded because running scripts is disabled on this system');
    expect(out).not.toContain('BONJOUR');
  });

  it('Bypass laisse le script tourner', async () => {
    const ps = await withScript();
    await ps('Set-ExecutionPolicy Bypass');
    expect(await ps('C:\\run.ps1')).toContain('BONJOUR');
  });

  it('AllSigned refuse un script NON SIGNE en le disant', async () => {
    const ps = await withScript();
    await ps('Set-ExecutionPolicy AllSigned');
    const out = await ps('C:\\run.ps1');
    expect(out).toContain('is not digitally signed');
    expect(out).not.toContain('BONJOUR');
  });

  it('RemoteSigned laisse tourner un script LOCAL', async () => {
    const ps = await withScript();
    await ps('Set-ExecutionPolicy RemoteSigned');
    expect(await ps('C:\\run.ps1')).toContain('BONJOUR');
  });

  it('la source par point est gouvernee par la meme politique', async () => {
    const ps = await withScript();
    await ps('Set-ExecutionPolicy Restricted');
    const out = await ps('. C:\\run.ps1');
    expect(out).toContain('running scripts is disabled');
  });
});
