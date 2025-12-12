/**
 * Oracle System Tables and Views - Data dictionary and V$ views
 */

import { SQLRow, SQLResultSet, TableDefinition, ColumnDefinition } from '../generic/types';
import { SQLEngine, TableStorage } from '../generic/engine';
import { OracleUser, OracleVSession, OracleDatabaseInfo, OracleTablespace } from './types';

/**
 * Oracle System Catalog - Manages data dictionary views
 */
export class OracleSystemCatalog {
  private databaseInfo: OracleDatabaseInfo;
  private users: Map<string, OracleUser> = new Map();
  private tablespaces: Map<string, OracleTablespace> = new Map();
  private sessions: OracleVSession[] = [];
  private currentSessionId: number = 1;

  constructor(private engine: SQLEngine) {
    this.initializeDatabase();
    this.initializeUsers();
    this.initializeTablespaces();
    this.initializeSession();
  }

  private initializeDatabase(): void {
    this.databaseInfo = {
      name: 'ORCL',
      dbid: 1234567890,
      created: new Date('2024-01-01'),
      openMode: 'READ WRITE',
      logMode: 'NOARCHIVELOG',
      forceLogging: false,
      platformName: 'Linux x86 64-bit',
      version: '19.0.0.0.0',
      versionFull: '19.3.0.0.0',
      banner: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production',
      edition: 'Enterprise Edition',
      characterSet: 'AL32UTF8',
      nationalCharacterSet: 'AL16UTF16'
    };
  }

  private initializeUsers(): void {
    // Create system users
    const systemUsers = ['SYS', 'SYSTEM', 'PUBLIC', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'DBSFWUSER', 'GGSYS', 'ANONYMOUS', 'CTXSYS', 'DVSYS', 'DVF', 'GSMADMIN_INTERNAL', 'MDSYS', 'OLAPSYS', 'XDB', 'WMSYS'];

    for (const username of systemUsers) {
      this.users.set(username, {
        username,
        defaultTablespace: username === 'SYS' || username === 'SYSTEM' ? 'SYSTEM' : 'USERS',
        temporaryTablespace: 'TEMP',
        profile: 'DEFAULT',
        accountStatus: 'OPEN',
        createdDate: new Date('2024-01-01'),
        quotas: new Map([['USERS', 'UNLIMITED']]),
        grantedRoles: username === 'SYS' ? ['DBA', 'SYSDBA'] : username === 'SYSTEM' ? ['DBA'] : [],
        grantedPrivileges: []
      });
    }
  }

  private initializeTablespaces(): void {
    this.tablespaces.set('SYSTEM', {
      name: 'SYSTEM',
      contents: 'PERMANENT',
      status: 'ONLINE',
      blockSize: 8192,
      initialExtent: 65536,
      nextExtent: 1048576,
      minExtents: 1,
      maxExtents: 'UNLIMITED',
      pctIncrease: 0,
      autoExtend: true,
      maxSize: 'UNLIMITED',
      files: ['/u01/app/oracle/oradata/ORCL/system01.dbf']
    });

    this.tablespaces.set('SYSAUX', {
      name: 'SYSAUX',
      contents: 'PERMANENT',
      status: 'ONLINE',
      blockSize: 8192,
      initialExtent: 65536,
      nextExtent: 1048576,
      minExtents: 1,
      maxExtents: 'UNLIMITED',
      pctIncrease: 0,
      autoExtend: true,
      maxSize: 'UNLIMITED',
      files: ['/u01/app/oracle/oradata/ORCL/sysaux01.dbf']
    });

    this.tablespaces.set('USERS', {
      name: 'USERS',
      contents: 'PERMANENT',
      status: 'ONLINE',
      blockSize: 8192,
      initialExtent: 65536,
      nextExtent: 1048576,
      minExtents: 1,
      maxExtents: 'UNLIMITED',
      pctIncrease: 0,
      autoExtend: true,
      maxSize: 'UNLIMITED',
      files: ['/u01/app/oracle/oradata/ORCL/users01.dbf']
    });

    this.tablespaces.set('TEMP', {
      name: 'TEMP',
      contents: 'TEMPORARY',
      status: 'ONLINE',
      blockSize: 8192,
      initialExtent: 1048576,
      nextExtent: 1048576,
      minExtents: 1,
      maxExtents: 'UNLIMITED',
      pctIncrease: 0,
      autoExtend: true,
      maxSize: 'UNLIMITED',
      files: ['/u01/app/oracle/oradata/ORCL/temp01.dbf']
    });

    this.tablespaces.set('UNDOTBS1', {
      name: 'UNDOTBS1',
      contents: 'UNDO',
      status: 'ONLINE',
      blockSize: 8192,
      initialExtent: 65536,
      nextExtent: 1048576,
      minExtents: 1,
      maxExtents: 'UNLIMITED',
      pctIncrease: 0,
      autoExtend: true,
      maxSize: 'UNLIMITED',
      files: ['/u01/app/oracle/oradata/ORCL/undotbs01.dbf']
    });
  }

  private initializeSession(): void {
    this.sessions.push({
      sid: this.currentSessionId,
      serial: 1,
      username: this.engine.getCurrentUser(),
      status: 'ACTIVE',
      schemaName: this.engine.getCurrentSchema(),
      osUser: 'oracle',
      machine: 'localhost',
      terminal: 'pts/0',
      program: 'sqlplus@localhost (TNS V1-V3)',
      type: 'USER',
      sqlId: null,
      sqlChildNumber: null,
      sqlExecStart: null,
      state: 'WAITING',
      waitClass: 'Idle',
      waitTime: 0,
      secondsInWait: 0,
      event: 'SQL*Net message from client',
      logonTime: new Date(),
      lastCallEt: 0
    });
  }

  /**
   * Query a data dictionary view
   */
  queryView(viewName: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const upperName = viewName.toUpperCase();

    switch (upperName) {
      // Database views
      case 'V$DATABASE':
      case 'V_$DATABASE':
        return this.getVDatabase();

      case 'V$VERSION':
      case 'V_$VERSION':
        return this.getVVersion();

      case 'V$INSTANCE':
      case 'V_$INSTANCE':
        return this.getVInstance();

      // Session views
      case 'V$SESSION':
      case 'V_$SESSION':
        return this.getVSession(whereClause);

      case 'V$PROCESS':
      case 'V_$PROCESS':
        return this.getVProcess();

      case 'V$MYSTAT':
      case 'V_$MYSTAT':
        return this.getVMystat();

      // Object views
      case 'USER_TABLES':
      case 'ALL_TABLES':
      case 'DBA_TABLES':
        return this.getTables(upperName, whereClause);

      case 'USER_TAB_COLUMNS':
      case 'ALL_TAB_COLUMNS':
      case 'DBA_TAB_COLUMNS':
        return this.getColumns(upperName, whereClause);

      case 'USER_VIEWS':
      case 'ALL_VIEWS':
      case 'DBA_VIEWS':
        return this.getViews(upperName, whereClause);

      case 'USER_INDEXES':
      case 'ALL_INDEXES':
      case 'DBA_INDEXES':
        return this.getIndexes(upperName, whereClause);

      case 'USER_CONSTRAINTS':
      case 'ALL_CONSTRAINTS':
      case 'DBA_CONSTRAINTS':
        return this.getConstraints(upperName, whereClause);

      case 'USER_SEQUENCES':
      case 'ALL_SEQUENCES':
      case 'DBA_SEQUENCES':
        return this.getSequences(upperName, whereClause);

      // User views
      case 'USER_USERS':
      case 'ALL_USERS':
      case 'DBA_USERS':
        return this.getUsers(upperName, whereClause);

      case 'USER_ROLE_PRIVS':
      case 'DBA_ROLE_PRIVS':
        return this.getRolePrivs(whereClause);

      case 'USER_TAB_PRIVS':
      case 'ALL_TAB_PRIVS':
      case 'DBA_TAB_PRIVS':
        return this.getTabPrivs(whereClause);

      case 'USER_SYS_PRIVS':
      case 'DBA_SYS_PRIVS':
        return this.getSysPrivs(whereClause);

      // Tablespace views
      case 'USER_TABLESPACES':
      case 'DBA_TABLESPACES':
        return this.getTablespaces(whereClause);

      case 'DBA_DATA_FILES':
        return this.getDataFiles();

      // NLS views
      case 'V$NLS_PARAMETERS':
      case 'NLS_SESSION_PARAMETERS':
      case 'NLS_DATABASE_PARAMETERS':
        return this.getNLSParameters();

      // Objects
      case 'USER_OBJECTS':
      case 'ALL_OBJECTS':
      case 'DBA_OBJECTS':
        return this.getObjects(upperName, whereClause);

      // Source
      case 'USER_SOURCE':
      case 'ALL_SOURCE':
      case 'DBA_SOURCE':
        return this.getSource(whereClause);

      // DUAL
      case 'DUAL':
        return {
          columns: ['DUMMY'],
          columnTypes: ['VARCHAR'],
          rows: [{ DUMMY: 'X' }],
          rowCount: 1
        };

      // Dictionary
      case 'DICTIONARY':
      case 'DICT':
        return this.getDictionary();

      default:
        return {
          columns: [],
          columnTypes: [],
          rows: [],
          rowCount: 0
        };
    }
  }

  // V$ views implementation
  private getVDatabase(): SQLResultSet {
    const db = this.databaseInfo;
    return {
      columns: ['DBID', 'NAME', 'CREATED', 'OPEN_MODE', 'LOG_MODE', 'FORCE_LOGGING', 'PLATFORM_NAME'],
      columnTypes: ['INTEGER', 'VARCHAR', 'DATE', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows: [{
        DBID: db.dbid,
        NAME: db.name,
        CREATED: db.created,
        OPEN_MODE: db.openMode,
        LOG_MODE: db.logMode,
        FORCE_LOGGING: db.forceLogging ? 'YES' : 'NO',
        PLATFORM_NAME: db.platformName
      }],
      rowCount: 1
    };
  }

  private getVVersion(): SQLResultSet {
    return {
      columns: ['BANNER', 'BANNER_FULL', 'BANNER_LEGACY', 'CON_ID'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'INTEGER'],
      rows: [
        {
          BANNER: this.databaseInfo.banner,
          BANNER_FULL: `${this.databaseInfo.banner}\nVersion ${this.databaseInfo.versionFull}`,
          BANNER_LEGACY: this.databaseInfo.banner,
          CON_ID: 0
        },
        {
          BANNER: 'PL/SQL Release 19.0.0.0.0 - Production',
          BANNER_FULL: 'PL/SQL Release 19.0.0.0.0 - Production',
          BANNER_LEGACY: 'PL/SQL Release 19.0.0.0.0 - Production',
          CON_ID: 0
        },
        {
          BANNER: 'CORE\t19.0.0.0.0\tProduction',
          BANNER_FULL: 'CORE\t19.0.0.0.0\tProduction',
          BANNER_LEGACY: 'CORE\t19.0.0.0.0\tProduction',
          CON_ID: 0
        },
        {
          BANNER: 'TNS for Linux: Version 19.0.0.0.0 - Production',
          BANNER_FULL: 'TNS for Linux: Version 19.0.0.0.0 - Production',
          BANNER_LEGACY: 'TNS for Linux: Version 19.0.0.0.0 - Production',
          CON_ID: 0
        },
        {
          BANNER: 'NLSRTL Version 19.0.0.0.0 - Production',
          BANNER_FULL: 'NLSRTL Version 19.0.0.0.0 - Production',
          BANNER_LEGACY: 'NLSRTL Version 19.0.0.0.0 - Production',
          CON_ID: 0
        }
      ],
      rowCount: 5
    };
  }

  private getVInstance(): SQLResultSet {
    return {
      columns: ['INSTANCE_NUMBER', 'INSTANCE_NAME', 'HOST_NAME', 'VERSION', 'STARTUP_TIME', 'STATUS', 'DATABASE_STATUS', 'INSTANCE_ROLE'],
      columnTypes: ['INTEGER', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'DATE', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows: [{
        INSTANCE_NUMBER: 1,
        INSTANCE_NAME: this.databaseInfo.name,
        HOST_NAME: 'localhost',
        VERSION: this.databaseInfo.version,
        STARTUP_TIME: new Date(),
        STATUS: 'OPEN',
        DATABASE_STATUS: 'ACTIVE',
        INSTANCE_ROLE: 'PRIMARY_INSTANCE'
      }],
      rowCount: 1
    };
  }

  private getVSession(whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    let rows = this.sessions.map(s => ({
      SID: s.sid,
      SERIAL#: s.serial,
      USERNAME: s.username,
      STATUS: s.status,
      SCHEMANAME: s.schemaName,
      OSUSER: s.osUser,
      MACHINE: s.machine,
      TERMINAL: s.terminal,
      PROGRAM: s.program,
      TYPE: s.type,
      SQL_ID: s.sqlId,
      SQL_CHILD_NUMBER: s.sqlChildNumber,
      SQL_EXEC_START: s.sqlExecStart,
      STATE: s.state,
      WAIT_CLASS: s.waitClass,
      WAIT_TIME: s.waitTime,
      SECONDS_IN_WAIT: s.secondsInWait,
      EVENT: s.event,
      LOGON_TIME: s.logonTime,
      LAST_CALL_ET: s.lastCallEt
    }));

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['SID', 'SERIAL#', 'USERNAME', 'STATUS', 'SCHEMANAME', 'OSUSER', 'MACHINE', 'TERMINAL', 'PROGRAM', 'TYPE', 'SQL_ID', 'EVENT', 'LOGON_TIME'],
      columnTypes: ['INTEGER', 'INTEGER', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'DATE'],
      rows,
      rowCount: rows.length
    };
  }

  private getVProcess(): SQLResultSet {
    return {
      columns: ['ADDR', 'PID', 'SPID', 'USERNAME', 'PROGRAM', 'BACKGROUND', 'PGA_USED_MEM', 'PGA_ALLOC_MEM', 'PGA_MAX_MEM'],
      columnTypes: ['VARCHAR', 'INTEGER', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'INTEGER', 'INTEGER', 'INTEGER'],
      rows: [{
        ADDR: '0000000000000001',
        PID: 1,
        SPID: '12345',
        USERNAME: 'oracle',
        PROGRAM: 'oracle@localhost (PMON)',
        BACKGROUND: '1',
        PGA_USED_MEM: 1048576,
        PGA_ALLOC_MEM: 2097152,
        PGA_MAX_MEM: 2097152
      }],
      rowCount: 1
    };
  }

  private getVMystat(): SQLResultSet {
    return {
      columns: ['SID', 'STATISTIC#', 'VALUE'],
      columnTypes: ['INTEGER', 'INTEGER', 'INTEGER'],
      rows: [
        { SID: this.currentSessionId, 'STATISTIC#': 0, VALUE: 1 },
        { SID: this.currentSessionId, 'STATISTIC#': 1, VALUE: 0 }
      ],
      rowCount: 2
    };
  }

  // Object views implementation
  private getTables(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const currentUser = this.engine.getCurrentUser();
    const tables = this.engine.listTables();
    let rows: SQLRow[] = tables.map(tableName => {
      const def = this.engine.getTableDefinition(tableName);
      return {
        OWNER: currentUser,
        TABLE_NAME: tableName,
        TABLESPACE_NAME: 'USERS',
        STATUS: 'VALID',
        NUM_ROWS: 0,
        BLOCKS: 0,
        AVG_ROW_LEN: 0,
        LAST_ANALYZED: null,
        PARTITIONED: 'NO',
        TEMPORARY: 'N',
        SECONDARY: 'N',
        NESTED: 'NO',
        IOT_TYPE: null,
        IOT_NAME: null,
        COMPRESSION: 'DISABLED',
        DROPPED: 'NO',
        READ_ONLY: 'NO'
      };
    });

    if (viewType === 'USER_TABLES') {
      rows = rows.filter(r => r.OWNER === currentUser);
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['OWNER', 'TABLE_NAME', 'TABLESPACE_NAME', 'STATUS', 'NUM_ROWS', 'PARTITIONED', 'TEMPORARY'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'INTEGER', 'VARCHAR', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getColumns(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const currentUser = this.engine.getCurrentUser();
    const tables = this.engine.listTables();
    let rows: SQLRow[] = [];

    for (const tableName of tables) {
      const def = this.engine.getTableDefinition(tableName);
      if (def) {
        let position = 1;
        for (const col of def.columns) {
          rows.push({
            OWNER: currentUser,
            TABLE_NAME: tableName,
            COLUMN_NAME: col.name,
            DATA_TYPE: col.dataType,
            DATA_LENGTH: col.length || 0,
            DATA_PRECISION: col.precision || null,
            DATA_SCALE: col.scale || null,
            NULLABLE: col.nullable ? 'Y' : 'N',
            COLUMN_ID: position,
            DEFAULT_LENGTH: col.defaultValue ? String(col.defaultValue).length : null,
            DATA_DEFAULT: col.defaultValue !== undefined ? String(col.defaultValue) : null,
            CHAR_LENGTH: col.length || 0,
            CHAR_USED: col.dataType.includes('CHAR') ? 'B' : null
          });
          position++;
        }
      }
    }

    if (viewType === 'USER_TAB_COLUMNS') {
      rows = rows.filter(r => r.OWNER === currentUser);
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['OWNER', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'DATA_LENGTH', 'DATA_PRECISION', 'DATA_SCALE', 'NULLABLE', 'COLUMN_ID', 'DATA_DEFAULT'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'INTEGER', 'INTEGER', 'INTEGER', 'VARCHAR', 'INTEGER', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getViews(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    // No views in our simple implementation
    return {
      columns: ['OWNER', 'VIEW_NAME', 'TEXT_LENGTH', 'TEXT', 'TYPE_TEXT_LENGTH', 'TYPE_TEXT'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'INTEGER', 'VARCHAR', 'INTEGER', 'VARCHAR'],
      rows: [],
      rowCount: 0
    };
  }

  private getIndexes(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const currentUser = this.engine.getCurrentUser();
    const tables = this.engine.listTables();
    let rows: SQLRow[] = [];

    for (const tableName of tables) {
      const def = this.engine.getTableDefinition(tableName);
      if (def && def.indexes) {
        for (const idx of def.indexes) {
          rows.push({
            OWNER: currentUser,
            INDEX_NAME: idx.name,
            INDEX_TYPE: idx.type || 'NORMAL',
            TABLE_OWNER: currentUser,
            TABLE_NAME: tableName,
            TABLE_TYPE: 'TABLE',
            UNIQUENESS: idx.unique ? 'UNIQUE' : 'NONUNIQUE',
            COMPRESSION: 'DISABLED',
            STATUS: 'VALID',
            PARTITIONED: 'NO',
            TEMPORARY: 'N',
            VISIBILITY: 'VISIBLE'
          });
        }
      }
    }

    if (viewType === 'USER_INDEXES') {
      rows = rows.filter(r => r.OWNER === currentUser);
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['OWNER', 'INDEX_NAME', 'INDEX_TYPE', 'TABLE_OWNER', 'TABLE_NAME', 'UNIQUENESS', 'STATUS'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getConstraints(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const currentUser = this.engine.getCurrentUser();
    const tables = this.engine.listTables();
    let rows: SQLRow[] = [];

    for (const tableName of tables) {
      const def = this.engine.getTableDefinition(tableName);
      if (def) {
        // Primary key
        if (def.primaryKey && def.primaryKey.length > 0) {
          rows.push({
            OWNER: currentUser,
            CONSTRAINT_NAME: `${tableName}_PK`,
            CONSTRAINT_TYPE: 'P',
            TABLE_NAME: tableName,
            SEARCH_CONDITION: null,
            R_OWNER: null,
            R_CONSTRAINT_NAME: null,
            DELETE_RULE: null,
            STATUS: 'ENABLED',
            DEFERRABLE: 'NOT DEFERRABLE',
            DEFERRED: 'IMMEDIATE',
            VALIDATED: 'VALIDATED',
            GENERATED: 'USER NAME',
            INDEX_OWNER: currentUser,
            INDEX_NAME: `${tableName}_PK`
          });
        }

        // Foreign keys
        for (const fk of def.foreignKeys || []) {
          rows.push({
            OWNER: currentUser,
            CONSTRAINT_NAME: fk.name,
            CONSTRAINT_TYPE: 'R',
            TABLE_NAME: tableName,
            SEARCH_CONDITION: null,
            R_OWNER: currentUser,
            R_CONSTRAINT_NAME: `${fk.refTable}_PK`,
            DELETE_RULE: fk.onDelete || 'NO ACTION',
            STATUS: 'ENABLED',
            DEFERRABLE: 'NOT DEFERRABLE',
            DEFERRED: 'IMMEDIATE',
            VALIDATED: 'VALIDATED',
            GENERATED: 'USER NAME',
            INDEX_OWNER: null,
            INDEX_NAME: null
          });
        }

        // Check constraints
        for (const chk of def.checkConstraints || []) {
          rows.push({
            OWNER: currentUser,
            CONSTRAINT_NAME: chk.name,
            CONSTRAINT_TYPE: 'C',
            TABLE_NAME: tableName,
            SEARCH_CONDITION: chk.expression,
            R_OWNER: null,
            R_CONSTRAINT_NAME: null,
            DELETE_RULE: null,
            STATUS: 'ENABLED',
            DEFERRABLE: 'NOT DEFERRABLE',
            DEFERRED: 'IMMEDIATE',
            VALIDATED: 'VALIDATED',
            GENERATED: 'USER NAME',
            INDEX_OWNER: null,
            INDEX_NAME: null
          });
        }
      }
    }

    if (viewType === 'USER_CONSTRAINTS') {
      rows = rows.filter(r => r.OWNER === currentUser);
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['OWNER', 'CONSTRAINT_NAME', 'CONSTRAINT_TYPE', 'TABLE_NAME', 'SEARCH_CONDITION', 'R_OWNER', 'R_CONSTRAINT_NAME', 'DELETE_RULE', 'STATUS'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getSequences(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    // Sequences would come from engine
    return {
      columns: ['SEQUENCE_OWNER', 'SEQUENCE_NAME', 'MIN_VALUE', 'MAX_VALUE', 'INCREMENT_BY', 'CYCLE_FLAG', 'ORDER_FLAG', 'CACHE_SIZE', 'LAST_NUMBER'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'INTEGER', 'INTEGER', 'INTEGER', 'VARCHAR', 'VARCHAR', 'INTEGER', 'INTEGER'],
      rows: [],
      rowCount: 0
    };
  }

  // User views implementation
  private getUsers(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    let rows = Array.from(this.users.values()).map(u => ({
      USERNAME: u.username,
      USER_ID: Array.from(this.users.keys()).indexOf(u.username),
      PASSWORD: null,
      ACCOUNT_STATUS: u.accountStatus,
      LOCK_DATE: u.lockDate || null,
      EXPIRY_DATE: u.expiryDate || null,
      DEFAULT_TABLESPACE: u.defaultTablespace,
      TEMPORARY_TABLESPACE: u.temporaryTablespace,
      CREATED: u.createdDate,
      PROFILE: u.profile,
      INITIAL_RSRC_CONSUMER_GROUP: null,
      EXTERNAL_NAME: null,
      AUTHENTICATION_TYPE: 'PASSWORD',
      COMMON: 'NO',
      LAST_LOGIN: u.lastLogin || null
    }));

    if (viewType === 'USER_USERS') {
      const currentUser = this.engine.getCurrentUser();
      rows = rows.filter(r => r.USERNAME === currentUser);
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['USERNAME', 'USER_ID', 'ACCOUNT_STATUS', 'LOCK_DATE', 'EXPIRY_DATE', 'DEFAULT_TABLESPACE', 'TEMPORARY_TABLESPACE', 'CREATED', 'PROFILE'],
      columnTypes: ['VARCHAR', 'INTEGER', 'VARCHAR', 'DATE', 'DATE', 'VARCHAR', 'VARCHAR', 'DATE', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getRolePrivs(whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const currentUser = this.engine.getCurrentUser();
    const user = this.users.get(currentUser);
    let rows: SQLRow[] = [];

    if (user) {
      rows = user.grantedRoles.map(role => ({
        GRANTEE: currentUser,
        GRANTED_ROLE: role,
        ADMIN_OPTION: 'NO',
        DELEGATE_OPTION: 'NO',
        DEFAULT_ROLE: 'YES',
        COMMON: 'NO',
        INHERITED: 'NO'
      }));
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['GRANTEE', 'GRANTED_ROLE', 'ADMIN_OPTION', 'DEFAULT_ROLE'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getTabPrivs(whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    return {
      columns: ['GRANTEE', 'OWNER', 'TABLE_NAME', 'GRANTOR', 'PRIVILEGE', 'GRANTABLE', 'HIERARCHY'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows: [],
      rowCount: 0
    };
  }

  private getSysPrivs(whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const currentUser = this.engine.getCurrentUser();
    const user = this.users.get(currentUser);
    let rows: SQLRow[] = [];

    if (user) {
      rows = user.grantedPrivileges.map(priv => ({
        GRANTEE: currentUser,
        PRIVILEGE: priv,
        ADMIN_OPTION: 'NO',
        COMMON: 'NO',
        INHERITED: 'NO'
      }));
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['GRANTEE', 'PRIVILEGE', 'ADMIN_OPTION'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getTablespaces(whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    let rows = Array.from(this.tablespaces.values()).map(ts => ({
      TABLESPACE_NAME: ts.name,
      BLOCK_SIZE: ts.blockSize,
      INITIAL_EXTENT: ts.initialExtent,
      NEXT_EXTENT: ts.nextExtent,
      MIN_EXTENTS: ts.minExtents,
      MAX_EXTENTS: ts.maxExtents === 'UNLIMITED' ? 2147483645 : ts.maxExtents,
      PCT_INCREASE: ts.pctIncrease,
      STATUS: ts.status,
      CONTENTS: ts.contents,
      LOGGING: 'LOGGING',
      FORCE_LOGGING: 'NO',
      ALLOCATION_TYPE: 'SYSTEM',
      PLUGGED_IN: 'NO',
      SEGMENT_SPACE_MANAGEMENT: 'AUTO',
      DEF_TAB_COMPRESSION: 'DISABLED',
      RETENTION: 'NOT APPLY',
      BIGFILE: 'NO',
      PREDICATE_EVALUATION: 'HOST',
      ENCRYPTED: 'NO',
      COMPRESS_FOR: null
    }));

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['TABLESPACE_NAME', 'BLOCK_SIZE', 'STATUS', 'CONTENTS', 'LOGGING', 'SEGMENT_SPACE_MANAGEMENT'],
      columnTypes: ['VARCHAR', 'INTEGER', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getDataFiles(): SQLResultSet {
    const rows: SQLRow[] = [];
    for (const ts of this.tablespaces.values()) {
      for (let i = 0; i < ts.files.length; i++) {
        rows.push({
          FILE_NAME: ts.files[i],
          FILE_ID: rows.length + 1,
          TABLESPACE_NAME: ts.name,
          BYTES: 104857600,
          BLOCKS: 12800,
          STATUS: 'AVAILABLE',
          RELATIVE_FNO: rows.length + 1,
          AUTOEXTENSIBLE: ts.autoExtend ? 'YES' : 'NO',
          MAXBYTES: ts.maxSize === 'UNLIMITED' ? 34359738368 : ts.maxSize,
          MAXBLOCKS: ts.maxSize === 'UNLIMITED' ? 4194304 : Math.floor((ts.maxSize as number) / ts.blockSize),
          INCREMENT_BY: 128,
          USER_BYTES: 103809024,
          USER_BLOCKS: 12672,
          ONLINE_STATUS: 'ONLINE'
        });
      }
    }

    return {
      columns: ['FILE_NAME', 'FILE_ID', 'TABLESPACE_NAME', 'BYTES', 'STATUS', 'AUTOEXTENSIBLE', 'MAXBYTES', 'ONLINE_STATUS'],
      columnTypes: ['VARCHAR', 'INTEGER', 'VARCHAR', 'INTEGER', 'VARCHAR', 'VARCHAR', 'INTEGER', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getNLSParameters(): SQLResultSet {
    return {
      columns: ['PARAMETER', 'VALUE'],
      columnTypes: ['VARCHAR', 'VARCHAR'],
      rows: [
        { PARAMETER: 'NLS_CALENDAR', VALUE: 'GREGORIAN' },
        { PARAMETER: 'NLS_COMP', VALUE: 'BINARY' },
        { PARAMETER: 'NLS_CURRENCY', VALUE: '$' },
        { PARAMETER: 'NLS_DATE_FORMAT', VALUE: 'DD-MON-RR' },
        { PARAMETER: 'NLS_DATE_LANGUAGE', VALUE: 'AMERICAN' },
        { PARAMETER: 'NLS_DUAL_CURRENCY', VALUE: '$' },
        { PARAMETER: 'NLS_ISO_CURRENCY', VALUE: 'AMERICA' },
        { PARAMETER: 'NLS_LANGUAGE', VALUE: 'AMERICAN' },
        { PARAMETER: 'NLS_LENGTH_SEMANTICS', VALUE: 'BYTE' },
        { PARAMETER: 'NLS_NCHAR_CONV_EXCP', VALUE: 'FALSE' },
        { PARAMETER: 'NLS_NUMERIC_CHARACTERS', VALUE: '.,' },
        { PARAMETER: 'NLS_SORT', VALUE: 'BINARY' },
        { PARAMETER: 'NLS_TERRITORY', VALUE: 'AMERICA' },
        { PARAMETER: 'NLS_TIMESTAMP_FORMAT', VALUE: 'DD-MON-RR HH.MI.SSXFF AM' },
        { PARAMETER: 'NLS_TIMESTAMP_TZ_FORMAT', VALUE: 'DD-MON-RR HH.MI.SSXFF AM TZR' },
        { PARAMETER: 'NLS_TIME_FORMAT', VALUE: 'HH.MI.SSXFF AM' },
        { PARAMETER: 'NLS_TIME_TZ_FORMAT', VALUE: 'HH.MI.SSXFF AM TZR' }
      ],
      rowCount: 17
    };
  }

  private getObjects(viewType: string, whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    const currentUser = this.engine.getCurrentUser();
    const tables = this.engine.listTables();
    let rows: SQLRow[] = tables.map((tableName, idx) => ({
      OWNER: currentUser,
      OBJECT_NAME: tableName,
      SUBOBJECT_NAME: null,
      OBJECT_ID: idx + 1,
      DATA_OBJECT_ID: idx + 1,
      OBJECT_TYPE: 'TABLE',
      CREATED: new Date(),
      LAST_DDL_TIME: new Date(),
      TIMESTAMP: new Date().toISOString(),
      STATUS: 'VALID',
      TEMPORARY: 'N',
      GENERATED: 'N',
      SECONDARY: 'N',
      NAMESPACE: 1,
      EDITION_NAME: null,
      SHARING: 'NONE',
      EDITIONABLE: null,
      ORACLE_MAINTAINED: 'N',
      APPLICATION: 'N',
      DEFAULT_COLLATION: null,
      DUPLICATED: 'N',
      SHARDED: 'N',
      CREATED_APPID: null,
      CREATED_VSNID: null,
      MODIFIED_APPID: null,
      MODIFIED_VSNID: null
    }));

    if (viewType === 'USER_OBJECTS') {
      rows = rows.filter(r => r.OWNER === currentUser);
    }

    if (whereClause) {
      rows = rows.filter(whereClause);
    }

    return {
      columns: ['OWNER', 'OBJECT_NAME', 'OBJECT_ID', 'OBJECT_TYPE', 'CREATED', 'LAST_DDL_TIME', 'STATUS', 'TEMPORARY'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'INTEGER', 'VARCHAR', 'DATE', 'DATE', 'VARCHAR', 'VARCHAR'],
      rows,
      rowCount: rows.length
    };
  }

  private getSource(whereClause?: (row: SQLRow) => boolean): SQLResultSet {
    return {
      columns: ['OWNER', 'NAME', 'TYPE', 'LINE', 'TEXT', 'ORIGIN_CON_ID'],
      columnTypes: ['VARCHAR', 'VARCHAR', 'VARCHAR', 'INTEGER', 'VARCHAR', 'INTEGER'],
      rows: [],
      rowCount: 0
    };
  }

  private getDictionary(): SQLResultSet {
    const views = [
      { TABLE_NAME: 'ALL_CATALOG', COMMENTS: 'All tables, views, synonyms, sequences accessible to the user' },
      { TABLE_NAME: 'ALL_COL_COMMENTS', COMMENTS: 'Comments on columns of accessible tables and views' },
      { TABLE_NAME: 'ALL_CONSTRAINTS', COMMENTS: 'Constraint definitions on accessible tables' },
      { TABLE_NAME: 'ALL_INDEXES', COMMENTS: 'Descriptions of indexes on tables accessible to the user' },
      { TABLE_NAME: 'ALL_OBJECTS', COMMENTS: 'Objects accessible to the user' },
      { TABLE_NAME: 'ALL_SEQUENCES', COMMENTS: 'Description of SEQUENCEs accessible to the user' },
      { TABLE_NAME: 'ALL_SYNONYMS', COMMENTS: 'All synonyms accessible to the user' },
      { TABLE_NAME: 'ALL_TAB_COLUMNS', COMMENTS: 'Columns of user\'s tables, views and clusters' },
      { TABLE_NAME: 'ALL_TAB_COMMENTS', COMMENTS: 'Comments on tables and views accessible to the user' },
      { TABLE_NAME: 'ALL_TABLES', COMMENTS: 'Description of relational tables accessible to the user' },
      { TABLE_NAME: 'ALL_USERS', COMMENTS: 'Information about all users of the database' },
      { TABLE_NAME: 'ALL_VIEWS', COMMENTS: 'Description of views accessible to the user' },
      { TABLE_NAME: 'DBA_TABLES', COMMENTS: 'Description of all relational tables in the database' },
      { TABLE_NAME: 'DBA_TAB_COLUMNS', COMMENTS: 'Columns of all tables, views and clusters' },
      { TABLE_NAME: 'DBA_USERS', COMMENTS: 'Information about all users of the database' },
      { TABLE_NAME: 'DICTIONARY', COMMENTS: 'Description of data dictionary tables and views' },
      { TABLE_NAME: 'DUAL', COMMENTS: 'A dummy table' },
      { TABLE_NAME: 'USER_CATALOG', COMMENTS: 'Tables, views, synonyms and sequences owned by the user' },
      { TABLE_NAME: 'USER_CONSTRAINTS', COMMENTS: 'Constraint definitions on user\'s own tables' },
      { TABLE_NAME: 'USER_INDEXES', COMMENTS: 'Description of the user\'s own indexes' },
      { TABLE_NAME: 'USER_OBJECTS', COMMENTS: 'Objects owned by the user' },
      { TABLE_NAME: 'USER_SEQUENCES', COMMENTS: 'Description of the user\'s own SEQUENCEs' },
      { TABLE_NAME: 'USER_TAB_COLUMNS', COMMENTS: 'Columns of user\'s tables, views and clusters' },
      { TABLE_NAME: 'USER_TABLES', COMMENTS: 'Description of the user\'s own relational tables' },
      { TABLE_NAME: 'USER_USERS', COMMENTS: 'Information about the current user' },
      { TABLE_NAME: 'USER_VIEWS', COMMENTS: 'Description of the user\'s own views' },
      { TABLE_NAME: 'V$DATABASE', COMMENTS: 'Database information from the control file' },
      { TABLE_NAME: 'V$INSTANCE', COMMENTS: 'Information about the current instance' },
      { TABLE_NAME: 'V$NLS_PARAMETERS', COMMENTS: 'NLS parameters' },
      { TABLE_NAME: 'V$PROCESS', COMMENTS: 'Information about processes' },
      { TABLE_NAME: 'V$SESSION', COMMENTS: 'Information about sessions' },
      { TABLE_NAME: 'V$VERSION', COMMENTS: 'Core library component version numbers' }
    ];

    return {
      columns: ['TABLE_NAME', 'COMMENTS'],
      columnTypes: ['VARCHAR', 'VARCHAR'],
      rows: views,
      rowCount: views.length
    };
  }

  // User management
  createUser(user: OracleUser): void {
    this.users.set(user.username, user);
  }

  dropUser(username: string): boolean {
    return this.users.delete(username);
  }

  getUser(username: string): OracleUser | undefined {
    return this.users.get(username);
  }

  updateSession(updates: Partial<OracleVSession>): void {
    if (this.sessions.length > 0) {
      Object.assign(this.sessions[0], updates);
    }
  }

  getDatabaseInfo(): OracleDatabaseInfo {
    return this.databaseInfo;
  }
}
