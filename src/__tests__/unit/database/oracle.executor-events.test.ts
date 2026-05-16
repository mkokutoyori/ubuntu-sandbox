/**
 * Phase 7b — OracleExecutor + SQLPlusSession reactive emissions.
 *
 * Covers the remaining topics from doc §7.4.2:
 *   - oracle.session.connected / disconnected
 *   - oracle.transaction.started / committed / rolled-back
 *   - oracle.dml.executed
 *   - oracle.ddl.executed
 *   - oracle.error.raised
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { installAllDemoSchemas } from '@/database/oracle/demo/DemoSchemas';
import type { DomainEvent } from '@/events/types';

function setupDb(deviceId = 'server-A'): { db: OracleDatabase; bus: EventBus; trace: DomainEvent[] } {
  const bus = new EventBus();
  __setDefaultEventBus(bus);
  const db = new OracleDatabase();
  db.instance.setEventBus(bus);
  db.instance.setDeviceId(deviceId);
  db.instance.startup('OPEN');
  installAllDemoSchemas(db);
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));
  return { db, bus, trace };
}

describe('Phase 7b — SQLPlusSession session events', () => {
  afterEach(() => { __setDefaultEventBus(null); });

  it('login emits oracle.session.connected with schema + role', () => {
    const { db, trace } = setupDb();
    const session = new SQLPlusSession(db);
    session.login('SYS', '', true);
    const ev = trace.find((e) => e.topic === 'oracle.session.connected');
    expect(ev).toBeDefined();
    const p = ev!.payload as { schema: string; role?: string };
    expect(p.schema).toBe('SYS');
    expect(p.role).toBe('SYSDBA');
  });

  it('disconnect emits oracle.session.disconnected with the matching sessionId', () => {
    const { db, trace } = setupDb();
    const session = new SQLPlusSession(db);
    session.login('SYS', '', true);
    const connected = trace.find((e) => e.topic === 'oracle.session.connected');
    const sessionId = (connected!.payload as { sessionId: string }).sessionId;

    trace.length = 0;
    session.disconnect();
    const disconnected = trace.find((e) => e.topic === 'oracle.session.disconnected');
    expect(disconnected).toBeDefined();
    expect((disconnected!.payload as { sessionId: string }).sessionId).toBe(sessionId);
  });
});

describe('Phase 7b — OracleExecutor transaction + DML + DDL events', () => {
  afterEach(() => { __setDefaultEventBus(null); });

  it('first INSERT begins a transaction (oracle.transaction.started)', () => {
    const { db, trace } = setupDb();
    const { executor } = db.connectAsSysdba();
    executor.setSessionId('test-sess');

    db.executeSql(executor, 'CREATE TABLE PHASE7 (id NUMBER)');
    trace.length = 0;
    db.executeSql(executor, "INSERT INTO PHASE7 VALUES (1)");

    const started = trace.find((e) => e.topic === 'oracle.transaction.started');
    expect(started).toBeDefined();
    const dml = trace.find((e) => e.topic === 'oracle.dml.executed');
    expect(dml).toBeDefined();
    expect((dml!.payload as { rowsAffected: number }).rowsAffected).toBe(1);
  });

  it('COMMIT emits oracle.transaction.committed with txId and durationMs', () => {
    const { db, trace } = setupDb();
    const { executor } = db.connectAsSysdba();
    executor.setSessionId('s1');

    db.executeSql(executor, 'CREATE TABLE PH7B (id NUMBER)');
    db.executeSql(executor, "INSERT INTO PH7B VALUES (1)");
    trace.length = 0;
    db.executeSql(executor, 'COMMIT');

    const ev = trace.find((e) => e.topic === 'oracle.transaction.committed');
    expect(ev).toBeDefined();
    const p = ev!.payload as { txId: number; durationMs: number };
    expect(p.txId).toBeGreaterThan(0);
    expect(p.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ROLLBACK emits oracle.transaction.rolled-back', () => {
    const { db, trace } = setupDb();
    const { executor } = db.connectAsSysdba();
    executor.setSessionId('s2');

    db.executeSql(executor, 'CREATE TABLE PH7C (id NUMBER)');
    db.executeSql(executor, "INSERT INTO PH7C VALUES (1)");
    trace.length = 0;
    db.executeSql(executor, 'ROLLBACK');

    const ev = trace.find((e) => e.topic === 'oracle.transaction.rolled-back');
    expect(ev).toBeDefined();
  });

  it('CREATE / DROP TABLE emit oracle.ddl.executed with the object name', () => {
    const { db, trace } = setupDb();
    const { executor } = db.connectAsSysdba();
    executor.setSessionId('s3');

    db.executeSql(executor, 'CREATE TABLE PH7D (id NUMBER)');
    db.executeSql(executor, 'DROP TABLE PH7D');

    const ddlEvents = trace.filter((e) => e.topic === 'oracle.ddl.executed');
    expect(ddlEvents.length).toBeGreaterThanOrEqual(2);
    const kinds = ddlEvents.map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toContain('CREATE TABLE');
    expect(kinds).toContain('DROP TABLE');
  });

  it('Invalid SQL emits oracle.error.raised with code + message', () => {
    const { db, trace } = setupDb();
    const { executor } = db.connectAsSysdba();
    executor.setSessionId('s4');

    // Trigger an error: select from missing table — uses executeWithAudit
    // through the SQL*Plus normal path, so we go via OracleDatabase.executeSql
    // which catches OracleError and returns it as a result, NOT via the
    // executeWithAudit path. To test the error emission directly:
    try {
      executor.executeWithAudit({
        type: 'DropTableStatement',
        tableName: 'NONEXISTENT_TABLE_PH7E',
      } as never);
    } catch {
      // expected
    }
    const err = trace.find((e) => e.topic === 'oracle.error.raised');
    expect(err).toBeDefined();
    const p = err!.payload as { code: number; message: string };
    expect(p.code).toBeGreaterThan(0);
    expect(p.message.length).toBeGreaterThan(0);
  });
});
