/**
 * registerDefaults — install the built-in shell implementations into
 * the {@link ShellFactory} registry.
 *
 * Call this from the application bootstrap (or once per test setup);
 * the call is idempotent.
 *
 * Keeping registration in its own module lets the factory and the
 * concrete shells live in their own files without circular imports:
 * the factory knows nothing about LinuxBashShell, and LinuxBashShell
 * imports the factory but not its siblings.
 */

import { ShellFactory } from './ShellFactory';
import { LinuxBashShell } from './adapters/LinuxBashShell';
import { WindowsCmdShell } from './adapters/WindowsCmdShell';
import { WindowsPowerShellShell } from './adapters/WindowsPowerShellShell';
import { SqlPlusShell } from './adapters/SqlPlusShell';
import { RmanShell } from './adapters/RmanShell';
import { CiscoIOSShellAdapter } from './adapters/CiscoIOSShellAdapter';
import { HuaweiVRPShellAdapter } from './adapters/HuaweiVRPShellAdapter';
import { SftpShell } from './adapters/SftpShell';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';
import type { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';

let installed = false;

export function installDefaultShells(): void {
  if (installed) return;
  installed = true;
  ShellFactory.register('bash', (a) => new LinuxBashShell(a));
  ShellFactory.register('cmd', (a) => {
    const windowsSession = (a as { extras?: { windowsSession?: WindowsShellSession | null } })
      .extras?.windowsSession ?? null;
    return new WindowsCmdShell({
      device: a.device, user: a.user, context: a.context,
      parent: a.parent ?? null, windowsSession,
    });
  });
  // PowerShell honours the per-terminal `WindowsShellSession` when the
  // caller (the cmd terminal session) hands one through `extras`. SSH
  // push and tests omit it; the shell falls back to the device-wide cwd.
  ShellFactory.register('powershell', (a) => {
    const windowsSession = (a as { extras?: { windowsSession?: WindowsShellSession | null } })
      .extras?.windowsSession ?? null;
    return new WindowsPowerShellShell({
      device: a.device, user: a.user, context: a.context,
      parent: a.parent ?? null, windowsSession,
    });
  });
  ShellFactory.register('sqlplus', (a) => new SqlPlusShell(a));
  ShellFactory.register('rman', (a) => new RmanShell(a));
  ShellFactory.register('cisco-ios', (a) => {
    const vty = (a as { extras?: { vty?: CliShellSession | null } }).extras?.vty ?? null;
    return new CiscoIOSShellAdapter({
      device: a.device, user: a.user, context: a.context,
      parent: a.parent ?? null, vty,
    });
  });
  ShellFactory.register('huawei-vrp', (a) => {
    const vty = (a as { extras?: { vty?: CliShellSession | null } }).extras?.vty ?? null;
    return new HuaweiVRPShellAdapter({
      device: a.device, user: a.user, context: a.context,
      parent: a.parent ?? null, vty,
    });
  });
  ShellFactory.register('sftp', (a) => {
    const session = (a as { extras?: { sftpSession?: SftpSession } }).extras?.sftpSession;
    if (!session) throw new Error('sftp shell requires extras.sftpSession');
    return new SftpShell({
      device: a.device, user: a.user, context: a.context,
      parent: a.parent ?? null, sftpSession: session,
    });
  });
}

/** Force re-registration — for tests that need a clean slate. */
export function reinstallDefaultShells(): void {
  installed = false;
  ShellFactory.reset();
  installDefaultShells();
}
