/**
 * Scenario 10 — Dead Connection Detection (DCD) mid-transaction.
 *
 * A remote client opens a transaction (INSERT/UPDATE, no COMMIT), then the
 * network is severed abruptly (client interface goes down) — no ROLLBACK
 * is ever sent. The server-side DeadConnectionMonitor (driven by
 * SQLNET.EXPIRE_TIME) must detect the vanished peer, roll back the
 * uncommitted work, release every lock, and clean up V$SESSION /
 * V$TRANSACTION without any residual state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { DeadConnectionMonitor, type DcdSessionRef } from '@/database/oracle/network/DeadConnectionMonitor';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';

const TNSNAMES_PATH = `${ORACLE_CONFIG.HOME}/network/admin/tnsnames.ora`;
const SQLNET_ORA_PATH = `${ORACLE_CONFIG.HOME}/network/admin/sqlnet.ora`;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function lan() {
  const client = new LinuxServer('linux-server', 'appclient', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(dbhost.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.setHostname('appclient');
  dbhost.setHostname('dbhost');

  SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell.dispose();
  SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell.dispose();

  const existing = client.readFileForEditor(TNSNAMES_PATH) ?? '';
  client.writeFileFromEditor(TNSNAMES_PATH, existing + `
ORCLDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = 10.0.0.2)(PORT = 1521))
    (CONNECT_DATA = (SERVICE_NAME = ORCL))
  )
`);
  return { client, dbhost };
}

function admin(dbhost: LinuxServer) {
  return SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']);
}

function query(dbhost: LinuxServer, sql: string): string {
  const a = admin(dbhost);
  const out = a.subShell.processLine(sql).output.join('\n');
  a.subShell.dispose();
  return out;
}

/** Build a real DeadConnectionMonitor wired to the actual OracleDatabase + network reachability. */
function makeMonitor(dbhost: LinuxServer) {
  const db = getOracleDatabase(dbhost.getId());
  return new DeadConnectionMonitor({
    readSqlnetOra: () => dbhost.readFileForEditor(SQLNET_ORA_PATH),
    listSessions: (): DcdSessionRef[] =>
      db.securityEngine.sessions.getAllSessions().map(s => ({
        sid: s.sid, clientIp: s.clientIp, type: s.type,
      })),
    isReachable: async (clientIp: string) => {
      const out = await dbhost.executeCommand(`ping -c 1 -W 1 ${clientIp}`);
      return /1 received/.test(out);
    },
    onDeadSession: (sid) => { db.terminateDeadSession(sid); },
  });
}

describe('Scénario 10 — Cohérence transactionnelle face à une coupure réseau mid-transaction', () => {
  it('sqlnet.ora expose bien SQLNET.EXPIRE_TIME côté serveur (DCD configuré)', () => {
    const { dbhost } = lan();
    const monitor = makeMonitor(dbhost);
    expect(monitor.enabled).toBe(true);
    expect(monitor.expireTimeMinutes()).toBeGreaterThan(0);
    expect(monitor.expireIntervalMs()).toBe(monitor.expireTimeMinutes() * 60_000);
  });

  it('une transaction distante ouverte (INSERT/UPDATE sans COMMIT) est invisible aux autres sessions avant coupure', async () => {
    const { client, dbhost } = lan();
    query(dbhost, "CREATE TABLE system.orders (id NUMBER, status VARCHAR2(10));");
    query(dbhost, "INSERT INTO system.orders VALUES (1, 'NEW');");
    query(dbhost, 'COMMIT;');

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine("INSERT INTO system.orders VALUES (2, 'NEW');");
    r.subShell.processLine("UPDATE system.orders SET status = 'SHIPPED' WHERE id = 1;");

    const seenByAdmin = query(dbhost, 'SELECT id, status FROM system.orders ORDER BY id;');
    expect(seenByAdmin).toContain('1');
    expect(seenByAdmin).toContain('NEW');
    expect(seenByAdmin).not.toContain('SHIPPED');
    expect(seenByAdmin).not.toContain('2');

    // Network is cut before any COMMIT/ROLLBACK — no clean dispose() here.
    await client.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    await monitor.check();
  });

  it("après coupure réseau, le sweep DCD détecte la session morte et l'élimine", async () => {
    const { client, dbhost } = lan();
    query(dbhost, "CREATE TABLE system.orders (id NUMBER, status VARCHAR2(10));");
    query(dbhost, "INSERT INTO system.orders VALUES (1, 'NEW');");
    query(dbhost, 'COMMIT;');

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine("UPDATE system.orders SET status = 'SHIPPED' WHERE id = 1;");

    const before = query(dbhost, "SELECT username FROM v$session WHERE username = 'SYSTEM';");
    expect(before).toContain('SYSTEM');

    await client.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    const killed = await monitor.check();
    expect(killed.length).toBe(1);

    const after = query(dbhost, "SELECT username FROM v$session WHERE username = 'SYSTEM';");
    expect(after).not.toContain('SYSTEM');
  });

  it("le rollback automatique restaure les données à leur dernier état committé (aucune donnée partielle)", async () => {
    const { client, dbhost } = lan();
    query(dbhost, "CREATE TABLE system.orders (id NUMBER, status VARCHAR2(10));");
    query(dbhost, "INSERT INTO system.orders VALUES (1, 'NEW');");
    query(dbhost, 'COMMIT;');

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine("INSERT INTO system.orders VALUES (2, 'NEW');");
    r.subShell.processLine("UPDATE system.orders SET status = 'SHIPPED' WHERE id = 1;");

    await client.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    await monitor.check();

    const rows = query(dbhost, 'SELECT id, status FROM system.orders ORDER BY id;');
    expect(rows).toContain('NEW');
    expect(rows).not.toContain('SHIPPED');
    expect(rows).not.toMatch(/\b2\b/);
  });

  it("v\\$transaction n'a plus d'entrée active pour la session morte après le sweep", async () => {
    const { client, dbhost } = lan();
    query(dbhost, "CREATE TABLE system.orders (id NUMBER, status VARCHAR2(10));");
    query(dbhost, "INSERT INTO system.orders VALUES (1, 'NEW');");
    query(dbhost, 'COMMIT;');

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine("UPDATE system.orders SET status = 'SHIPPED' WHERE id = 1;");

    const activeBefore = query(dbhost, 'SELECT status FROM v$transaction;');
    expect(activeBefore).toContain('ACTIVE');

    await client.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    await monitor.check();

    const activeAfter = query(dbhost, 'SELECT status FROM v$transaction;');
    expect(activeAfter).not.toContain('ACTIVE');
  });

  it("aucun verrou résiduel dans v\\$lock après nettoyage de la session morte", async () => {
    const { client, dbhost } = lan();
    query(dbhost, "CREATE TABLE system.orders (id NUMBER, status VARCHAR2(10));");
    query(dbhost, "INSERT INTO system.orders VALUES (1, 'NEW');");
    query(dbhost, 'COMMIT;');

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine("UPDATE system.orders SET status = 'SHIPPED' WHERE id = 1;");

    const lockedBefore = query(dbhost, 'SELECT sid, type FROM v$lock;');
    expect(lockedBefore.trim().length).toBeGreaterThan(0);

    await client.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    await monitor.check();

    const lockedAfter = query(dbhost, 'SELECT sid, type FROM v$lock;');
    expect(lockedAfter).toMatch(/no rows selected/i);

    const blockers = query(dbhost, 'SELECT * FROM dba_blockers;');
    expect(blockers).toMatch(/no rows selected/i);
  });

  it("l'alert log documente le rollback automatique déclenché par la DCD", async () => {
    const { client, dbhost } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine("CREATE TABLE probe (v NUMBER);");
    r.subShell.processLine('INSERT INTO probe VALUES (1);');

    await client.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    await monitor.check();

    const db = getOracleDatabase(dbhost.getId());
    const alert = db.instance.getAlertLog().join('\n');
    expect(alert).toMatch(/Dead connection detected \(DCD\)/);
    expect(alert).toMatch(/automatically rolled back/);
  });

  it('une session locale (bequeath) sans transaction distante ne peut jamais être ciblée par la DCD', async () => {
    const { dbhost } = lan();
    query(dbhost, "CREATE TABLE probe2 (v NUMBER);");
    const admin1 = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']);
    admin1.subShell.processLine('INSERT INTO probe2 VALUES (1);');

    const monitor = makeMonitor(dbhost);
    const killed = await monitor.check();
    expect(killed.length).toBe(0);

    const rows = admin1.subShell.processLine('SELECT v FROM probe2;').output.join('\n');
    expect(rows).toContain('1');
    admin1.subShell.dispose();
  });

  it('une session distante toujours joignable (réseau intact) survit au sweep DCD', async () => {
    const { client, dbhost } = lan();
    query(dbhost, "CREATE TABLE system.orders (id NUMBER, status VARCHAR2(10));");
    query(dbhost, "INSERT INTO system.orders VALUES (1, 'NEW');");
    query(dbhost, 'COMMIT;');

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine("UPDATE system.orders SET status = 'SHIPPED' WHERE id = 1;");

    const monitor = makeMonitor(dbhost);
    const killed = await monitor.check();
    expect(killed.length).toBe(0);

    const stillThere = query(dbhost, "SELECT username FROM v$session WHERE username = 'SYSTEM';");
    expect(stillThere).toContain('SYSTEM');
    r.subShell.dispose();
  });

  it('la topologie publie oracle.session.dead-connection avec rolledBack=true pour la session tuée', async () => {
    const { client, dbhost } = lan();
    const db = getOracleDatabase(dbhost.getId());
    const events: Array<{ sid: number; rolledBack: boolean }> = [];
    db.instance.getBus().subscribe('oracle.session.dead-connection', (e) => {
      events.push({ sid: e.payload.sid, rolledBack: e.payload.rolledBack });
    });

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.processLine('CREATE TABLE probe3 (v NUMBER);');
    r.subShell.processLine('INSERT INTO probe3 VALUES (1);');

    await client.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    await monitor.check();

    expect(events.length).toBe(1);
    expect(events[0].rolledBack).toBe(true);
  });

  it("désactiver l'interface DB host au lieu du client ne casse pas la session locale de l'admin", async () => {
    const { dbhost } = lan();
    query(dbhost, "CREATE TABLE probe4 (v NUMBER);");
    const admin1 = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']);
    admin1.subShell.processLine('INSERT INTO probe4 VALUES (7);');

    await dbhost.executeCommand('sudo ip link set eth0 down');
    const monitor = makeMonitor(dbhost);
    const killed = await monitor.check();
    expect(killed.length).toBe(0);

    admin1.subShell.dispose();
  });
});
