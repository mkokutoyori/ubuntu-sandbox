import { confBoolean, type ConfSection } from '../FreeradiusConf';
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
  readonly userName: string;
  readonly readGroups: boolean;
  readonly queries: ReadonlyMap<string, string>;
}

const AUTHORIZE_QUERIES = ['simul_count_query', 'authorize_check_query', 'authorize_reply_query', 'authorize_group_check_query', 'authorize_group_reply_query', 'group_membership_query'];
const OPERATORS = new Set<string>(['=', ':=', '+=', '-=', '==', '!=', '<', '>', '<=', '>=', '=~', '!~']);

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
  const config = { name, driver: '', dialect: '', connectString: 'radius', login: '', password: '', safeCharacters: SAFE_CHARACTERS, accountingQueries: accountingQueriesOf(section), postAuthQueries: section.sections.find((candidate) => candidate.name1 === 'post-auth')?.pairs.filter((pair) => pair.name === 'query').map((pair) => pair.value) ?? [], userName: '%{User-Name}', readGroups: true, queries: new Map<string, string>() };
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
    } else if (AUTHORIZE_QUERIES.includes(pair.name)) (config.queries as Map<string, string>).set(pair.name, pair.value);
    else if (STORED_KEYS.has(pair.name) || QUERY_SUFFIX.test(pair.name)) continue;
    else return { error: `${where}: Unknown sql setting "${pair.name}"` };
  }
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

export class SqlModuleInstance {
  private session: SqlSession | null = null;

  constructor(readonly config: SqlModuleConfig, private readonly connector: () => SqlConnector | null, private readonly log: (message: string) => void) {}

  escape(value: string): string { return escapeSqlValue(value, this.config.safeCharacters); }

  private open(): SqlSession | null {
    if (this.session !== null) return this.session;
    const connect = this.connector();
    if (connect === null) return null;
    const opened = connect({ connectString: this.config.connectString, login: this.config.login, password: this.config.password });
    if ('error' in opened) {
      this.log(`rlm_sql (${this.config.name}): Opening connection failed: ${opened.error}`);
      return null;
    }
    this.session = opened;
    return opened;
  }

  private execute(session: SqlSession, query: string): ReturnType<SqlSession['execute']> {
    const answer = session.execute(query);
    if (!('error' in answer) && MODIFYING.test(query)) session.execute('COMMIT');
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

  authorize(userName: string, expand: (template: string) => string, expandGroup: (template: string, group: string) => string): UsersEntry[] | 'fail' {
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
    if (!this.config.readGroups) return entries;
    const groups = this.rows(this.config.queries.get('group_membership_query'), expand, session);
    if (groups === 'fail') return 'fail';
    for (const [group] of groups) {
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

  simultaneousCount(expand: (template: string) => string): number | 'noop' | 'fail' {
    const query = this.config.queries.get('simul_count_query');
    if (query === undefined) return 'noop';
    const session = this.open();
    if (session === null) return 'fail';
    const rows = this.rows(query, expand, session);
    if (rows === 'fail') return 'fail';
    const count = Number(rows[0]?.[0] ?? '');
    return Number.isInteger(count) && count >= 0 ? count : 'fail';
  }

  postAuth(expand: (template: string) => string): 'ok' | 'noop' | 'fail' {
    return this.runQueries(this.config.postAuthQueries, expand);
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
