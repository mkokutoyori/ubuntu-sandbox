/**
 * Phase 7 — Oracle reactive emissions + OracleFilesystemSync adapter.
 *
 * Validates:
 *   1. OracleInstance publishes the documented `oracle.*` topics on its
 *      injected bus (state changes, parameter changes, alert log entries,
 *      background-process lifecycle, redo log switches, archive logs).
 *   2. The OracleFilesystemSync adapter, attached to the same bus,
 *      produces the same FS side-effects as the legacy
 *      `updateSpfileOnDevice` / `syncAlertLogToDevice` /
 *      `syncDatafilesToDevice` / `syncOracleProcessesToDevice` calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { OracleInstance } from '@/database/oracle/OracleInstance';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleFilesystemSync } from '@/adapters/OracleFilesystemSync';
import type { DomainEvent } from '@/events/types';

describe('Phase 7 — OracleInstance reactive emissions', () => {
  let bus: EventBus;
  let inst: OracleInstance;
  let trace: DomainEvent[];

  beforeEach(() => {
    bus = new EventBus();
    __setDefaultEventBus(bus);
    inst = new OracleInstance();
    inst.setEventBus(bus);
    inst.setDeviceId('server-A');
    trace = [];
    bus.subscribeAll((e) => trace.push(e));
  });

  afterEach(() => { __setDefaultEventBus(null); });

  it('startup emits state-changed transitions and background-process-started events', () => {
    inst.startup('OPEN');
    const states = trace
      .filter((e) => e.topic === 'oracle.instance.state-changed')
      .map((e) => (e.payload as { newState: string }).newState);
    expect(states).toEqual(['NOMOUNT', 'MOUNT', 'OPEN']);

    const procStarts = trace.filter((e) => e.topic === 'oracle.instance.background-process-started');
    expect(procStarts.length).toBeGreaterThanOrEqual(8); // PMON/SMON/DBW0/LGWR/CKPT/RECO/MMON/MMNL
  });

  it('logAlert publishes oracle.instance.alert-log-entry-added', () => {
    inst.startup('OPEN');
    const alerts = trace.filter((e) => e.topic === 'oracle.instance.alert-log-entry-added');
    // startup logs at least: 'Starting…', 'Database mounted', 'Database opened'
    expect(alerts.length).toBeGreaterThanOrEqual(3);
    const lines = alerts.map((a) => (a.payload as { line: string }).line);
    expect(lines.some((l) => l.includes('Database mounted'))).toBe(true);
    expect(lines.some((l) => l.includes('Database opened'))).toBe(true);
  });

  it('setParameter publishes parameter-changed with oldValue / newValue / scope', () => {
    inst.setParameter('sga_target', '1G', 'BOTH');
    const ev = trace.find((e) => e.topic === 'oracle.instance.parameter-changed');
    expect(ev).toBeDefined();
    const p = ev!.payload as { key: string; newValue: string; scope: string };
    expect(p.key).toBe('sga_target');
    expect(p.newValue).toBe('1G');
    expect(p.scope).toBe('BOTH');
  });

  it('switchLogfile publishes redo-log-switched and (in archivelog mode) archive-log.created', () => {
    inst.startup('MOUNT');
    inst.setArchiveLogMode(true);
    inst.startup('OPEN'); // not allowed twice; this exercises the error path but we still need OPEN to switch
    // Force open by going through startup chain
    // (The previous startup left us at MOUNT; we need OPEN. Use FORCE.)
    inst.startup('FORCE');

    trace.length = 0;
    inst.switchLogfile();
    const redo = trace.find((e) => e.topic === 'oracle.instance.redo-log-switched');
    expect(redo).toBeDefined();
    const archive = trace.find((e) => e.topic === 'oracle.archive-log.created');
    expect(archive).toBeDefined();
  });

  it('shutdown emits background-process-stopped for every running process and SHUTDOWN transition', () => {
    inst.startup('OPEN');
    trace.length = 0;
    inst.shutdown('NORMAL');
    const stops = trace.filter((e) => e.topic === 'oracle.instance.background-process-stopped');
    expect(stops.length).toBeGreaterThanOrEqual(8);
    const lastTransition = trace
      .filter((e) => e.topic === 'oracle.instance.state-changed')
      .pop() as DomainEvent & { topic: 'oracle.instance.state-changed' } | undefined;
    expect(lastTransition?.payload.newState).toBe('SHUTDOWN');
  });
});

// ─── OracleFilesystemSync adapter ────────────────────────────────────────

describe('Phase 7 — OracleFilesystemSync adapter', () => {
  let bus: EventBus;
  let inst: OracleInstance;
  let db: OracleDatabase;
  let fs: Map<string, string>;
  let processes: Array<{ pid: number; cmd: string }>;
  let sync: OracleFilesystemSync;

  const deviceId = 'srv-1';

  beforeEach(() => {
    bus = new EventBus();
    __setDefaultEventBus(bus);
    db = new OracleDatabase();
    inst = db.instance;
    inst.setEventBus(bus);
    inst.setDeviceId(deviceId);

    fs = new Map();
    processes = [];
    const fakeDevice = {
      writeFileFromEditor(path: string, content: string) { fs.set(path, content); },
      registerProcess(pid: number, _user: string, cmd: string) { processes.push({ pid, cmd }); },
      unregisterProcess(pid: number) {
        const idx = processes.findIndex(p => p.pid === pid);
        if (idx >= 0) processes.splice(idx, 1);
      },
      clearSystemProcesses() { processes.length = 0; },
    };

    sync = new OracleFilesystemSync(bus, {
      resolveDevice: () => fakeDevice as unknown as import('@/network/equipment/Equipment').Equipment,
      resolveDatabase: () => db,
    });
    sync.start();
  });

  afterEach(() => { sync.stop(); __setDefaultEventBus(null); });

  it('parameter-changed writes /u01/.../dbs/spfileORCL.ora with cumulative state', () => {
    inst.setParameter('sga_target', '1G', 'BOTH');
    inst.setParameter('processes', '500', 'SPFILE');

    const spfile = Array.from(fs.entries()).find(([p]) => p.endsWith('spfileORCL.ora'));
    expect(spfile).toBeDefined();
    expect(spfile![1]).toContain('*.sga_target=');
    expect(spfile![1]).toContain('*.processes=500');
  });

  it('MEMORY-only parameter-changed does NOT touch the spfile', () => {
    inst.setParameter('open_cursors', '600', 'MEMORY');
    const spfile = Array.from(fs.entries()).find(([p]) => p.endsWith('spfileORCL.ora'));
    expect(spfile).toBeUndefined();
  });

  it('alert-log entries flush the in-memory log to the trace path', () => {
    inst.startup('OPEN');
    const alertPath = Array.from(fs.keys()).find((p) => p.endsWith('/alert_ORCL.log'));
    expect(alertPath).toBeDefined();
    const content = fs.get(alertPath!)!;
    expect(content).toContain('Database opened');
  });

  it('state-changed → MOUNT materialises datafiles, redo logs and control files', () => {
    inst.startup('MOUNT');
    // Datafile path always lives under oradata/<SID>
    const datafilePath = Array.from(fs.keys()).find((p) => p.includes('/oradata/ORCL/') && p.endsWith('.dbf'));
    expect(datafilePath).toBeDefined();
    // Redo logs
    const redoPath = Array.from(fs.keys()).find((p) => p.endsWith('redo01.log'));
    expect(redoPath).toBeDefined();
    expect(fs.get(redoPath!)).toContain('REDO LOG');
  });

  it('background processes register on startup and unregister on shutdown', () => {
    inst.startup('OPEN');
    expect(processes.length).toBeGreaterThanOrEqual(8);
    expect(processes.some((p) => p.cmd.startsWith('ora_pmon_'))).toBe(true);

    inst.shutdown('NORMAL');
    expect(processes.length).toBe(0);
  });
});
