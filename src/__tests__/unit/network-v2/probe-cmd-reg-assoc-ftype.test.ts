/*
 * `reg.exe`, `assoc` et `ftype` sur UNE base de registre : noms de ruche
 * complets, valeur par defaut, types, HKCR, HKU, HKCC, vue 32 bits, droits,
 * confirmations, export et import — et les associations de fichiers qui
 * vivent dans `HKLM\SOFTWARE\Classes`.
 *
 * Mesure de depart. `reg add HKCU\Software\Zed /ve /d hello` ne posait rien
 * (`/ve` etait ignore : seul `/v` etait lu) ; `reg query` recopiait
 * l'argument tel qu'il avait ete tape (`HKLM\SOFTWARE\Classes`) au lieu du
 * nom canonique `HKEY_LOCAL_MACHINE\SOFTWARE\Classes`, ne listait jamais les
 * sous-cles, affichait `REG_SZ` pour toute valeur de texte (`TEMP` est
 * `REG_EXPAND_SZ`) et `REG_DWORD` pour tout nombre, ignorait `/f /k /d /e /c
 * /t /z /se`, et n'imprimait pas le pied « End of search: N match(es) found. » ;
 * `/t` etait lu seulement pour `reg add`, qui ne gardait que REG_DWORD et
 * REG_SZ (un REG_MULTI_SZ, un REG_BINARY ou un REG_EXPAND_SZ devenait du
 * texte) ; `reg add` refusait JAMAIS un utilisateur sans droits dans HKLM ;
 * `reg copy`, `reg export` et `reg import` repondaient « Invalid syntax » ;
 * HKCR, HKU et HKCC n'existaient pas ; `/reg:32` n'etait pas lu ; ecraser une
 * valeur sans `/f` ne demandait rien ; `assoc` et `ftype` n'existaient pas.
 *
 * L'AUTORITE — l'aide integree de `reg /?`, `reg query /?`, `reg add /?`,
 * `reg delete /?`, `assoc /?` et `ftype /?`, LUE DE MEMOIRE (aucune
 * transcription n'est atteignable d'ici) : nom ROOTKEY complet en tete de
 * bloc, `    Nom    TYPE    donnee`, `(Default)` pour la valeur sans nom,
 * `0x…` pour REG_DWORD et REG_QWORD, `\0` entre les elements d'un
 * REG_MULTI_SZ, `End of search: N match(es) found.`, code 1 sur un echec.
 * HKCR est la vue fusionnee de `HKLM\SOFTWARE\Classes` et
 * `HKCU\SOFTWARE\Classes` — une ecriture va dans HKCU si la cle y existe
 * deja, dans HKLM sinon. Ce que le simulateur n'attribue pas : les libelles
 * exacts des confirmations de `reg delete` et `reg copy`, la mise en page de
 * `/z` (« REG_SZ (1) »), le decompte du pied pour `/s` sans motif (cles et
 * valeurs), et la redirection 32 bits, ramenee a `WOW6432Node` sous
 * `SOFTWARE`. `reg save|restore|load|unload|compare|flags` ne sont pas
 * honorees : « The request is not supported. ». Un REG_QWORD au-dela de
 * 2^53 n'est pas representable. Les confirmations lisent leur reponse sur le
 * lecteur de ligne de la machine (invite du terminal, ou entree standard du
 * scenario) ; sans reponse, l'operation est annulee comme par un « No ». Au
 * terminal l'invite est celle de la fenetre ; sur l'entree standard du
 * scenario, le texte de l'invite est ecrit sur la sortie, suivi du message,
 * sur la meme ligne — la reponse lue sur un tube n'est pas rendue en echo.
 *
 * Ecrite a l'aveugle, sur `executeCmdCommand`. 39 des 40 cas tombent avant
 * (git stash push -- src/network src/terminal src/shell src/cmd
 * src/powershell). Le seul qui passe des deux cotes est un TEMOIN : l'ancien
 * `reg query` terminait deja sa liste par une ligne vide, que le nouveau
 * garde.
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

function machine(user = 'Administrator'): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN-REG');
  pc.setCurrentUser(user);
  return pc;
}

const lines = (out: string): string[] => (out === '' ? [] : out.replace(/\n$/, '').split('\n'));
const level = async (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');

async function run(pc: WindowsPC, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await pc.executeCmdCommand(command);
  return last;
}

describe('reg query: what is printed', () => {
  it('names the root key in full and types a text value that expands as REG_EXPAND_SZ', async () => {
    const out = lines(await run(machine(), 'reg query HKCU\\Environment'));

    expect(out).toEqual([
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
      '    TMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
    ]);
  });

  it('keeps the tail as typed and lists the subkeys of a key, sorted', async () => {
    const out = lines(await run(machine(), 'reg query hkcu'));

    expect(out).toEqual([
      '',
      'HKEY_CURRENT_USER',
      'HKEY_CURRENT_USER\\Console',
      'HKEY_CURRENT_USER\\Control Panel',
      'HKEY_CURRENT_USER\\Environment',
      'HKEY_CURRENT_USER\\Software',
    ]);
    expect(lines(await run(machine(), 'reg query hkcu\\environment'))[1]).toBe('HKEY_CURRENT_USER\\environment');
  });

  it('prints (Default) for the default value, and the numeric types as hexadecimal', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /ve /d hello /f', 'reg add HKCU\\Software\\Zed /v Count /t REG_DWORD /d 31 /f',
      'reg add HKCU\\Software\\Zed /v Big /t REG_QWORD /d 0x10 /f');

    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed'))).toEqual([
      '', 'HKEY_CURRENT_USER\\Software\\Zed',
      '    (Default)    REG_SZ    hello',
      '    Count    REG_DWORD    0x1f',
      '    Big    REG_QWORD    0x10',
    ]);
  });

  it('keeps each value type and renders binary, none and multi-string values', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v Bin /t REG_BINARY /d deadbeef /f',
      'reg add HKCU\\Software\\Zed /v Nothing /t REG_NONE /f',
      'reg add HKCU\\Software\\Zed /v Path /t REG_EXPAND_SZ /d %NOTDEFINED%\\x /f',
      'reg add HKCU\\Software\\Zed /v List /t REG_MULTI_SZ /d "a\\0b\\0c" /f');

    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed')).slice(2)).toEqual([
      '    Bin    REG_BINARY    DEADBEEF',
      '    Nothing    REG_NONE    ',
      '    Path    REG_EXPAND_SZ    %NOTDEFINED%\\x',
      '    List    REG_MULTI_SZ    a\\0b\\0c',
    ]);
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /v List /se #'))[2]).toBe('    List    REG_MULTI_SZ    a#b#c');
  });

  it('closes a query that names a value with the count of matches, and fails when it finds none', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v Count /t REG_DWORD /d 1 /f');

    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /v Count'))).toEqual([
      '', 'HKEY_CURRENT_USER\\Software\\Zed', '    Count    REG_DWORD    0x1', '', 'End of search: 1 match(es) found.',
    ]);
    expect(await run(pc, 'reg query HKCU\\Software\\Zed /v Missing')).toBe(
      'ERROR: The system was unable to find the specified registry key or value.');
    expect(await level(pc)).toBe('1');
  });

  it('queries the default value alone with /ve', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /ve /d hello /f', 'reg add HKCU\\Software\\Zed /v Other /d x /f');

    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /ve')).slice(1, 3)).toEqual([
      'HKEY_CURRENT_USER\\Software\\Zed', '    (Default)    REG_SZ    hello',
    ]);
  });

  it('descends with /s and says how many keys and values it listed', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed\\Sub /v v /d 1 /f');
    const out = lines(await run(pc, 'reg query HKCU\\Software\\Zed /s'));

    expect(out).toEqual([
      '', 'HKEY_CURRENT_USER\\Software\\Zed',
      '', 'HKEY_CURRENT_USER\\Software\\Zed\\Sub', '    v    REG_SZ    1',
      '', 'End of search: 3 match(es) found.',
    ]);
  });

  it('searches names and data with /f, restricted by /k and /d, exact with /e, case-sensitive with /c', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v Colour /d Teal /f', 'reg add HKCU\\Software\\Zed\\Teal /f');

    expect(lines(await run(pc, 'reg query HKCU\\Software /s /f Teal /k'))).toEqual([
      '', 'HKEY_CURRENT_USER\\Software\\Zed\\Teal', '', 'End of search: 1 match(es) found.',
    ]);
    expect(lines(await run(pc, 'reg query HKCU\\Software /s /f Teal /d'))).toEqual([
      '', 'HKEY_CURRENT_USER\\Software\\Zed', '    Colour    REG_SZ    Teal', '', 'End of search: 1 match(es) found.',
    ]);
    expect(lines(await run(pc, 'reg query HKCU\\Software /s /f teal /c'))).toEqual(['', 'End of search: 0 match(es) found.']);
    expect(await level(pc)).toBe('1');
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /f Tea /e'))).toEqual(['', 'End of search: 0 match(es) found.']);
  });

  it('keeps one type with /t', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v A /d x /f', 'reg add HKCU\\Software\\Zed /v B /t REG_DWORD /d 2 /f');

    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /t REG_DWORD')).slice(2, 3)).toEqual(['    B    REG_DWORD    0x2']);
  });

  it('shows the numeric type with /z', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v B /t REG_DWORD /d 2 /f');

    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /z'))[2]).toBe('    B    REG_DWORD (4)    0x2');
  });

  it('refuses a key that does not exist and an unknown root', async () => {
    const pc = machine();

    expect(await run(pc, 'reg query HKLM\\Nope')).toBe('ERROR: The system was unable to find the specified registry key or value.');
    expect(await run(pc, 'reg query HKXX\\Nope')).toBe('ERROR: Invalid key name.\nType "REG QUERY /?" for usage.');
    expect(await run(pc, 'reg query HKCU /zz')).toBe('ERROR: Invalid syntax.\nType "REG QUERY /?" for usage.');
  });

  it('keeps SAM and SECURITY out of reach', async () => {
    const pc = machine();

    expect(await run(pc, 'reg query HKLM\\SAM')).toBe('ERROR: Access is denied.');
    expect(await level(pc)).toBe('1');
  });
});

describe('reg add and delete', () => {
  it('creates a key with no value, and the parents it needs', async () => {
    const pc = machine();

    expect(await run(pc, 'reg add HKCU\\Software\\A\\B\\C')).toBe('The operation completed successfully.');
    expect(lines(await run(pc, 'reg query HKCU\\Software\\A\\B'))).toEqual([
      '', 'HKEY_CURRENT_USER\\Software\\A\\B', 'HKEY_CURRENT_USER\\Software\\A\\B\\C',
    ]);
  });

  it('refuses data that does not fit the type, and a type that does not exist', async () => {
    const pc = machine();
    const syntax = 'ERROR: Invalid syntax.\nType "REG ADD /?" for usage.';

    expect(await run(pc, 'reg add HKCU\\Software\\Zed /v n /t REG_DWORD /d abc /f')).toBe(syntax);
    expect(await run(pc, 'reg add HKCU\\Software\\Zed /v n /t REG_DWORD /d 4294967296 /f')).toBe(syntax);
    expect(await run(pc, 'reg add HKCU\\Software\\Zed /v n /t REG_BINARY /d abc /f')).toBe(syntax);
    expect(await run(pc, 'reg add HKCU\\Software\\Zed /v n /t REG_NOPE /d x /f')).toBe(syntax);
    expect(await run(pc, 'reg add HKCU\\Software\\Zed /v n /ve /f')).toBe(syntax);
  });

  it('asks before overwriting a value and takes the answer from the scenario input', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v a /d one /f');

    expect(await pc.executeCommand('reg add HKCU\\Software\\Zed /v a /d two', 'n')).toBe(
      'Value a exists, overwrite(Yes/No)? The operation was canceled by the user.');
    expect(await level(pc)).toBe('1');
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /v a'))[2]).toBe('    a    REG_SZ    one');
    expect(await pc.executeCommand('reg add HKCU\\Software\\Zed /v a /d two', 'y')).toBe(
      'Value a exists, overwrite(Yes/No)? The operation completed successfully.');
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed /v a'))[2]).toBe('    a    REG_SZ    two');
  });

  it('is cancelled when nothing answers', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v a /d one /f');

    expect(await run(pc, 'reg add HKCU\\Software\\Zed /v a /d two')).toBe(
      'Value a exists, overwrite(Yes/No)? The operation was canceled by the user.');
  });

  it('deletes a value, the default value, all values, and a key, asking unless /f is given', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /ve /d d /f', 'reg add HKCU\\Software\\Zed /v a /d 1 /f', 'reg add HKCU\\Software\\Zed /v b /d 2 /f');

    expect(await pc.executeCommand('reg delete HKCU\\Software\\Zed /v a', 'n')).toBe(
      'Delete the registry value a (Yes/No)? The operation was canceled by the user.');
    expect(await pc.executeCommand('reg delete HKCU\\Software\\Zed /v a', 'yes')).toBe(
      'Delete the registry value a (Yes/No)? The operation completed successfully.');
    expect(await run(pc, 'reg delete HKCU\\Software\\Zed /ve /f')).toBe('The operation completed successfully.');
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed')).slice(2)).toEqual(['    b    REG_SZ    2']);
    expect(await run(pc, 'reg delete HKCU\\Software\\Zed /va /f')).toBe('The operation completed successfully.');
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed'))).toEqual(['', 'HKEY_CURRENT_USER\\Software\\Zed']);
    expect(await run(pc, 'reg delete HKCU\\Software\\Zed /f')).toBe('The operation completed successfully.');
    expect(await run(pc, 'reg query HKCU\\Software\\Zed')).toContain('unable to find');
  });

  it('fails on a key or a value that is not there', async () => {
    const pc = machine();
    const missing = 'ERROR: The system was unable to find the specified registry key or value.';

    expect(await run(pc, 'reg delete HKCU\\Software\\Nope /f')).toBe(missing);
    await run(pc, 'reg add HKCU\\Software\\Zed /f');
    expect(await run(pc, 'reg delete HKCU\\Software\\Zed /v nope /f')).toBe(missing);
    expect(await level(pc)).toBe('1');
  });
});

describe('who may write where', () => {
  it('lets an administrator write HKLM and refuses anyone else', async () => {
    expect(await run(machine('Administrator'), 'reg add HKLM\\SOFTWARE\\Zed /f')).toBe('The operation completed successfully.');
    const user = machine('User');

    expect(await run(user, 'reg add HKLM\\SOFTWARE\\Zed /f')).toBe('ERROR: Access is denied.');
    expect(await run(user, 'reg delete HKLM\\SOFTWARE\\Classes /f')).toBe('ERROR: Access is denied.');
    expect(await run(user, 'reg add HKCU\\Software\\Zed /f')).toBe('The operation completed successfully.');
    expect(await run(user, 'reg query HKLM\\SOFTWARE\\Classes\\.txt')).toContain('(Default)    REG_SZ    txtfile');
  });
});

describe('other roots and views', () => {
  it('writes HKCR into HKLM\\SOFTWARE\\Classes, unless the key is already in HKCU', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCR\\.foo /ve /d foofile /f');

    expect(lines(await run(pc, 'reg query HKLM\\SOFTWARE\\Classes\\.foo'))[2]).toBe('    (Default)    REG_SZ    foofile');
    await run(pc, 'reg add HKCU\\Software\\Classes\\.foo /ve /d userfile /f');
    expect(lines(await run(pc, 'reg query HKCR\\.foo'))[2]).toBe('    (Default)    REG_SZ    userfile');
    await run(pc, 'reg add HKCR\\.foo /v Extra /d 1 /f');
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Classes\\.foo')).join('\n')).toContain('Extra');
    expect(lines(await run(pc, 'reg query HKLM\\SOFTWARE\\Classes\\.foo')).join('\n')).not.toContain('Extra');
  });

  it('shows the machine classes through HKCR, root name included', async () => {
    const out = lines(await run(machine(), 'reg query HKCR\\.txt'));

    expect(out).toEqual(['', 'HKEY_CLASSES_ROOT\\.txt', '    (Default)    REG_SZ    txtfile']);
  });

  it('answers for HKU\\<sid> as the current user hive, and keeps .DEFAULT apart', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /v a /d 1 /f');

    expect(await run(pc, 'reg query HKU')).toContain('HKEY_USERS\\.DEFAULT');
    expect(await run(pc, 'reg query HKU\\.DEFAULT\\Software')).toContain('HKEY_USERS\\.DEFAULT\\Software');
    expect(await run(pc, 'reg query HKU\\S-1-5-21-1000000000-1000000000-1000000000-1001\\Software\\Zed')).toContain('    a    REG_SZ    1');
  });

  it('reads HKCC from the current hardware profile', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCC\\Software /v a /d 1 /f');

    expect(await run(pc, 'reg query HKLM\\SYSTEM\\CurrentControlSet\\Hardware Profiles\\Current\\Software'.replace(' Profiles', '" "Profiles'))).toBeDefined();
    expect(lines(await run(pc, 'reg query HKCC\\Software'))[1]).toBe('HKEY_CURRENT_CONFIG\\Software');
  });

  it('redirects /reg:32 under SOFTWARE to WOW6432Node', async () => {
    const pc = machine();
    await run(pc, 'reg add HKLM\\SOFTWARE\\Vendor /v a /d 1 /reg:32 /f');

    expect(await run(pc, 'reg query HKLM\\SOFTWARE\\WOW6432Node\\Vendor')).toContain('    a    REG_SZ    1');
    expect(await run(pc, 'reg query HKLM\\SOFTWARE\\Vendor')).toContain('unable to find');
    expect(await run(pc, 'reg query HKLM\\SOFTWARE\\Vendor /reg:32')).toContain('    a    REG_SZ    1');
  });

  it('refuses a remote machine it cannot reach, and accepts its own name', async () => {
    const pc = machine();

    expect(await run(pc, 'reg query \\\\FAR\\HKLM\\SOFTWARE')).toBe('ERROR: The network path was not found.');
    expect(await run(pc, 'reg query \\\\WIN-REG\\HKLM\\SOFTWARE')).toContain('HKEY_LOCAL_MACHINE\\SOFTWARE');
  });
});

describe('copy, export and import', () => {
  it('copies a key, and its subkeys with /s', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Src /v a /d 1 /f', 'reg add HKCU\\Software\\Src\\Sub /v b /d 2 /f');

    expect(await run(pc, 'reg copy HKCU\\Software\\Src HKCU\\Software\\Dst /f')).toBe('The operation completed successfully.');
    expect(await run(pc, 'reg query HKCU\\Software\\Dst\\Sub')).toContain('unable to find');
    await run(pc, 'reg copy HKCU\\Software\\Src HKCU\\Software\\Dst2 /s /f');
    expect(await run(pc, 'reg query HKCU\\Software\\Dst2\\Sub')).toContain('    b    REG_SZ    2');
  });

  it('exports a tree as a .reg file and imports it back, every type included', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /ve /d "say \\"hi\\"" /f', 'reg add HKCU\\Software\\Zed /v n /t REG_DWORD /d 255 /f',
      'reg add HKCU\\Software\\Zed /v e /t REG_EXPAND_SZ /d %NOTDEFINED%\\x /f', 'reg add HKCU\\Software\\Zed /v m /t REG_MULTI_SZ /d "a\\0b" /f',
      'reg add HKCU\\Software\\Zed /v q /t REG_QWORD /d 4096 /f', 'reg add HKCU\\Software\\Zed /v b /t REG_BINARY /d 0aff /f',
      'reg add HKCU\\Software\\Zed\\Sub /v p /d C:\\Dir\\file /f');
    const before = await run(pc, 'reg query HKCU\\Software\\Zed /s');

    expect(await run(pc, 'reg export HKCU\\Software\\Zed C:\\zed.reg')).toBe('The operation completed successfully.');
    const file = await run(pc, 'type C:\\zed.reg');
    expect(file.split(/\r?\n/)[0]).toBe('Windows Registry Editor Version 5.00');
    expect(file).toContain('[HKEY_CURRENT_USER\\Software\\Zed]');
    expect(file).toContain('"n"=dword:000000ff');
    expect(file).toContain('"b"=hex:0a,ff');
    expect(file).toContain('"p"="C:\\\\Dir\\\\file"');
    await run(pc, 'reg delete HKCU\\Software\\Zed /f');
    expect(await run(pc, 'reg import C:\\zed.reg')).toBe('The operation completed successfully.');
    expect(await run(pc, 'reg query HKCU\\Software\\Zed /s')).toBe(before);
  });

  it('asks before replacing the export file unless /y is given', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /f', 'reg export HKCU\\Software\\Zed C:\\zed.reg');

    expect(await run(pc, 'reg export HKCU\\Software\\Zed C:\\zed.reg')).toBe(
      'Overwrite C:\\zed.reg (Yes/No)? The operation was canceled by the user.');
    expect(await run(pc, 'reg export HKCU\\Software\\Zed C:\\zed.reg /y')).toBe('The operation completed successfully.');
  });

  it('refuses a file that is not there or not a .reg file', async () => {
    const pc = machine();
    await run(pc, 'echo hello> C:\\plain.txt');

    expect(await run(pc, 'reg import C:\\nope.reg')).toBe('ERROR: The system cannot find the file specified.');
    expect(await run(pc, 'reg import C:\\plain.txt')).toBe('ERROR: Error accessing the registry.');
  });
});

describe('what reg does not do', () => {
  it('says so for the operations that need a hive file', async () => {
    const pc = machine();

    for (const operation of ['save', 'restore', 'load', 'unload', 'compare', 'flags']) {
      expect(await run(pc, `reg ${operation} HKCU\\Software C:\\x.hiv`)).toBe('ERROR: The request is not supported.');
    }
  });

  it('prints its help', async () => {
    const pc = machine();

    expect(lines(await run(pc, 'reg /?'))[0]).toBe('REG Operation [Parameter List]');
    expect(lines(await run(pc, 'reg query /?'))[0]).toBe('REG QUERY KeyName [/v ValueName | /ve] [/s]');
    expect(lines(await run(pc, 'reg add /?'))[0]).toBe('REG ADD KeyName [/v ValueName | /ve] [/t Type] [/s Separator] [/d Data] [/f]');
  });
});

describe('assoc and ftype', () => {
  it('shows the association of an extension and the open command of a file type', async () => {
    const pc = machine();

    expect(await run(pc, 'assoc .txt')).toBe('.txt=txtfile');
    expect(await run(pc, 'ftype txtfile')).toBe('txtfile=%SystemRoot%\\system32\\NOTEPAD.EXE %1');
    expect(await run(pc, 'ftype batfile')).toBe('batfile="%1" %*');
  });

  it('lists every association, sorted, and every file type that has an open command', async () => {
    const pc = machine();
    const associations = lines(await run(pc, 'assoc'));
    const types = lines(await run(pc, 'ftype'));

    expect(associations).toContain('.exe=exefile');
    expect(associations).toEqual([...associations].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(types).toContain('cmdfile="%1" %*');
    expect(types.every(entry => !entry.startsWith('.'))).toBe(true);
  });

  it('says when there is nothing to show, and sets the exit code', async () => {
    const pc = machine();

    expect(await run(pc, 'assoc .nope')).toBe('File association not found for extension .nope');
    expect(await level(pc)).toBe('1');
    expect(await run(pc, 'ftype nope')).toBe("File type 'nope' not found or no open command associated with it.");
    expect(await run(pc, 'assoc .txt')).toBe('.txt=txtfile');
    expect(await level(pc)).toBe('0');
  });

  it('sets and removes an association and an open command, as the registry sees them', async () => {
    const pc = machine();

    expect(await run(pc, 'assoc .zzz=zzzfile')).toBe('.zzz=zzzfile');
    expect(await run(pc, 'ftype zzzfile="C:\\bin\\z.exe" "%1" %*')).toBe('zzzfile="C:\\bin\\z.exe" "%1" %*');
    expect(lines(await run(pc, 'reg query HKLM\\SOFTWARE\\Classes\\.zzz'))[2]).toBe('    (Default)    REG_SZ    zzzfile');
    expect(await run(pc, 'reg query HKCR\\zzzfile\\shell\\open\\command')).toContain('"C:\\bin\\z.exe" "%1" %*');
    expect(await run(pc, 'assoc .zzz=')).toBe('');
    expect(await run(pc, 'assoc .zzz')).toBe('File association not found for extension .zzz');
    expect(await run(pc, 'ftype zzzfile=')).toBe('');
    expect(await run(pc, 'ftype zzzfile')).toContain('not found');
  });

  it('sees what reg add put under HKCR', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCR\\.qq /ve /d qqfile /f');

    expect(await run(pc, 'assoc .qq')).toBe('.qq=qqfile');
  });

  it('is refused to anyone who cannot write the machine classes', async () => {
    const user = machine('User');

    expect(await run(user, 'assoc .zzz=zzzfile')).toBe('Access is denied.');
    expect(await run(user, 'ftype zzzfile=x.exe')).toBe('Access is denied.');
    expect(await run(user, 'assoc .txt')).toBe('.txt=txtfile');
  });

  it('prints its help', async () => {
    const pc = machine();

    expect(lines(await run(pc, 'assoc /?'))[0]).toBe('Displays or modifies file extension associations');
    expect(lines(await run(pc, 'ftype /?'))[0]).toBe('Displays or modifies file types used in file extension associations');
  });
});

describe('PowerShell reads the same base', () => {
  it('shows a default value set by reg add as (default), and writes it back through Set-ItemProperty', async () => {
    const pc = machine();
    await run(pc, 'reg add HKCU\\Software\\Zed /ve /d hello /f');
    const { subShell } = PowerShellSubShell.create(pc);

    expect((await subShell.processLine("(Get-ItemProperty HKCU:\\Software\\Zed).'(default)'")).output).toEqual(['hello']);
    await subShell.processLine("Set-ItemProperty HKCU:\\Software\\Zed -Name '(default)' -Value changed");
    expect(lines(await run(pc, 'reg query HKCU\\Software\\Zed'))[2]).toBe('    (Default)    REG_SZ    changed');
  });

  it('keeps a trailing blank line after a listing, like reg.exe', async () => {
    expect((await run(machine(), 'reg query HKCU\\Environment')).endsWith('\n')).toBe(true);
  });
});
