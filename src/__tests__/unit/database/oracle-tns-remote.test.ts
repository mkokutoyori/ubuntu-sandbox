/**
 * Oracle Net across the simulated network.
 *
 * Before this suite, `sqlplus user/pass@X` stripped the connect
 * identifier and always landed on the LOCAL instance: a client machine
 * could never reach a database on another host, and a wrong service
 * name connected anyway. Now the connect identifier resolves like a
 * real client — tnsnames.ora alias or EZConnect, host located on the
 * topology with the same lookup the SSH client uses — and the session
 * binds to the REMOTE OracleDatabase, with the real error ladder
 * (ORA-12154 / 12545 / 12170 / 12541 / 12514).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { handleLsnrctl, handleTnsping } from '@/terminal/commands/OracleCommands';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function lan() {
  const client = new LinuxServer('linux-server', 'dbclient', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(dbhost.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.setHostname('dbclient');
  dbhost.setHostname('dbhost');

  // Plant a marker table on the REMOTE database so a successful remote
  // connection is distinguishable from silently landing on local.
  const boot = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']);
  boot.subShell.processLine('CREATE TABLE system.remote_marker (city VARCHAR2(30));');
  boot.subShell.processLine("INSERT INTO system.remote_marker VALUES ('YAOUNDE');");
  boot.subShell.processLine('COMMIT;');
  boot.subShell.dispose();
  return { client, dbhost };
}

const tnsping = (dev: LinuxServer, target: string): string => {
  const out: string[] = [];
  handleTnsping(dev, [target], (t) => out.push(t));
  return out.join('\n');
};

describe('sqlplus over EZConnect reaches the remote database', () => {
  it('user/pass@//ip/service binds the session to the remote instance', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2/ORCL']);
    expect(r.loginOutput.join('\n')).toContain('Connected.');
    const rows = r.subShell.processLine('SELECT city FROM system.remote_marker;');
    expect(rows.output.join('\n')).toContain('YAOUNDE');
    r.subShell.dispose();
  });

  it('a plain local connection does NOT see the remote marker', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']);
    const rows = r.subShell.processLine('SELECT city FROM system.remote_marker;');
    expect(rows.output.join('\n')).toMatch(/ORA-00942/);
    r.subShell.dispose();
  });

  it('wrong service name → ORA-12514 from the remote listener', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2/NOPE']);
    expect(r.loginOutput.join('\n')).toMatch(/ORA-12514/);
    r.subShell.dispose();
  });

  it('remote listener stopped → ORA-12541; restart → connects again', () => {
    const { client, dbhost } = lan();
    handleLsnrctl(dbhost, ['stop'], () => {});
    const refused = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2/ORCL']);
    expect(refused.loginOutput.join('\n')).toMatch(/ORA-12541/);
    refused.subShell.dispose();

    handleLsnrctl(dbhost, ['start'], () => {});
    const ok = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2/ORCL']);
    expect(ok.loginOutput.join('\n')).toContain('Connected.');
    ok.subShell.dispose();
  });

  it('unknown host → ORA-12545', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.99/ORCL']);
    expect(r.loginOutput.join('\n')).toMatch(/ORA-12545/);
    r.subShell.dispose();
  });
});

describe('tnsnames.ora aliases are really consulted', () => {
  it('an alias added to the client tnsnames.ora resolves to the remote host', () => {
    const { client } = lan();
    // First sqlplus provisions the Oracle home (and tnsnames.ora).
    SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell.dispose();
    const path = '/u01/app/oracle/product/19c/dbhome_1/network/admin/tnsnames.ora';
    const existing = client.readFileForEditor(path) ?? '';
    client.writeFileFromEditor(path, existing + `
REMOTEDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = 10.0.0.2)(PORT = 1521))
    (CONNECT_DATA = (SERVICE_NAME = ORCL))
  )
`);
    const r = SqlPlusSubShell.create(client, ['system/oracle@REMOTEDB']);
    expect(r.loginOutput.join('\n')).toContain('Connected.');
    const rows = r.subShell.processLine('SELECT city FROM system.remote_marker;');
    expect(rows.output.join('\n')).toContain('YAOUNDE');
    r.subShell.dispose();
  });

  it('an alias absent from tnsnames.ora → ORA-12154', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@GHOSTDB']);
    expect(r.loginOutput.join('\n')).toMatch(/ORA-12154/);
    r.subShell.dispose();
  });
});

describe('in-session CONNECT and tnsping follow the same client', () => {
  it('CONNECT user/pass@//ip/service re-binds the live session remotely', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']);
    const conn = r.subShell.processLine('CONNECT system/oracle@//10.0.0.2/ORCL');
    expect(conn.output.join('\n')).toContain('Connected.');
    const rows = r.subShell.processLine('SELECT city FROM system.remote_marker;');
    expect(rows.output.join('\n')).toContain('YAOUNDE');
    r.subShell.dispose();
  });

  it('tnsping reflects the remote listener state', () => {
    const { client, dbhost } = lan();
    expect(tnsping(client, '//10.0.0.2:1521/ORCL')).toMatch(/OK \(\d+ msec\)/);
    handleLsnrctl(dbhost, ['stop'], () => {});
    expect(tnsping(client, '//10.0.0.2:1521/ORCL')).toMatch(/TNS-12541/);
  });

  it('tnsping an unknown host fails, the local alias still answers OK', () => {
    const { client } = lan();
    expect(tnsping(client, '//10.0.0.77/ORCL')).toMatch(/TNS-12541/);
    expect(tnsping(client, 'ORCL')).toMatch(/OK \(\d+ msec\)/);
  });
});

describe('queries cross database links (SELECT … FROM t@link)', () => {
  function localSysdba(client: import('@/network/devices/LinuxServer').LinuxServer) {
    return SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell;
  }

  it('a link with EZConnect USING reaches the remote rows', () => {
    const { client } = lan();
    const sh = localSysdba(client);
    sh.processLine("CREATE DATABASE LINK farlink CONNECT TO system IDENTIFIED BY oracle USING '//10.0.0.2/ORCL';");
    const rows = sh.processLine('SELECT city FROM remote_marker@farlink;');
    expect(rows.output.join('\n')).toContain('YAOUNDE');
    // The local database genuinely has no such table.
    expect(sh.processLine('SELECT city FROM remote_marker;').output.join('\n')).toMatch(/ORA-00942/);
    sh.dispose();
  });

  it('a link whose USING is a tnsnames alias resolves through the file', () => {
    const { client } = lan();
    const sh = localSysdba(client);
    const path = '/u01/app/oracle/product/19c/dbhome_1/network/admin/tnsnames.ora';
    const existing = client.readFileForEditor(path) ?? '';
    client.writeFileFromEditor(path, existing + `
FARDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = 10.0.0.2)(PORT = 1521))
    (CONNECT_DATA = (SERVICE_NAME = ORCL))
  )
`);
    sh.processLine("CREATE DATABASE LINK aliaslink CONNECT TO system IDENTIFIED BY oracle USING 'FARDB';");
    const rows = sh.processLine('SELECT city FROM remote_marker@aliaslink;');
    expect(rows.output.join('\n')).toContain('YAOUNDE');
    sh.dispose();
  });

  it('an undefined link raises ORA-02019', () => {
    const { client } = lan();
    const sh = localSysdba(client);
    expect(sh.processLine('SELECT * FROM remote_marker@ghostlink;').output.join('\n'))
      .toMatch(/ORA-02019/);
    sh.dispose();
  });

  it('bad link credentials surface the remote ORA-01017', () => {
    const { client } = lan();
    const sh = localSysdba(client);
    sh.processLine("CREATE DATABASE LINK badlink CONNECT TO system IDENTIFIED BY wrong USING '//10.0.0.2/ORCL';");
    expect(sh.processLine('SELECT * FROM remote_marker@badlink;').output.join('\n'))
      .toMatch(/ORA-01017/);
    sh.dispose();
  });

  it('remote listener down → the link query fails with ORA-12541', () => {
    const { client, dbhost } = lan();
    const sh = localSysdba(client);
    sh.processLine("CREATE DATABASE LINK farlink CONNECT TO system IDENTIFIED BY oracle USING '//10.0.0.2/ORCL';");
    handleLsnrctl(dbhost, ['stop'], () => {});
    expect(sh.processLine('SELECT * FROM remote_marker@farlink;').output.join('\n'))
      .toMatch(/ORA-12541/);
    sh.dispose();
  });
});

describe('DML across database links settles with the local transaction', () => {
  function linked(client: import('@/network/devices/LinuxServer').LinuxServer) {
    const sh = SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell;
    sh.processLine("CREATE DATABASE LINK dmllink CONNECT TO system IDENTIFIED BY oracle USING '//10.0.0.2/ORCL';");
    return sh;
  }
  const remoteRows = (dbhost: import('@/network/devices/LinuxServer').LinuxServer) => {
    const sh = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell;
    const out = sh.processLine('SELECT city FROM system.remote_marker ORDER BY city;').output.join('\n');
    sh.dispose();
    return out;
  };

  it('INSERT @link then COMMIT lands on the remote database', () => {
    const { client, dbhost } = lan();
    const sh = linked(client);
    expect(sh.processLine("INSERT INTO remote_marker@dmllink VALUES ('DOUALA');").output.join('\n'))
      .toMatch(/1 row created/);
    sh.processLine('COMMIT;');
    sh.dispose();
    expect(remoteRows(dbhost)).toContain('DOUALA');
  });

  it('UPDATE and DELETE @link work with WHERE clauses', () => {
    const { client, dbhost } = lan();
    const sh = linked(client);
    sh.processLine("INSERT INTO remote_marker@dmllink VALUES ('GAROUA');");
    sh.processLine("UPDATE remote_marker@dmllink SET city = 'MAROUA' WHERE city = 'GAROUA';");
    sh.processLine("DELETE FROM remote_marker@dmllink WHERE city = 'YAOUNDE';");
    sh.processLine('COMMIT;');
    sh.dispose();
    const out = remoteRows(dbhost);
    expect(out).toContain('MAROUA');
    expect(out).not.toContain('GAROUA');
    expect(out).not.toContain('YAOUNDE');
  });

  it('ROLLBACK undoes the remote change', () => {
    const { client, dbhost } = lan();
    const sh = linked(client);
    sh.processLine("INSERT INTO remote_marker@dmllink VALUES ('BAFOUSSAM');");
    sh.processLine('ROLLBACK;');
    sh.dispose();
    expect(remoteRows(dbhost)).not.toContain('BAFOUSSAM');
  });

  it('DML through an undefined link raises ORA-02019', () => {
    const { client } = lan();
    const sh = SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell;
    expect(sh.processLine("INSERT INTO remote_marker@nolink VALUES ('X');").output.join('\n'))
      .toMatch(/ORA-02019/);
    sh.dispose();
  });
});

describe('remote connections honour the configured listener port', () => {
  it('after moving the remote listener to 1530, only that port answers', () => {
    const { client, dbhost } = lan();
    const path = '/u01/app/oracle/product/19c/dbhome_1/network/admin/listener.ora';
    const conf = dbhost.readFileForEditor(path)!;
    dbhost.writeFileFromEditor(path, conf.replace('(PORT = 1521)', '(PORT = 1530)'));
    handleLsnrctl(dbhost, ['stop'], () => {});
    handleLsnrctl(dbhost, ['start'], () => {});

    const refused = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2:1521/ORCL']);
    expect(refused.loginOutput.join('\n')).toMatch(/ORA-12541/);
    refused.subShell.dispose();

    const ok = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2:1530/ORCL']);
    expect(ok.loginOutput.join('\n')).toContain('Connected.');
    ok.subShell.dispose();

    expect(tnsping(client, '//10.0.0.2:1530/ORCL')).toMatch(/OK \(\d+ msec\)/);
    expect(tnsping(client, '//10.0.0.2:1521/ORCL')).toMatch(/TNS-12541/);
  });
});
