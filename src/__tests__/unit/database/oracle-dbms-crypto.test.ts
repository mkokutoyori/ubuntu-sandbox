/**
 * Integration guard: DBMS_CRYPTO is callable through SQL*Plus and returns the
 * real digest (the package was previously unimplemented).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { sha256, bytesToHex, utf8ToBytes } from '@/crypto';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function newSession(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

describe('DBMS_CRYPTO via SQL*Plus', () => {
  it('EXEC DBMS_CRYPTO.HASH returns the real SHA-256 digest', () => {
    const sh = newSession('dc-1');
    sh.processLine('SET SERVEROUTPUT ON');
    const out = sh.processLine("EXEC DBMS_CRYPTO.HASH('Hello', 4);").output.join('\n');
    const expected = bytesToHex(sha256(utf8ToBytes('Hello'))).toUpperCase();
    expect(out).toContain(expected);
    sh.dispose();
  });
});
