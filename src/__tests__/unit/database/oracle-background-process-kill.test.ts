/**
 * Killing an Oracle *background* process from the OS — instance ⇄ process
 * coherence.
 *
 * Real Oracle treats its mandatory background processes as critical: a
 * `kill -9` of PMON / SMON / DBWn / LGWR / CKPT brings the whole instance
 * down (equivalent to SHUTDOWN ABORT), and the next startup performs
 * instance recovery. Non-critical processes (RECO / MMON / MMNL / ARCn)
 * are transparently restarted by PMON under a fresh pid, the instance
 * staying OPEN.
 *
 * Before this, killing any ora_* background process from the shell removed
 * it from `ps` but left the instance happily OPEN — V$ views still listed a
 * dead PMON. These tests pin the realistic behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getOracleDatabase } from '@/terminal/commands/database';
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

describe('Killing a critical background process crashes the instance', () => {
  it('pkill -9 ora_pmon takes the instance down (ABORT)', () => {
    const srv = boot('bg-1');
    const db = getOracleDatabase(srv.getId());
    expect(db.instance.state).toBe('OPEN');
    expect(sh(srv, 'ps -ef')).toMatch(/ora_pmon/);

    sh(srv, 'pkill -9 ora_pmon');

    expect(db.instance.state).toBe('SHUTDOWN');
    // Every background process is reaped from the host process table.
    expect(sh(srv, 'ps -ef')).not.toMatch(/ora_pmon/);
    expect(sh(srv, 'ps -ef')).not.toMatch(/ora_smon/);
  });

  it('killing SMON crashes the instance and records it in the alert log', () => {
    const srv = boot('bg-2');
    const db = getOracleDatabase(srv.getId());

    sh(srv, 'pkill -9 ora_smon');

    expect(db.instance.state).toBe('SHUTDOWN');
    const alert = db.instance.getAlertLog().join('\n');
    expect(alert).toMatch(/SMON \(ospid: \d+\): terminated with error/);
    expect(alert).toMatch(/Instance terminated by PMON/);
  });

  it('the crashed instance can be restarted afterwards', () => {
    const srv = boot('bg-3');
    const db = getOracleDatabase(srv.getId());
    sh(srv, 'pkill -9 ora_lgwr');
    expect(db.instance.state).toBe('SHUTDOWN');

    db.instance.startup('OPEN');
    expect(db.instance.state).toBe('OPEN');
    expect(sh(srv, 'ps -ef')).toMatch(/ora_pmon/);
  });
});

describe('Killing a non-critical background process is survived (PMON restart)', () => {
  it('pkill -9 ora_mmon restarts MMON under a new pid, instance stays OPEN', () => {
    const srv = boot('bg-4');
    const db = getOracleDatabase(srv.getId());
    const oldPid = db.instance.getBackgroundProcesses().find(p => p.name === 'MMON')!.pid;

    sh(srv, 'pkill -9 ora_mmon');

    expect(db.instance.state).toBe('OPEN');
    const newPid = db.instance.getBackgroundProcesses().find(p => p.name === 'MMON')!.pid;
    expect(newPid).not.toBe(oldPid);
    // The restarted daemon is back in `ps`.
    expect(sh(srv, 'ps -ef')).toMatch(/ora_mmon/);
    expect(db.instance.getAlertLog().join('\n')).toMatch(/Restarting dead background process MMON/);
  });
});

describe('A non-terminating signal leaves the instance untouched', () => {
  it('pkill -CONT ora_pmon does not crash the instance', () => {
    const srv = boot('bg-5');
    const db = getOracleDatabase(srv.getId());
    sh(srv, 'pkill -CONT ora_pmon');
    expect(db.instance.state).toBe('OPEN');
  });
});
