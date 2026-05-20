/**
 * Unit tests — reactive Oracle ↔ Linux process orchestration.
 *
 * When OracleInstance brings its background processes up, the orchestrator
 * must materialise them in LinuxProcessManager so `ps -ef | grep ora_`
 * actually finds them. On SHUTDOWN, they must vanish.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { getOracleDatabase, removeOracleDatabase } from '@/terminal/commands/database';

describe('Oracle background processes appear in the Linux process table', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'orcl-srv', 0, 0);
  });

  it('STARTUP OPEN spawns ora_pmon / ora_smon / ora_lgwr in `ps`', async () => {
    const db = getOracleDatabase(server.id);
    expect(db.instance.state).toBe('OPEN');

    const ps = await server.executeCommand('ps -ef -o pid,user,comm');
    expect(ps).toMatch(/oracle\s+ora_pmon/);
    expect(ps).toMatch(/oracle\s+ora_smon/);
    expect(ps).toMatch(/oracle\s+ora_lgwr/);

    removeOracleDatabase(server.id);
  });

  it('SHUTDOWN ABORT removes the background processes', async () => {
    const db = getOracleDatabase(server.id);
    expect(await server.executeCommand('ps -ef -o comm')).toContain('ora_pmon');

    db.instance.shutdown('ABORT');
    const after = await server.executeCommand('ps -ef -o comm');
    expect(after).not.toContain('ora_pmon');

    removeOracleDatabase(server.id);
  });
});
