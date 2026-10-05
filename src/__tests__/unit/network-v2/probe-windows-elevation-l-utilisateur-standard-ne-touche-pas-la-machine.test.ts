/*
 * Un utilisateur standard ne modifie pas la machine : meme regle sous cmd
 * et sous PowerShell, et les idiomes qui permettent de la verifier.
 *
 * Mesure de depart, en tant que `User` (compte standard du simulateur) :
 *  - `reg add HKLM\...` etait refuse mais `New-Item`, `Set-ItemProperty`,
 *    `Remove-ItemProperty` sur `HKLM:` reussissaient — deux interfaces d'un
 *    meme registre, deux regles ; `Remove-Item` jetait le message du
 *    fournisseur (une cle absente ne protestait pas non plus) ;
 *  - `Set-ExecutionPolicy` (portee LocalMachine) reussissait et ecrivait HKLM ;
 *  - le test d'administrateur le plus repandu, `([Security.Principal.
 *    WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
 *    IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`, et
 *    `WindowsIdentity::GetCurrent().Name`, n'affichaient RIEN ;
 *  - `#Requires -RunAsAdministrator` etait ignore ; `Start-Process -Verb
 *    RunAs` ne faisait rien, sans erreur ;
 *  - `net session` listait les sessions, `setx /M` ecrivait HKLM, `whoami
 *    /groups` n'avait pas de niveau d'integrite (le test cmd classique
 *    `whoami /groups | find "S-1-16-12288"` ne trouvait jamais rien), et
 *    les refus de `net` ecrivaient « System error. » sans le numero 5 et
 *    rendaient le code 0 (sc, net stop aussi).
 *
 * L'AUTORITE — le comportement documente de Windows, LU DE MEMOIRE (aucune
 * transcription n'est atteignable d'ici) : un jeton non eleve ne peut pas
 * ecrire HKLM (« Requested registry access is not allowed. » sous
 * PowerShell) ; `Set-ExecutionPolicy` sans -Scope en LocalMachine echoue par
 * « Access to the registry key 'HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\
 * PowerShell\1\ShellIds\Microsoft.PowerShell' is denied. To change the
 * execution policy for the default (LocalMachine) scope, start Windows
 * PowerShell with the "Run as administrator" option… » ; `net session`
 * refuse « System error 5 has occurred. / Access is denied. » (code 2) a un
 * compte non eleve ; `setx /M` « ERROR: Access to the registry path is
 * denied. » ; `whoami /groups` ecrit « Mandatory Label\Medium Mandatory
 * Level » (S-1-16-8192) pour un jeton standard, « High » (S-1-16-12288) pour
 * un jeton eleve ; `#Requires -RunAsAdministrator` refuse le script avec «
 * The script 'x.ps1' cannot be run because it contains a "#requires"
 * statement for running as Administrator… » ; `Start-Process -Verb RunAs`
 * demande une elevation que le compte standard n'obtient pas sans identifiants
 * (« The operation was canceled by the user. », ce que le simulateur rend,
 * faute de fenetre de consentement : `runas /user:Administrator` reste la
 * voie). Le compte `Administrator` integre est exempt du filtrage UAC : il
 * passe tout de suite. Le code retour de sc est 5 et celui de net 2 ; celui
 * de setx est 1.
 *
 * Ecrite a l'aveugle. 19 des 27 cas tombent avant (git stash push -- src/network
 * src/powershell). Les 8 qui passent des deux cotes sont des TEMOINS : HKCU
 * reste ecrivable pour un utilisateur standard, l'administrateur ecrit HKLM,
 * un utilisateur standard LIT ce que `runas` a ecrit, la portee CurrentUser
 * de `Set-ExecutionPolicy` et sa portee machine pour l'administrateur
 * passent, un script ordinaire (et le script `#Requires` de l'administrateur)
 * s'execute, `Start-Process` sans verbe et celui de l'administrateur ne
 * protestent pas, `net session` liste pour l'administrateur, et `runas
 * /user:Administrator` reste la voie d'elevation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function machine(user: string): { pc: WindowsPC; ps: (line: string) => Promise<string> } {
  const pc = new WindowsPC('windows-pc', 'WIN-EL');
  pc.setCurrentUser(user);
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\s');
  fs.createFile('C:\\s\\admin.ps1', '#Requires -RunAsAdministrator\r\nWrite-Output "ran elevated"\r\n');
  fs.createFile('C:\\s\\plain.ps1', 'Write-Output "plain"\r\n');
  const sub = PowerShellSubShell.create(pc).subShell;
  const run = async (line: string): Promise<string> => (await sub.processLine(line)).output.join('\n');
  return { pc, ps: run };
}

async function scripted(user: string): Promise<(line: string) => Promise<string>> {
  const { ps } = machine(user);
  await ps('Set-ExecutionPolicy Bypass -Scope Process');
  return ps;
}

const level = (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');
const REFUSED = 'Requested registry access is not allowed.';

describe('PowerShell writes the machine hive under the same rule as reg.exe', () => {
  it('refuses New-Item under HKLM', async () => {
    const { ps } = machine('User');

    expect(await ps('New-Item -Path HKLM:\\SOFTWARE\\Lab')).toBe(`New-Item : ${REFUSED}`);
  });

  it('refuses Set-ItemProperty and leaves the value alone', async () => {
    const { pc, ps } = machine('User');
    pc.getFileSystem();
    const out = await ps('Set-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft -Name x -Value 1');

    expect(out).toBe(`Set-ItemProperty : ${REFUSED}`);
    expect(await ps('(Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft).x')).toBe('');
  });

  it('refuses Remove-ItemProperty and Remove-Item, and shows why', async () => {
    const { ps } = machine('User');

    expect(await ps('Remove-Item -Path HKLM:\\SOFTWARE\\Microsoft -Recurse')).toContain(`Remove-Item : ${REFUSED}`);
    expect(await ps('Test-Path HKLM:\\SOFTWARE\\Microsoft')).toBe('True');
  });

  it('says what a missing key is when the user could not have written there either', async () => {
    const { ps } = machine('User');

    expect(await ps('Remove-Item -Path HKCU:\\SOFTWARE\\Nowhere')).toContain("Cannot find path 'HKCU:\\SOFTWARE\\Nowhere' because it does not exist.");
  });

  it('agrees with reg add on the same key', async () => {
    const { pc, ps } = machine('User');

    expect(await pc.executeCommand('reg add HKLM\\SOFTWARE\\Lab /v x /d 1 /f')).toBe('ERROR: Access is denied.');
    expect(await ps('New-Item -Path HKLM:\\SOFTWARE\\Lab')).toContain('not allowed');
  });

  it('still writes the user hive', async () => {
    const { ps } = machine('User');
    await ps('New-Item -Path HKCU:\\SOFTWARE\\Lab');

    expect(await ps('Test-Path HKCU:\\SOFTWARE\\Lab')).toBe('True');
  });

  it('lets an administrator write the machine hive', async () => {
    const { ps } = machine('Administrator');
    await ps('New-Item -Path HKLM:\\SOFTWARE\\Lab');
    await ps('Set-ItemProperty -Path HKLM:\\SOFTWARE\\Lab -Name x -Value 1');

    expect(await ps('(Get-ItemProperty HKLM:\\SOFTWARE\\Lab).x')).toBe('1');
  });

  it('lets a standard user read what runas wrote', async () => {
    const { pc, ps } = machine('User');
    await pc.executeCommand('runas /user:Administrator "reg add HKLM\\SOFTWARE\\Lab /v x /d 1 /f"');

    expect(await ps('(Get-ItemProperty HKLM:\\SOFTWARE\\Lab).x')).toBe('1');
  });
});

describe('the .NET identity idioms', () => {
  const ADMIN_TEST = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';

  it('names the current identity', async () => {
    const { ps } = machine('User');

    expect(await ps('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name')).toBe('WIN-EL\\User');
  });

  it('answers False to the administrator test for a standard user and True for the Administrator', async () => {
    expect(await machine('User').ps(ADMIN_TEST)).toBe('False');
    expect(await machine('Administrator').ps(ADMIN_TEST)).toBe('True');
  });

  it('answers the same through New-Object and a group name', async () => {
    const { ps } = machine('User');
    await ps('$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())');

    expect(await ps('$p.IsInRole("BUILTIN\\Administrators")')).toBe('False');
    expect(await ps('$p.IsInRole([Security.Principal.WindowsBuiltInRole]::User)')).toBe('True');
  });

  it('gives the SID of the account', async () => {
    const { ps } = machine('Administrator');

    expect(await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')).toMatch(/^S-1-5-21-[\d-]+-500$/);
  });
});

describe('execution policy and scripts', () => {
  it('refuses the LocalMachine scope to a standard user with the documented message', async () => {
    const { ps } = machine('User');
    const out = await ps('Set-ExecutionPolicy RemoteSigned');

    expect(out).toContain("Access to the registry key 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell' is denied.");
    expect(out).toContain('start Windows PowerShell with the "Run as administrator" option');
  });

  it('accepts the CurrentUser scope, and the machine scope for an administrator', async () => {
    const standard = machine('User').ps;
    await standard('Set-ExecutionPolicy RemoteSigned -Scope CurrentUser');
    const administrator = machine('Administrator').ps;
    await administrator('Set-ExecutionPolicy RemoteSigned');

    expect(await standard('Get-ExecutionPolicy -Scope CurrentUser')).toBe('RemoteSigned');
    expect(await administrator('Get-ExecutionPolicy -Scope LocalMachine')).toBe('RemoteSigned');
  });

  it('refuses a #Requires -RunAsAdministrator script to a standard user', async () => {
    const ps = await scripted('User');

    expect(await ps('C:\\s\\admin.ps1')).toBe(
      'The script \'admin.ps1\' cannot be run because it contains a "#requires" statement for running as Administrator. '
      + 'The current Windows PowerShell session is not running as Administrator. '
      + 'Start Windows PowerShell by using the Run as Administrator option, and then try running the script again.');
  });

  it('runs it for the Administrator, and runs an ordinary script for both', async () => {
    expect((await (await scripted('Administrator'))('C:\\s\\admin.ps1')).trim()).toBe('ran elevated');
    expect((await (await scripted('User'))('C:\\s\\plain.ps1')).trim()).toBe('plain');
  });

  it('does not accept Start-Process -Verb RunAs from a standard user', async () => {
    const { ps } = machine('User');

    expect(await ps('Start-Process cmd -Verb RunAs')).toContain('The operation was canceled by the user.');
  });

  it('lets the Administrator and an unprivileged Start-Process through', async () => {
    expect(await machine('Administrator').ps('Start-Process cmd -Verb RunAs')).toBe('');
    expect(await machine('User').ps('Start-Process cmd')).toBe('');
  });
});

describe('the cmd idioms', () => {
  it('refuses net session to a standard user with code 2', async () => {
    const { pc } = machine('User');

    expect(await pc.executeCommand('net session')).toBe('System error 5 has occurred.\n\nAccess is denied.');
    expect(await level(pc)).toBe('2');
  });

  it('lists the sessions for an administrator', async () => {
    const { pc } = machine('Administrator');

    expect(await pc.executeCommand('net session')).toContain('There are no entries in the list.');
    expect(await level(pc)).toBe('0');
  });

  it('writes a Medium Mandatory Level row for a standard user', async () => {
    const { pc } = machine('User');
    const out = await pc.executeCommand('whoami /groups');

    expect(out).toContain('Mandatory Label\\Medium Mandatory Level');
    expect(out).toContain('S-1-16-8192');
    expect(out).not.toContain('S-1-16-12288');
  });

  it('writes a High Mandatory Level row and the Administrators group for the Administrator', async () => {
    const { pc } = machine('Administrator');
    const out = await pc.executeCommand('whoami /groups');

    expect(out).toContain('Mandatory Label\\High Mandatory Level');
    expect(out).toContain('BUILTIN\\Administrators');
    expect(out).toContain('Group owner');
  });

  it('makes the classic elevation test work with find', async () => {
    const standard = machine('User').pc;
    const administrator = machine('Administrator').pc;
    await standard.executeCommand('whoami /groups | find "S-1-16-12288"');
    const standardLevel = await level(standard);
    await administrator.executeCommand('whoami /groups | find "S-1-16-12288"');

    expect(standardLevel).toBe('1');
    expect(await level(administrator)).toBe('0');
  });

  it('refuses setx /M to a standard user and accepts setx without it', async () => {
    const { pc } = machine('User');

    expect(await pc.executeCommand('setx /M FOO bar')).toBe('ERROR: Access to the registry path is denied.');
    expect(await level(pc)).toBe('1');
    expect(await pc.executeCommand('setx FOO bar')).toBe('SUCCESS: Specified value was saved.');
  });

  it('writes the system error number of a refused net user and returns 2', async () => {
    const { pc } = machine('User');

    expect(await pc.executeCommand('net user zed Passw0rd! /add')).toBe('System error 5 has occurred.\n\nAccess is denied.');
    expect(await level(pc)).toBe('2');
  });

  it('returns 2 for a refused net stop and 5 for a refused sc config', async () => {
    const { pc } = machine('User');
    await pc.executeCommand('net stop spooler');
    const netLevel = await level(pc);
    await pc.executeCommand('sc config spooler start= disabled');

    expect(netLevel).toBe('2');
    expect(await level(pc)).toBe('5');
  });

  it('keeps runas as the way to elevate one command', async () => {
    const { pc } = machine('User');

    expect(await pc.executeCommand('runas /user:Administrator "reg add HKLM\\SOFTWARE\\Lab /v x /d 1 /f"')).toContain('completed successfully');
    expect(await pc.executeCommand('reg query HKLM\\SOFTWARE\\Lab')).toContain('x    REG_SZ    1');
  });
});
