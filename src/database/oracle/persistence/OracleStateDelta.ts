import { Logger } from '@/network/core/Logger';
import type { CatalogPrivilege, CatalogRole, CatalogUser } from '../../engine/catalog/BaseCatalog';
import type { TablespaceMeta } from '../OracleStorage';
import type { OracleDatabase } from '../OracleDatabase';
import { DataPumpEngine, type DataPumpDump } from '../datapump/DataPumpEngine';
import { MetadataExtractor, type MetadataObjectType } from '../metadata/MetadataExtractor';

export type SchemaObjectKind = Extract<MetadataObjectType,
  'VIEW' | 'SEQUENCE' | 'INDEX' | 'SYNONYM' | 'TRIGGER' | 'PROCEDURE' | 'FUNCTION' | 'PACKAGE' | 'PACKAGE_BODY'>;

export interface SchemaObjectRef {
  kind: SchemaObjectKind;
  owner: string;
  name: string;
}

export interface SchemaObjectState extends SchemaObjectRef {
  ddl: string;
}

export interface OracleDelta {
  users: Array<{ record: CatalogUser; password?: string }>;
  dump: unknown;
  droppedUsers?: string[];
  droppedTables?: Array<{ schema: string; name: string }>;
  objects?: SchemaObjectState[];
  droppedObjects?: SchemaObjectRef[];
  roles?: Array<CatalogRole & { password?: string }>;
  droppedRoles?: string[];
  grants?: OracleGrantDelta;
  profiles?: Array<{ name: string; limits: Array<[string, string]> }>;
  droppedProfiles?: string[];
  tablespaces?: TablespaceMeta[];
  droppedTablespaces?: string[];
  parameters?: { memory: Record<string, string>; spfile: Record<string, string> };
}

interface RoleGrantRow { grantee: string; role: string; adminOption: boolean }
interface ColumnGrantRow {
  grantee: string; grantor: string; objectSchema: string; objectName: string;
  columnName: string; privilege: string; grantable: boolean;
}

export interface OracleGrantDelta {
  system: { granted: CatalogPrivilege[]; revoked: CatalogPrivilege[] };
  table: { granted: CatalogPrivilege[]; revoked: CatalogPrivilege[] };
  role: { granted: RoleGrantRow[]; revoked: RoleGrantRow[] };
  column: { granted: ColumnGrantRow[]; revoked: ColumnGrantRow[] };
}

interface DeltaSection {
  capture(live: OracleDatabase, factory: OracleDatabase): Partial<OracleDelta>;
  restore(db: OracleDatabase, delta: OracleDelta): void;
}

const key = (ref: SchemaObjectRef): string => `${ref.kind}:${ref.owner}.${ref.name}`;

function accountSignature(record: CatalogUser, password: string | undefined): string {
  const { created: _created, ...rest } = record;
  return JSON.stringify({ record: rest, password });
}

function reviveUser(record: CatalogUser): CatalogUser {
  const date = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));
  return {
    ...record,
    created: new Date(record.created),
    lockDate: date(record.lockDate),
    expiryDate: date(record.expiryDate),
  };
}

const accounts: DeltaSection = {
  capture(live, factory) {
    const factoryAccounts = new Map(factory.catalog.getAllUsers().map((record) =>
      [record.username, accountSignature(record, factory.catalog.getStoredPassword(record.username))]));
    const all = live.catalog.getAllUsers().map((record) => ({
      record,
      password: live.catalog.getStoredPassword(record.username),
    }));
    const users = all.filter((u) => factoryAccounts.get(u.record.username) !== accountSignature(u.record, u.password));
    const liveNames = new Set(all.map((u) => u.record.username));
    const droppedUsers = [...factoryAccounts.keys()].filter((name) => !liveNames.has(name));
    return {
      users,
      ...(droppedUsers.length > 0 ? { droppedUsers } : {}),
    };
  },
  restore(db, delta) {
    for (const username of delta.droppedUsers ?? []) {
      if (db.catalog.userExists(username)) db.catalog.dropUser(username);
    }
    for (const u of delta.users) {
      db.catalog.createUser(reviveUser(u.record));
      if (u.password !== undefined) db.catalog.setPassword(u.record.username, u.password);
    }
  },
};

const tables: DeltaSection = {
  capture(live, factory) {
    const factoryTables = new Map(new DataPumpEngine(factory).export({ full: true }).dump.tables
      .map((t) => [`${t.schema}.${t.name}`, JSON.stringify(t)]));
    const { dump } = new DataPumpEngine(live).export({ full: true });
    const changed = dump.tables.filter((t) => factoryTables.get(`${t.schema}.${t.name}`) !== JSON.stringify(t));
    const liveTables = new Set(dump.tables.map((t) => `${t.schema}.${t.name}`));
    const droppedTables = [...factoryTables.keys()]
      .filter((k) => !liveTables.has(k))
      .map((k) => ({ schema: k.slice(0, k.indexOf('.')), name: k.slice(k.indexOf('.') + 1) }));
    return {
      dump: { ...dump, tables: changed },
      ...(droppedTables.length > 0 ? { droppedTables } : {}),
    };
  },
  restore(db, delta) {
    for (const { schema, name } of delta.droppedTables ?? []) {
      if (db.storage.tableExists(schema, name)) db.storage.dropTable(schema, name);
    }
    const parsed = DataPumpEngine.parse(JSON.stringify(delta.dump));
    if (parsed) new DataPumpEngine(db).import(parsed, { tableExistsAction: 'REPLACE' });
  },
};

function listSchemaObjects(db: OracleDatabase): SchemaObjectRef[] {
  const refs: SchemaObjectRef[] = [];
  for (const v of db.storage.getAllViews()) refs.push({ kind: 'VIEW', owner: v.schema, name: v.name });
  for (const { schema, sequence } of db.storage.getAllSequences()) refs.push({ kind: 'SEQUENCE', owner: schema, name: sequence.name });
  for (const schema of db.storage.getSchemas()) {
    for (const i of db.storage.getIndexes(schema)) refs.push({ kind: 'INDEX', owner: schema, name: i.name });
  }
  for (const s of db.storage.getAllSynonyms()) refs.push({ kind: 'SYNONYM', owner: s.owner, name: s.name });
  for (const t of db.storage.getAllTriggers()) refs.push({ kind: 'TRIGGER', owner: t.schema, name: t.name });
  for (const u of db.catalog.getStoredUnits()) {
    const kind = u.type.toUpperCase().replace(' ', '_');
    if (kind === 'PROCEDURE' || kind === 'FUNCTION' || kind === 'PACKAGE' || kind === 'PACKAGE_BODY') {
      refs.push({ kind, owner: u.schema, name: u.name });
    }
  }
  return refs;
}

function ddlOf(db: OracleDatabase, ref: SchemaObjectRef): string | null {
  return new MetadataExtractor(db.storage, db.catalog).getDdl(ref.kind, ref.name, ref.owner);
}

const CREATION_ORDER: readonly SchemaObjectKind[] = [
  'SEQUENCE', 'VIEW', 'SYNONYM', 'INDEX', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE_BODY', 'TRIGGER',
];

function dropStatement(ref: SchemaObjectRef, isPublicSynonym: boolean): string {
  const kind = ref.kind === 'PACKAGE_BODY' ? 'PACKAGE BODY' : ref.kind;
  if (ref.kind === 'SYNONYM' && isPublicSynonym) return `DROP PUBLIC SYNONYM "${ref.name}"`;
  return `DROP ${kind} "${ref.owner}"."${ref.name}"`;
}

function replay(db: OracleDatabase, statement: string, subject: string): void {
  try {
    db.executeSql(db.connectAsSysdba().executor, statement);
  } catch (error) {
    Logger.warn('oracle', 'persistence.restore-failed', `${subject}: ${String(error)}`);
  }
}

const schemaObjects: DeltaSection = {
  capture(live, factory) {
    const factoryDdl = new Map(listSchemaObjects(factory).map((ref) => [key(ref), ddlOf(factory, ref)]));
    const liveRefs = listSchemaObjects(live);
    const objects: SchemaObjectState[] = [];
    for (const ref of liveRefs) {
      const ddl = ddlOf(live, ref);
      if (ddl !== null && factoryDdl.get(key(ref)) !== ddl) objects.push({ ...ref, ddl });
    }
    const liveKeys = new Set(liveRefs.map(key));
    const droppedObjects = listSchemaObjects(factory).filter((ref) => !liveKeys.has(key(ref)));
    return {
      ...(objects.length > 0 ? { objects } : {}),
      ...(droppedObjects.length > 0 ? { droppedObjects } : {}),
    };
  },
  restore(db, delta) {
    for (const ref of delta.droppedObjects ?? []) {
      replay(db, dropStatement(ref, db.storage.getAllSynonyms().some((s) => s.isPublic && s.name === ref.name)), key(ref));
    }
    const ordered = [...(delta.objects ?? [])]
      .sort((a, b) => CREATION_ORDER.indexOf(a.kind) - CREATION_ORDER.indexOf(b.kind));
    for (const object of ordered) {
      const replaceable = object.kind === 'SEQUENCE' || object.kind === 'INDEX';
      if (replaceable && ddlOf(db, object) !== null) replay(db, dropStatement(object, false), key(object));
      replay(db, object.ddl, key(object));
    }
  },
};

const sig = (value: unknown): string => JSON.stringify(value);

function changesBetween<T>(live: readonly T[], factory: readonly T[]): { granted: T[]; revoked: T[] } {
  const liveKeys = new Set(live.map(sig));
  const factoryKeys = new Set(factory.map(sig));
  return {
    granted: live.filter((row) => !factoryKeys.has(sig(row))),
    revoked: factory.filter((row) => !liveKeys.has(sig(row))),
  };
}

const roles: DeltaSection = {
  capture(live, factory) {
    const describe = (db: OracleDatabase) => db.catalog.getAllRoles()
      .map((role) => ({ ...role, password: db.catalog.getRolePassword(role.name) }));
    const liveRoles = describe(live);
    const factoryKeys = new Map(describe(factory).map((r) => [r.name, sig(r)]));
    const changed = liveRoles.filter((r) => factoryKeys.get(r.name) !== sig(r));
    const liveNames = new Set(liveRoles.map((r) => r.name));
    const droppedRoles = [...factoryKeys.keys()].filter((name) => !liveNames.has(name));
    return {
      ...(changed.length > 0 ? { roles: changed } : {}),
      ...(droppedRoles.length > 0 ? { droppedRoles } : {}),
    };
  },
  restore(db, delta) {
    for (const name of delta.droppedRoles ?? []) {
      if (db.catalog.roleExists(name)) db.catalog.dropRole(name);
    }
    for (const role of delta.roles ?? []) {
      db.catalog.createRole(role.name, role.authenticationType);
      if (role.password !== undefined) db.catalog.setRolePassword(role.name, role.password);
    }
  },
};

const grants: DeltaSection = {
  capture(live, factory) {
    const system = changesBetween(live.catalog.getSysPrivilegeGrants(), factory.catalog.getSysPrivilegeGrants());
    const table = changesBetween(live.catalog.getTablePrivilegeGrants(), factory.catalog.getTablePrivilegeGrants());
    const role = changesBetween(live.catalog.getRoleGrants(), factory.catalog.getRoleGrants());
    const column = changesBetween(live.catalog.getColumnPrivileges(), factory.catalog.getColumnPrivileges());
    const all = [system, table, role, column];
    if (all.every((c) => c.granted.length === 0 && c.revoked.length === 0)) return {};
    return { grants: { system, table, role, column } as OracleGrantDelta };
  },
  restore(db, delta) {
    if (!delta.grants) return;
    const { system, table, role, column } = delta.grants;
    for (const g of system.revoked) db.catalog.revokeSystemPrivilege(g.grantee, g.privilege);
    for (const g of table.revoked) db.catalog.revokeTablePrivilege(g.grantee, g.privilege, g.objectSchema ?? '', g.objectName ?? '');
    for (const g of role.revoked) db.catalog.revokeRole(g.grantee, g.role);
    for (const g of column.revoked) {
      db.catalog.revokeColumnPrivilege(g.grantee, g.privilege, g.objectSchema, g.objectName, g.columnName);
    }
    for (const g of system.granted) db.catalog.grantSystemPrivilege(g.grantee, g.privilege, g.grantable);
    for (const g of table.granted) {
      db.catalog.grantTablePrivilege(g.grantee, g.privilege, g.objectSchema ?? '', g.objectName ?? '', g.grantable, g.grantor);
    }
    for (const g of role.granted) db.catalog.grantRole(g.grantee, g.role, g.adminOption);
    for (const g of column.granted) {
      db.catalog.grantColumnPrivilege(g.grantee, g.privilege, g.objectSchema, g.objectName, g.columnName, g.grantor, g.grantable);
    }
  },
};

const profiles: DeltaSection = {
  capture(live, factory) {
    const describe = (db: OracleDatabase) =>
      new Map([...db.catalog.getProfiles()].map(([name, limits]) => [name, [...limits].sort()]));
    const liveProfiles = describe(live);
    const factoryProfiles = describe(factory);
    const changed = [...liveProfiles]
      .filter(([name, limits]) => sig(factoryProfiles.get(name)) !== sig(limits))
      .map(([name, limits]) => ({ name, limits: limits as Array<[string, string]> }));
    const droppedProfiles = [...factoryProfiles.keys()].filter((name) => !liveProfiles.has(name));
    return {
      ...(changed.length > 0 ? { profiles: changed } : {}),
      ...(droppedProfiles.length > 0 ? { droppedProfiles } : {}),
    };
  },
  restore(db, delta) {
    for (const name of delta.droppedProfiles ?? []) db.catalog.dropProfile(name);
    for (const profile of delta.profiles ?? []) {
      const limits = new Map(profile.limits);
      if (db.catalog.getProfiles().has(profile.name)) db.catalog.alterProfile(profile.name, limits);
      else db.catalog.createProfile(profile.name, limits);
    }
  },
};

const tablespaces: DeltaSection = {
  capture(live, factory) {
    const factorySig = new Map(factory.storage.getAllTablespaces().map((t) => [t.name, sig(t)]));
    const liveAll = live.storage.getAllTablespaces();
    const changed = liveAll.filter((t) => factorySig.get(t.name) !== sig(t));
    const liveNames = new Set(liveAll.map((t) => t.name));
    const droppedTablespaces = [...factorySig.keys()].filter((name) => !liveNames.has(name));
    return {
      ...(changed.length > 0 ? { tablespaces: changed } : {}),
      ...(droppedTablespaces.length > 0 ? { droppedTablespaces } : {}),
    };
  },
  restore(db, delta) {
    for (const name of delta.droppedTablespaces ?? []) {
      if (db.storage.getTablespace(name)) db.storage.dropTablespace(name);
    }
    for (const ts of delta.tablespaces ?? []) {
      const existing = db.storage.getTablespace(ts.name);
      if (existing) Object.assign(existing, ts);
      else db.storage.createTablespace(ts);
    }
  },
};

const parameters: DeltaSection = {
  capture(live, factory) {
    const differing = (liveMap: Map<string, string>, factoryMap: Map<string, string>) =>
      Object.fromEntries([...liveMap].filter(([k, v]) => factoryMap.get(k) !== v));
    const memory = differing(live.instance.getAllParameters(), factory.instance.getAllParameters());
    const spfile = differing(live.instance.getSpfileParameters(), factory.instance.getSpfileParameters());
    return Object.keys(memory).length + Object.keys(spfile).length > 0 ? { parameters: { memory, spfile } } : {};
  },
  restore(db, delta) {
    for (const [name, value] of Object.entries(delta.parameters?.memory ?? {})) db.instance.setParameter(name, value, 'MEMORY');
    for (const [name, value] of Object.entries(delta.parameters?.spfile ?? {})) db.instance.setParameter(name, value, 'SPFILE');
  },
};

const SECTIONS: readonly DeltaSection[] = [
  profiles, roles, accounts, tablespaces, tables, schemaObjects, grants, parameters,
];

export function captureOracleDelta(live: OracleDatabase, factory: OracleDatabase): OracleDelta | null {
  const delta = Object.assign({}, ...SECTIONS.map((s) => s.capture(live, factory))) as OracleDelta;
  const empty = delta.users.length === 0
    && (delta.dump as DataPumpDump).tables.length === 0
    && Object.keys(delta).every((k) => k === 'users' || k === 'dump');
  return empty ? null : delta;
}

export function restoreOracleDelta(db: OracleDatabase, delta: OracleDelta): void {
  for (const section of SECTIONS) section.restore(db, delta);
}
