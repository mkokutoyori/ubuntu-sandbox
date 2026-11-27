/*
 * Probe: rlm_sql, connection pool. The pool settings were accepted and ignored (num_sql_socks, lifetime, max_queries, connect_failure_retry_delay) and the 3.2 `pool { }`
 * subsection was not read at all: one session was opened on the first query and kept for ever. Source of truth: FreeRADIUS v3.2.x raddb/mods-available/sql (pool { start min
 * max spare uses retry_delay lifetime idle_timeout }, defaults 5 3 32 10 0 30 0 60) and src/lib/server/connection.c (start connections are opened when the module is
 * instantiated; a connection is closed once it has served `uses` requests or lived `lifetime` seconds; after a failed attempt no new one is made for `retry_delay` seconds;
 * idle connections above `min` are closed after `idle_timeout` seconds; never more than `max`), raddb/mods-available/sql of 3.0 (num_sql_socks a fixed size, max_queries,
 * lifetime, connect_failure_retry_delay). `spare` is accepted and not evaluated: it only matters under concurrent requests, and a request here is served to completion
 * before the next, so the pool never has fewer idle connections than the one in use. The clock and the connector are injected: the cases are exact, without waiting.
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
    const { state, instance } = rig(ok(configOf([], ['start = 1', 'min = 1', 'lifetime = 10'])));
    instance.start();
    instance.call('SELECT 1 FROM dual');
    state.now = 11_000;
    instance.call('SELECT 1 FROM dual');
    expect(state.opened).toBe(2);
    expect(state.closed).toBe(1);
  });

  it('closes idle connections above `min` after `idle_timeout` seconds', () => {
    const { state, instance } = rig(ok(configOf([], ['start = 3', 'min = 1', 'idle_timeout = 30'])));
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
});
