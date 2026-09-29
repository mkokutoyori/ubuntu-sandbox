/*
 * `ssh -V` et `ssh` sans destination repondent comme le client OpenSSH du
 * systeme, au terminal comme dans un script.
 *
 * L'AUTORITE :
 * - OpenSSH 8.9p1, `ssh.c` : `-V` ecrit « SSH_RELEASE, SSH_OPENSSL_VERSION »
 *   pendant la lecture des options et sort en 0, quelle que soit la suite
 *   de la ligne ; sans destination, `usage()` ecrit ses sept lignes et
 *   sort en 255. `-v` n'ecrit pas la version : il monte le niveau de
 *   journal ;
 * - Ubuntu 22.04, dont le serveur du simulateur annonce deja
 *   « SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6 », et dont `openssl version`
 *   rend « OpenSSL 3.0.2 15 Mar 2022 » : le client du meme systeme est
 *   « OpenSSH_8.9p1 Ubuntu-3ubuntu0.6, OpenSSL 3.0.2 15 Mar 2022 » ;
 * - Windows 11 22H2/23H2 (le simulateur rend la version 10.0.22631) : le
 *   client livre avec le systeme se presente « OpenSSH_for_Windows_8.6p1,
 *   LibreSSL 3.4.3 » (PowerShell/Win32-OpenSSH, issue #2039).
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire les chemins.
 * 10 des 11 cas tombent avant le correctif. Passe des deux cotes le TEMOIN
 * `openssl version -v`, qui prouve que le systeme simule est bien celui
 * auquel les autres cas comparent le client.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const UBUNTU = 'OpenSSH_8.9p1 Ubuntu-3ubuntu0.6, OpenSSL 3.0.2 15 Mar 2022';
const WINDOWS = 'OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3';
const USAGE = [
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]',
  '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]',
  '           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]',
  '           [-i identity_file] [-J [user@]host[:port]] [-L address]',
  '           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port]',
  '           [-Q query_option] [-R address] [-S ctl_path] [-W host:port]',
  '           [-w local_tun[:remote_tun]] destination [command [argument ...]]',
].join('\n');

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function typed(term: LinuxTerminalSession | WindowsTerminalSession, line: string): Promise<string> {
  const before = term.lines.length;
  term.setInput(line);
  term.handleKey(key('Enter'));
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return term.lines.slice(before + 1).map((l) => l.text).filter((t) => t.trim() !== '').join('\n');
}

function linux(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  return pc;
}

function windows(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  pc.powerOn();
  return pc;
}

describe('Ubuntu 22.04', () => {
  it('ssh -V gives the client release of the system', async () => {
    expect((await linux().executeCommand('ssh -V')).trim()).toBe(UBUNTU);
  });

  it('openssl version is the Ubuntu 22.04 library — WITNESS of the system', async () => {
    expect((await linux().executeCommand('openssl version -v')).trim()).toBe('OpenSSL 3.0.2 15 Mar 2022');
  });

  it('the OpenSSL part of ssh -V is what openssl version says', async () => {
    const pc = linux();
    const openssl = (await pc.executeCommand('openssl version -v')).trim();

    expect((await pc.executeCommand('ssh -V')).trim().endsWith(`, ${openssl}`)).toBe(true);
  });

  it('-V wins over a destination: nothing is dialled', async () => {
    expect((await linux().executeCommand('ssh -V alice@10.9.9.9')).trim()).toBe(UBUNTU);
  });

  it('without a destination, ssh prints its usage', async () => {
    expect((await linux().executeCommand('ssh')).trim()).toBe(USAGE);
  });

  it('-v alone is verbosity, not the version: usage again', async () => {
    expect((await linux().executeCommand('ssh -v')).trim()).toBe(USAGE);
  });

  it('the terminal answers ssh -V like the command', async () => {
    expect(await typed(new LinuxTerminalSession('t1', linux()), 'ssh -V')).toBe(UBUNTU);
  });
});

describe('Windows 11 23H2', () => {
  it('ssh -V gives the in-box Win32-OpenSSH release', async () => {
    expect((await windows().executeCommand('ssh -V')).trim()).toBe(WINDOWS);
  });

  it('without a destination, ssh prints its usage', async () => {
    expect((await windows().executeCommand('ssh')).trim()).toBe(USAGE);
  });

  it('the terminal answers ssh -V like the command', async () => {
    expect(await typed(new WindowsTerminalSession('w1', windows()), 'ssh -V')).toBe(WINDOWS);
  });

  it('the terminal treats ssh -v as verbosity: usage, not the version', async () => {
    expect(await typed(new WindowsTerminalSession('w2', windows()), 'ssh -v')).toBe(USAGE);
  });
});
