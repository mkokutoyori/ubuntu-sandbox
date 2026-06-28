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

function shell(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
const run = (sh: ReturnType<typeof shell>, q: string) => sh.processLine(q).output.join('\n');

describe('CREATE PACKAGE — legacy regex path compiles and stores', () => {
  it('CREATE PACKAGE spec returns "Package created."', () => {
    const sh = shell('p1');
    const out = run(sh,
      'CREATE PACKAGE emp_pkg AS PROCEDURE hire(name VARCHAR2); END emp_pkg;',
    );
    expect(out).toMatch(/Package created\./);
    expect(out).not.toMatch(/ORA-00900/);
    expect(out).not.toMatch(/Unsupported CREATE target/i);
  });

  it('CREATE OR REPLACE PACKAGE BODY succeeds after a matching spec', () => {
    const sh = shell('p2');
    run(sh, 'CREATE PACKAGE emp_pkg AS PROCEDURE hire(name VARCHAR2); END emp_pkg;');
    const out = run(sh,
      'CREATE OR REPLACE PACKAGE BODY emp_pkg AS ' +
      'PROCEDURE hire(name VARCHAR2) IS BEGIN NULL; END; END emp_pkg;',
    );
    expect(out).toMatch(/Package body created\.|Warning|Package created/);
    expect(out).not.toMatch(/ORA-00900/);
  });

  it('the package shows up in DBA_OBJECTS after CREATE', () => {
    const sh = shell('p3');
    run(sh, 'CREATE PACKAGE emp_pkg AS PROCEDURE hire(n VARCHAR2); END;');
    const out = run(sh,
      "SELECT object_name, object_type FROM dba_objects " +
      "WHERE object_name='EMP_PKG' AND object_type LIKE 'PACKAGE%';",
    );
    expect(out).toContain('EMP_PKG');
    expect(out).toContain('PACKAGE');
  });

  it('redefining a package without OR REPLACE returns ORA-00955', () => {
    const sh = shell('p4');
    run(sh, 'CREATE PACKAGE emp_pkg AS PROCEDURE hire(n VARCHAR2); END;');
    const out = run(sh, 'CREATE PACKAGE emp_pkg AS PROCEDURE fire(n VARCHAR2); END;');
    expect(out).toMatch(/ORA-00955/);
  });
});
