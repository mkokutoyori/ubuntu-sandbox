/*
 * Probe: rlm_sql, connection pool. The pool settings were accepted and ignored (num_sql_socks, lifetime, max_queries, connect_failure_retry_delay) and the 3.2 `pool { }`
 * subsection was not read at all: one session was opened on the first query and kept for ever. Source of truth: FreeRADIUS v3.2.x raddb/mods-available/sql (pool { start min
 * max spare uses retry_delay lifetime idle_timeout }, defaults 5 3 32 10 0 30 0 60) and src/lib/server/connection.c (start connections are opened when the module is
 * instantiated; a connection is closed once it has served `uses` requests or lived `lifetime` seconds; after a failed attempt no new one is made for `retry_delay` seconds;
 * idle connections above `min` are closed after `idle_timeout` seconds; never more than `max`), raddb/mods-available/sql of 3.0 (num_sql_socks a fixed size, max_queries,
 * lifetime, connect_failure_retry_delay). `spare` is evaluated by the pool manager of connection.c fr_connection_pool_check, run when a connection is released, at most once a second: below `spare` one connection is opened, above it (and above min) one is closed, not before cleanup_interval seconds after the last opening, the delay growing after each closing. The clock and the connector are injected: the cases are exact, without waiting.
 *
 * Spare manager added later: 3 cases (the spare growth, the spare closing with its growing delay, cleanup_interval) fall on git stash; the lifetime and idle_timeout cases now set spare = 0 to isolate their own setting.
 *
 * Discriminated with git stash on src/network: 8 of 9 fall before the fix; the witness (a query answers through the module) passes either way.
 */
import { describe, it, expect } from 'vitest';
import { parseFreeradiusConf } from '@/network/devices/linux/freeradius/FreeradiusConf';
import { readSqlModuleConfig, SqlModuleInstance, type SqlModuleConfig } from '@/network/devices/linux/freeradius/sql/SqlModule';
import type { SqlConnector } from '@/network/devices/linux/freeradius/sql/SqlPort';

const BASE = ['  driver = "rlm_sql_oracle"', '  dialect = "oracle"', '  radius_db = "//10.0.0.2/ORCL"', '  login = "system"', '  password = "oracle"'];

function configOf(extra: string[] = [], pool: string[] | null = null): SqlModuleConfig | { error: string } {
  const lines = ['sql {', ...BASE, ...extra, ...(pool === null ? [] : ['  pool {', ...pool.map((line) => `    ${line}`), '  }']), '}', ''];
  const parsed = parseFreeradiusConf(lines.join('\n'), '/etc/freeradius/3.0/mods-enabled/sql');
  if (parsed.ok === false) throw new Error(parsed.error);
  return readSqlModuleConfig(parsed.root.sections[0]);
}

function rig(config: SqlModuleConfig, failing = false) {
  const state = { opened: 0, closed: 0, now: 0, failing, logs: [] as string[] };
  const connector: SqlConnector = () => {
    if (state.failing) return { error: 'ORA-12541: TNS:no listener' };
    state.opened += 1;
    return { execute: () => ({ rows: [['1']], affected: 0, isQuery: true }), close: () => { state.closed += 1; } };
  };
  const instance = new SqlModuleInstance(config, () => connector, (message) => state.logs.push(message), () => state.now);
  return { state, instance };
}

const ok = (value: SqlModuleConfig | { error: string }): SqlModuleConfig => {
  if ('error' in value) throw new Error(value.error);
  return value;
};

describe('rlm_sql: the connection pool', () => {
  it('witness: a query answers through the module', () => {
    const { instance } = rig(ok(configOf()));
    expect(instance.call('SELECT 1 FROM dual')).toBe('1');
  });

  it('reads the pool section, with the stock defaults for what it does not set', () => {
    const config = ok(configOf([], ['start = 2', 'max = 4']));
    expect(config.pool).toMatchObject({ start: 2, min: 3, max: 4, uses: 0, retryDelaySeconds: 30, lifetimeSeconds: 0, idleTimeoutSeconds: 60 });
  });

  it('refuses a pool setting it does not have, a value that is not a number and a minimum above the maximum', () => {
    expect(configOf([], ['frobnicate = 1'])).toEqual({ error: expect.stringContaining('Unknown sql pool setting "frobnicate"') });
    expect(configOf([], ['start = many'])).toEqual({ error: expect.stringContaining('an unsigned integer is expected') });
    expect(configOf([], ['min = 9', 'max = 4'])).toEqual({ error: expect.stringContaining('min (9) must not exceed max (4)') });
  });

  it('the 3.0 settings still count: num_sql_socks fixes the size, max_queries, lifetime and connect_failure_retry_delay map to the pool', () => {
    const config = ok(configOf(['  num_sql_socks = 3', '  max_queries = 7', '  lifetime = 120', '  connect_failure_retry_delay = 5']));
    expect(config.pool).toMatchObject({ start: 3, min: 3, max: 3, uses: 7, lifetimeSeconds: 120, retryDelaySeconds: 5 });
  });

  it('opens `start` connections when the module starts, and no more than `max`', () => {
    const first = rig(ok(configOf([], ['start = 3', 'min = 1'])));
    first.instance.start();
    expect(first.state.opened).toBe(3);
    const capped = rig(ok(configOf([], ['start = 9', 'min = 1', 'max = 2'])));
    capped.instance.start();
    expect(capped.state.opened).toBe(2);
  });

  it('closes a connection that served `uses` queries and opens another', () => {
    const { state, instance } = rig(ok(configOf([], ['start = 1', 'min = 1', 'uses = 2'])));
    instance.start();
    for (let index = 0; index < 5; index++) instance.call('SELECT 1 FROM dual');
    expect(state.opened).toBe(3);
    expect(state.closed).toBe(2);
  });

  it('closes a connection older than `lifetime` seconds', () => {
    const { state, instance } = rig(ok(configOf([], ['start = 1', 'min = 1', 'spare = 0', 'lifetime = 10'])));
    instance.start();
    instance.call('SELECT 1 FROM dual');
    state.now = 11_000;
    instance.call('SELECT 1 FROM dual');
    expect(state.opened).toBe(2);
    expect(state.closed).toBe(1);
  });

  it('closes idle connections above `min` after `idle_timeout` seconds', () => {
    const { state, instance } = rig(ok(configOf([], ['start = 3', 'min = 1', 'spare = 0', 'idle_timeout = 30'])));
    instance.start();
    state.now = 31_000;
    instance.call('SELECT 1 FROM dual');
    expect(instance.openConnections()).toBe(1);
    expect(state.closed).toBe(2);
  });

  it('after a failed attempt, makes no new one for `retry_delay` seconds, then tries again', () => {
    const { state, instance } = rig(ok(configOf([], ['start = 0', 'min = 0', 'retry_delay = 10'])), true);
    expect(instance.call('SELECT 1 FROM dual')).toBeUndefined();
    state.failing = false;
    expect(instance.call('SELECT 1 FROM dual')).toBeUndefined();
    expect(state.logs.some((line) => line.includes('waiting 10 seconds before retrying'))).toBe(true);
    state.now = 10_001;
    expect(instance.call('SELECT 1 FROM dual')).toBe('1');
  });

  it('keeps `spare` connections: below it, one more is opened per second of use, up to max', () => {
    const { state, instance } = rig(ok(configOf([], ['start = 1', 'min = 1', 'max = 8', 'spare = 4'])));
    instance.start();
    for (const at of [0, 0, 1_000, 2_000, 3_000, 4_000]) {
      state.now = at;
      instance.call('SELECT 1 FROM dual');
    }
    expect(instance.openConnections()).toBe(4);
  });

  it('above `spare`, closes one connection at a time, not before cleanup_interval after the last opening and with a growing delay, never under min', () => {
    const { state, instance } = rig(ok(configOf([], ['start = 5', 'min = 3', 'max = 8', 'spare = 3', 'idle_timeout = 0'])));
    instance.start();
    state.now = 29_000;
    instance.call('SELECT 1 FROM dual');
    expect(instance.openConnections()).toBe(5);
    state.now = 31_000;
    instance.call('SELECT 1 FROM dual');
    expect(instance.openConnections()).toBe(4);
    state.now = 40_000;
    instance.call('SELECT 1 FROM dual');
    expect(instance.openConnections()).toBe(4);
    state.now = 46_000;
    instance.call('SELECT 1 FROM dual');
    expect(instance.openConnections()).toBe(3);
    state.now = 200_000;
    instance.call('SELECT 1 FROM dual');
    expect(instance.openConnections()).toBe(3);
  });

  it('cleanup_interval is a pool setting, bounded by idle_timeout', () => {
    expect(ok(configOf([], ['cleanup_interval = 10'])).pool.cleanupIntervalSeconds).toBe(10);
    expect(ok(configOf([], ['cleanup_interval = 500', 'idle_timeout = 40'])).pool.cleanupIntervalSeconds).toBe(40);
  });
});
