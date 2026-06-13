import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function boot(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

describe('shell rman drives the real reactive engine (not a banner stub)', () => {
  it('piped BACKUP DATABASE runs and reports the backup', () => {
    const srv = boot('shell-rman-1');
    const out = sh(srv, 'echo "BACKUP DATABASE;" | rman target /');
    expect(out).toMatch(/Recovery Manager/);
    expect(out).toMatch(/Starting backup|backup piece|Finished backup|backup set/i);
    expect(out).not.toMatch(/command not found/);
  });

  it('LIST BACKUP after a backup shows the catalog', () => {
    const srv = boot('shell-rman-2');
    sh(srv, 'echo "BACKUP DATABASE;" | rman target /');
    const out = sh(srv, 'echo "LIST BACKUP SUMMARY;" | rman target /');
    expect(out).toMatch(/List of Backups|BS Key|Full|TYPE/i);
  });

  it('rman with no piped script still prints the connected banner', () => {
    const srv = boot('shell-rman-3');
    const out = sh(srv, 'rman target /');
    expect(out).toMatch(/connected to target database/i);
  });
});
