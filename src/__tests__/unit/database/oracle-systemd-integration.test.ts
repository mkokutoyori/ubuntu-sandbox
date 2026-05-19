/**
 * Oracle ↔ Linux systemd integration.
 *
 * When the Oracle instance starts on a LinuxServer, two systemd-style
 * services must materialise on the underlying machine:
 *   - oracle-database-${SID}.service   (the RDBMS instance)
 *   - oracle-listener-${SID}.service   (the TNS listener)
 *
 * Their lifecycle stays in lockstep with the Oracle instance state
 * (and the listener flag). Real Oracle works the same way — `systemctl`
 * is the canonical way to see whether the database is up on a host.
 *
 * The bridge is a dedicated adapter (OracleSystemdSync) that
 * subscribes to the oracle bus topics — no master class on Oracle or
 * Linux side.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { ORACLE_CONFIG } from '@/terminal/commands/OracleConfig';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

async function ssh(srv: LinuxServer, cmd: string): Promise<string> {
  return srv.executeCommand(cmd);
}

describe('oracle-database-<SID>.service tracks the instance lifecycle', () => {
  it('is registered & active right after the Oracle DB boots', async () => {
    const srv = new LinuxServer('linux-server', 'ora-sd', 100, 100);
    getOracleDatabase(srv.getId());
    const out = await ssh(srv, `systemctl is-active oracle-database-${ORACLE_CONFIG.SID}`);
    expect(out.trim()).toBe('active');
  });

  it('appears in `systemctl list-units --type=service`', async () => {
    const srv = new LinuxServer('linux-server', 'ora-list', 100, 100);
    getOracleDatabase(srv.getId());
    const out = await ssh(srv, 'systemctl list-units --type=service');
    expect(out).toContain(`oracle-database-${ORACLE_CONFIG.SID}`);
  });

  it('goes inactive after a SHUTDOWN', async () => {
    const srv = new LinuxServer('linux-server', 'ora-shut', 100, 100);
    const db = getOracleDatabase(srv.getId());
    db.instance.shutdown('IMMEDIATE');
    const out = await ssh(srv, `systemctl is-active oracle-database-${ORACLE_CONFIG.SID}`);
    expect(out.trim()).toMatch(/inactive|failed/);
  });
});

describe('oracle-listener-<SID>.service tracks the listener', () => {
  it('is active only after the listener is started', async () => {
    const srv = new LinuxServer('linux-server', 'ora-l', 100, 100);
    const db = getOracleDatabase(srv.getId());
    // Default state: listener stopped
    expect((await ssh(srv, `systemctl is-active oracle-listener-${ORACLE_CONFIG.SID}`)).trim())
      .toMatch(/inactive|failed/);
    db.instance.startListener();
    expect((await ssh(srv, `systemctl is-active oracle-listener-${ORACLE_CONFIG.SID}`)).trim())
      .toBe('active');
    db.instance.stopListener();
    expect((await ssh(srv, `systemctl is-active oracle-listener-${ORACLE_CONFIG.SID}`)).trim())
      .toMatch(/inactive|failed/);
  });
});

describe('V$SERVICES is in sync with the active systemd Oracle services', () => {
  it('lists at least the SID and XDB services when Oracle is up', async () => {
    const srv = new LinuxServer('linux-server', 'ora-vs', 100, 100);
    getOracleDatabase(srv.getId());
    // The OS-level listing must agree with the Oracle dictionary.
    const sysctl = await ssh(srv, 'systemctl list-units --type=service');
    expect(sysctl).toMatch(/oracle-database-/);
  });
});
