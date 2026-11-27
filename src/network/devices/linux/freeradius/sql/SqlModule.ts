import { IPAddress } from '@/network/core/types';
import { confBoolean, type ConfPair, type ConfSection } from '../FreeradiusConf';
import type { ExternalExpansion } from '../Xlat';
import type { UsersEntry, UsersOperator, UsersPair } from '../UsersFileParser';
import type { SqlConnector, SqlSession } from './SqlPort';

export interface SqlModuleConfig {
  readonly name: string;
  readonly driver: string;
  readonly dialect: string;
  readonly connectString: string;
  readonly login: string;
  readonly password: string;
  readonly safeCharacters: string;
  readonly accountingQueries: ReadonlyMap<string, readonly string[]>;
  readonly postAuthQueries: readonly string[];
  readonly readClients: boolean;
  readonly readProfiles: boolean;
  readonly defaultProfile: string;
  readonly pool: PoolSettings;
  readonly userName: string;
  readonly readGroups: boolean;
  readonly queries: ReadonlyMap<string, string>;
}

export interface PoolSettings {
  readonly start: number;
  readonly min: number;
  readonly max: number;
  readonly spare: number;
  readonly uses: number;
  readonly retryDelaySeconds: number;
  readonly lifetimeSeconds: number;
  readonly idleTimeoutSeconds: number;
  readonly cleanupIntervalSeconds: number;
}

const DEFAULT_POOL: PoolSettings = { start: 5, min: 3, max: 32, spare: 10, uses: 0, retryDelaySeconds: 30, lifetimeSeconds: 0, idleTimeoutSeconds: 60, cleanupIntervalSeconds: 30 };
const POOL_KEYS: Readonly<Record<string, keyof PoolSettings>> = {
  start: 'start', min: 'min', max: 'max', spare: 'spare', uses: 'uses', retry_delay: 'retryDelaySeconds', lifetime: 'lifetimeSeconds', idle_timeout: 'idleTimeoutSeconds', cleanup_interval: 'cleanupIntervalSeconds', cleanup_delay: 'cleanupIntervalSeconds',
};
const LEGACY_POOL_KEYS: Readonly<Record<string, keyof PoolSettings>> = { connect_failure_retry_delay: 'retryDelaySeconds', lifetime: 'lifetimeSeconds', max_queries: 'uses' };

function integerOf(pair: ConfPair): number | { error: string } {
  if (!/^\d+$/.test(pair.value)) return { error: `${pair.file}[${pair.line}]: Invalid value "${pair.value}" for ${pair.name}: an unsigned integer is expected` };
  return Number(pair.value);
}

function readPool(section: ConfSection): PoolSettings | { error: string } {
  const values: Record<string, number> = { ...DEFAULT_POOL };
  for (const pair of section.pairs) {
    const legacy = LEGACY_POOL_KEYS[pair.name];
    const key = pair.name === 'num_sql_socks' ? 'size' : legacy;
    if (key === undefined) continue;
    const value = integerOf(pair);
    if (typeof value !== 'number') return value;
    if (key === 'size') { values.start = value; values.min = value; values.max = value; } else values[key] = value;
  }
  const pool = section.sections.find((candidate) => candidate.name1 === 'pool');
  for (const pair of pool?.pairs ?? []) {
    const key = POOL_KEYS[pair.name];
    if (key === undefined) return { error: `${pair.file}[${pair.line}]: Unknown sql pool setting "${pair.name}"` };
    const value = integerOf(pair);
    if (typeof value !== 'number') return value;
    values[key] = value;
  }
  if (values.max < 1) return { error: `${pool?.file ?? section.file}[${pool?.line ?? section.line}]: pool: max must be at least 1` };
  if (values.min > values.max) return { error: `${pool?.file ?? section.file}[${pool?.line ?? section.line}]: pool: min (${values.min}) must not exceed max (${values.max})` };
  values.start = Math.min(values.start, values.max);
  values.spare = Math.min(values.spare, values.max - values.min);
  if (values.idleTimeoutSeconds > 0) values.cleanupIntervalSeconds = Math.min(values.cleanupIntervalSeconds, values.idleTimeoutSeconds);
  return values as unknown as PoolSettings;
}

const AUTHORIZE_QUERIES = ['client_query', 'simul_count_query', 'simul_verify_query', 'authorize_check_query', 'authorize_reply_query', 'authorize_group_check_query', 'authorize_group_reply_query', 'group_membership_query'];
const OPERATORS = new Set<string>(['=', ':=', '+=', '-=', '==', '!=', '<', '>', '<=', '>=', '=~', '!~', '=*', '!*']);

const SAFE_CHARACTERS = '@abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_: /';
const SUPPORTED_DRIVER = 'rlm_sql_oracle';
const STORED_KEYS = new Set([
  'server', 'port', 'acct_table1', 'acct_table2', 'postauth_table', 'authcheck_table', 'groupcheck_table', 'authreply_table', 'groupreply_table',
  'usergroup_table', 'read_groups', 'read_profiles', 'read_clients', 'delete_stale_sessions', 'sql_user_name', 'group_attribute', 'client_table',
  'logfile', 'query_timeout', 'num_sql_socks', 'connect_failure_retry_delay', 'lifetime', 'max_queries', 'default_user_profile', 'nas_query', 'authorize_check_query',
]);
const QUERY_SUFFIX = /_query$/;

function accountingQueriesOf(section: ConfSection): ReadonlyMap<string, readonly string[]> {
  const types = section.sections.find((candidate) => candidate.name1 === 'accounting')?.sections.find((candidate) => candidate.name1 === 'type');
  const queries = new Map<string, readonly string[]>();
  for (const kind of types?.sections ?? []) queries.set(kind.name1.toLowerCase(), kind.pairs.filter((pair) => pair.name === 'query').map((pair) => pair.value));
  return queries;
}

export function readSqlModuleConfig(section: ConfSection): SqlModuleConfig | { error: string } {
  const name = section.name2 ?? section.name1;
  const config = { name, driver: '', dialect: '', connectString: 'radius', login: '', password: '', safeCharacters: SAFE_CHARACTERS, accountingQueries: accountingQueriesOf(section), readClients: false, readProfiles: true, defaultProfile: '', postAuthQueries: section.sections.find((candidate) => candidate.name1 === 'post-auth')?.pairs.filter((pair) => pair.name === 'query').map((pair) => pair.value) ?? [], pool: DEFAULT_POOL, userName: '%{User-Name}', readGroups: true, queries: new Map<string, string>() };
  for (const pair of section.pairs) {
    const where = `${pair.file}[${pair.line}]`;
    if (pair.name === 'driver') config.driver = pair.value;
    else if (pair.name === 'dialect') config.dialect = pair.value;
    else if (pair.name === 'radius_db') config.connectString = pair.value;
    else if (pair.name === 'login') config.login = pair.value;
    else if (pair.name === 'password') config.password = pair.value;
    else if (pair.name === 'safe_characters' || pair.name === 'safe-characters') config.safeCharacters = pair.value;
    else if (pair.name === 'sql_user_name') config.userName = pair.value;
    else if (pair.name === 'read_groups') {
      const flag = confBoolean(pair);
      if (typeof flag !== 'boolean') return flag;
      config.readGroups = flag;
    } else if (pair.name === 'read_profiles') {
      const flag = confBoolean(pair);
      if (typeof flag !== 'boolean') return flag;
      (config as { readProfiles: boolean }).readProfiles = flag;
    } else if (pair.name === 'default_user_profile') {
      (config as { defaultProfile: string }).defaultProfile = pair.value;
    } else if (pair.name === 'read_clients') {
      const flag = confBoolean(pair);
      if (typeof flag !== 'boolean') return flag;
      (config as { readClients: boolean }).readClients = flag;
    } else if (AUTHORIZE_QUERIES.includes(pair.name)) (config.queries as Map<string, string>).set(pair.name, pair.value);
    else if (STORED_KEYS.has(pair.name) || QUERY_SUFFIX.test(pair.name)) continue;
    else return { error: `${where}: Unknown sql setting "${pair.name}"` };
  }
  const pool = readPool(section);
  if ('error' in pool) return pool;
  (config as { pool: PoolSettings }).pool = pool;
  if (config.readClients && !config.queries.has('client_query')) return { error: `${section.file}[${section.line}]: rlm_sql (${name}): read_clients is set but no client_query is configured` };
  if (config.driver === '') return { error: `${section.file}[${section.line}]: sql: Failed to find configuration item "driver"` };
  if (config.driver !== SUPPORTED_DRIVER) return { error: `${section.file}[${section.line}]: The sql driver "${config.driver}" is not implemented in this simulator (only ${SUPPORTED_DRIVER}, over Oracle Net to the simulator's Oracle instance)` };
  return config;
}

export function escapeSqlValue(value: string, safeCharacters: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code > 127) { out += char; continue; }
    if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 32 || !safeCharacters.includes(char)) out += `=${code.toString(16).toUpperCase().padStart(2, '0')}`;
    else out += char;
  }
  return out;
}

const MODIFYING = /^\s*(insert|update|delete)/i;

interface PooledSession {
  readonly session: SqlSession;
  readonly openedAt: number;
  lastUsed: number;
  uses: number;
}

export class SqlModuleInstance {
  private pool: PooledSession[] = [];
  private retryNotBefore = 0;
  private openFailure: string | undefined;
  private lastChecked = -1;
  private lastOpened = 0;
  private delayInterval = 0;
  private nextDelay = 0;

  constructor(readonly config: SqlModuleConfig, private readonly connector: () => SqlConnector | null, private readonly log: (message: string) => void, private readonly now: () => number = () => 0) {}

  escape(value: string): string { return escapeSqlValue(value, this.config.safeCharacters); }

  start(): void {
    for (let index = 0; index < this.config.pool.start; index++) if (this.connectOne() === null) break;
  }

  startFailure(): string | undefined {
    return this.config.pool.start > 0 && this.pool.length === 0 ? this.openFailure : undefined;
  }

  openConnections(): number { return this.pool.length; }

  private connectOne(): PooledSession | null {
    const t = this.now();
    if (t < this.retryNotBefore) {
      this.log(`rlm_sql (${this.config.name}): Last connection attempt failed, waiting ${this.config.pool.retryDelaySeconds} seconds before retrying`);
      return null;
    }
    const connect = this.connector();
    if (connect === null) return null;
    const opened = connect({ connectString: this.config.connectString, login: this.config.login, password: this.config.password });
    if ('error' in opened) {
      this.log(`rlm_sql (${this.config.name}): Opening connection failed: ${opened.error}`);
      this.openFailure = opened.error;
      this.retryNotBefore = t + this.config.pool.retryDelaySeconds * 1000;
      return null;
    }
    const entry: PooledSession = { session: opened, openedAt: t, lastUsed: t, uses: 0 };
    this.pool.push(entry);
    this.lastOpened = Math.floor(t / 1000);
    this.delayInterval = this.config.pool.cleanupIntervalSeconds;
    this.nextDelay = this.config.pool.cleanupIntervalSeconds;
    return entry;
  }

  private manageSpares(t: number): void {
    const second = Math.floor(t / 1000);
    if (second === this.lastChecked) return;
    this.lastChecked = second;
    const { min, max, spare } = this.config.pool;
    const count = this.pool.length;
    const closeOne = (): void => {
      if (second < this.lastOpened + this.delayInterval) return;
      const victim = [...this.pool].sort((first, other) => first.lastUsed - other.lastUsed)[0];
      if (victim === undefined) return;
      this.discard(victim);
      this.nextDelay = Math.max(this.nextDelay >> 1, 1);
      this.delayInterval += this.nextDelay;
    };
    if (count < min) this.connectOne();
    else if (count > max) closeOne();
    else if (count > spare) {
      if (count > min) closeOne();
    } else if (count < spare && count < max) this.connectOne();
  }

  private discard(entry: PooledSession): void {
    entry.session.close();
    this.pool = this.pool.filter((candidate) => candidate !== entry);
  }

  private reap(t: number): void {
    const { uses, lifetimeSeconds, idleTimeoutSeconds, min } = this.config.pool;
    for (const entry of [...this.pool]) {
      if ((uses > 0 && entry.uses >= uses) || (lifetimeSeconds > 0 && t - entry.openedAt >= lifetimeSeconds * 1000)) this.discard(entry);
    }
    if (idleTimeoutSeconds === 0) return;
    for (const entry of [...this.pool].sort((first, second) => first.lastUsed - second.lastUsed)) {
      if (this.pool.length <= min) break;
      if (t - entry.lastUsed >= idleTimeoutSeconds * 1000) this.discard(entry);
    }
  }

  private open(): SqlSession | null {
    const t = this.now();
    this.reap(t);
    const entry = [...this.pool].sort((first, second) => second.lastUsed - first.lastUsed)[0] ?? this.connectOne();
    if (entry === undefined || entry === null) return null;
    entry.lastUsed = t;
    return entry.session;
  }

  private execute(session: SqlSession, query: string): ReturnType<SqlSession['execute']> {
    const entry = this.pool.find((candidate) => candidate.session === session);
    if (entry !== undefined) entry.uses += 1;
    const answer = session.execute(query);
    if (!('error' in answer) && MODIFYING.test(query)) session.execute('COMMIT');
    this.manageSpares(this.now());
    return answer;
  }

  expansion(): ExternalExpansion {
    return { escape: (value) => this.escape(value), call: (query) => this.call(query) };
  }

  call(query: string): string | undefined {
    const session = this.open();
    if (session === null) return undefined;
    const answer = this.execute(session, query);
    if ('error' in answer) {
      this.log(`rlm_sql (${this.config.name}): SQL query failed: ${answer.error}`);
      return undefined;
    }
    if (MODIFYING.test(query)) return answer.affected < 1 ? undefined : String(answer.affected);
    const first = answer.rows[0]?.[0];
    return first === null || first === undefined ? undefined : first;
  }

  private rows(query: string | undefined, expand: (template: string) => string, session: SqlSession): string[][] | 'fail' {
    if (query === undefined) return [];
    const answer = this.execute(session, expand(query));
    if ('error' in answer) {
      this.log(`rlm_sql (${this.config.name}): SQL query failed: ${answer.error}`);
      return 'fail';
    }
    return answer.rows.map((row) => row.map((cell) => cell ?? ''));
  }

  private pairsOf(rows: readonly string[][]): UsersPair[] | 'fail' {
    const pairs: UsersPair[] = [];
    for (const row of rows) {
      const op = row[4] ?? '=';
      if (!OPERATORS.has(op)) {
        this.log(`rlm_sql (${this.config.name}): Invalid operator "${op}" for attribute ${row[2]}`);
        return 'fail';
      }
      pairs.push({ name: row[2] ?? '', op: op as UsersOperator, value: row[3] ?? '', tag: null });
    }
    return pairs;
  }

  authorize(userName: string, expand: (template: string) => string, expandGroup: (template: string, group: string) => string, profileHint: () => string | undefined = () => undefined): UsersEntry[] | 'fail' {
    const session = this.open();
    if (session === null) return 'fail';
    const entries: UsersEntry[] = [];
    const check = this.rows(this.config.queries.get('authorize_check_query'), expand, session);
    const reply = this.rows(this.config.queries.get('authorize_reply_query'), expand, session);
    if (check === 'fail' || reply === 'fail') return 'fail';
    const userCheck = this.pairsOf(check);
    const userReply = this.pairsOf(reply);
    if (userCheck === 'fail' || userReply === 'fail') return 'fail';
    if (userCheck.length > 0 || userReply.length > 0) entries.push({ name: userName, check: userCheck, reply: userReply, line: 0 });
    const fallsThrough = [...userCheck, ...userReply].some((pair) => pair.name.toLowerCase() === 'fall-through' && pair.value.toLowerCase() === 'yes');
    if (entries.length > 0 && !fallsThrough) return entries;
    const groups: string[] = [];
    if (this.config.readGroups) {
      const membership = this.rows(this.config.queries.get('group_membership_query'), expand, session);
      if (membership === 'fail') return 'fail';
      groups.push(...membership.map(([group]) => group));
    }
    if (this.config.readProfiles) {
      const named = userCheck.find((pair) => pair.name.toLowerCase() === 'user-profile')?.value ?? profileHint() ?? this.config.defaultProfile;
      if (named !== '') groups.push(named);
    }
    for (const group of groups) {
      const groupCheck = this.rows(this.config.queries.get('authorize_group_check_query'), (template) => expandGroup(template, group), session);
      const groupReply = this.rows(this.config.queries.get('authorize_group_reply_query'), (template) => expandGroup(template, group), session);
      if (groupCheck === 'fail' || groupReply === 'fail') return 'fail';
      const checkPairs = this.pairsOf(groupCheck);
      const replyPairs = this.pairsOf(groupReply);
      if (checkPairs === 'fail' || replyPairs === 'fail') return 'fail';
      if (checkPairs.length > 0 || replyPairs.length > 0) entries.push({ name: userName, check: checkPairs, reply: replyPairs, line: 0 });
    }
    return entries;
  }

  private runQueries(queries: readonly string[], expand: (template: string) => string): 'ok' | 'noop' | 'fail' {
    if (queries.length === 0) return 'noop';
    const session = this.open();
    if (session === null) return 'fail';
    for (const template of queries) {
      const answer = this.execute(session, expand(template));
      if ('error' in answer) {
        this.log(`rlm_sql (${this.config.name}): SQL query failed: ${answer.error}`);
        return 'fail';
      }
      if (answer.affected > 0) return 'ok';
    }
    return 'noop';
  }

  accounting(statusType: string, expand: (template: string) => string): 'ok' | 'noop' | 'fail' {
    return this.runQueries(this.config.accountingQueries.get(statusType.toLowerCase()) ?? [], expand);
  }

  simultaneousCount(expand: (template: string) => string, maximum = Number.POSITIVE_INFINITY, nasTypeOf: (address: string) => string | undefined = () => undefined, request: { framedIp?: string; callingStation?: string } = {}): { count: number; mpp: boolean } | 'noop' | 'fail' {
    const query = this.config.queries.get('simul_count_query');
    if (query === undefined) return 'noop';
    const session = this.open();
    if (session === null) return 'fail';
    const rows = this.rows(query, expand, session);
    if (rows === 'fail') return 'fail';
    const count = Number(rows[0]?.[0] ?? '');
    if (!Number.isInteger(count) || count < 0) return 'fail';
    const verify = this.config.queries.get('simul_verify_query');
    if (count < maximum || verify === undefined) return { count, mpp: false };
    const sessions = this.rows(verify, expand, session);
    if (sessions === 'fail') return 'fail';
    let logged = 0;
    let mpp = false;
    for (const row of sessions) {
      if (row.length < 8) {
        this.log(`rlm_sql (${this.config.name}): SELECT returned too few fields.  Please do not edit 'simul_verify_query'`);
        return 'fail';
      }
      if ((row[2] ?? '') === '' || (row[1] ?? '') === '') return 'fail';
      const address = row[3] ?? '';
      if (address !== '' && IPAddress.tryParse(address) === null) return 'fail';
      const type = nasTypeOf(address);
      if (type === undefined || type === '' || type === 'other') {
        logged++;
        const sameAddress = (row[5] ?? '') !== '' && request.framedIp !== undefined && row[5] === request.framedIp;
        const sameCaller = (row[6] ?? '') !== '' && request.callingStation !== undefined && row[6].slice(0, 16) === request.callingStation.slice(0, 16);
        if (sameAddress || sameCaller) mpp = true;
        continue;
      }
      this.log(`rlm_sql (${this.config.name}): Failed to check the terminal server for user '${row[2]}'.`);
      return 'fail';
    }
    return { count: logged, mpp };
  }

  clientSections(): ConfSection[] | 'fail' {
    const query = this.config.queries.get('client_query');
    if (!this.config.readClients || query === undefined) return [];
    const session = this.open();
    if (session === null) return 'fail';
    const rows = this.rows(query, (template) => template, session);
    if (rows === 'fail') return 'fail';
    return rows.map((row) => {
      const pairs: ConfPair[] = [
        ['ipaddr', row[1]], ['shortname', row[2]], ['nas_type', row[3] === '' ? 'other' : row[3]], ['secret', row[4]],
        ...((row[5] ?? '') === '' ? [] : [['virtual_server', row[5]]]),
      ].map(([name, value]) => ({ name, op: '=', value: value ?? '', quoted: true, file: `rlm_sql (${this.config.name})`, line: 0 }));
      return { name1: 'client', name2: row[2] ?? row[1] ?? '', pairs, sections: [], items: pairs, file: `rlm_sql (${this.config.name})`, line: 0 };
    });
  }

  mapRow(query: string): ReadonlyMap<string, string> | 'fail' | null {
    const session = this.open();
    if (session === null) return 'fail';
    const answer = this.execute(session, query);
    if ('error' in answer) {
      this.log(`rlm_sql (${this.config.name}): SQL query failed: ${answer.error}`);
      return 'fail';
    }
    const first = answer.rows[0];
    if (first === undefined) return null;
    return new Map((answer.columns ?? []).map((column, index) => [column.toLowerCase(), first[index] ?? ''] as const));
  }

  postAuth(expand: (template: string) => string): 'ok' | 'noop' | 'fail' {
    return this.runQueries(this.config.postAuthQueries, expand);
  }

  close(): void {
    for (const entry of this.pool) entry.session.close();
    this.pool = [];
  }
}
