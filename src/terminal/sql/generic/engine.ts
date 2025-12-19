/**
 * Generic SQL Engine - In-memory database with query execution
 */

import {
  SQLDataType,
  SQLValue,
  SQLRow,
  SQLResult,
  SQLResultSet,
  SQLError,
  TableDefinition,
  ColumnDefinition,
  ViewDefinition,
  SequenceDefinition,
  SchemaDefinition,
  DatabaseInstance,
  DatabaseConfig,
  SQLUser,
  Role,
  Privilege,
  Transaction,
  IsolationLevel,
  createErrorResult,
  createSuccessResult,
  sqlValueToString,
  compareSQLValues,
  SelectStatement,
  InsertStatement,
  UpdateStatement,
  DeleteStatement,
  CreateTableStatement,
  SQLExpression,
  TableReference,
} from './types';

/**
 * In-memory table storage
 */
export class TableStorage {
  private rows: SQLRow[] = [];
  private autoIncrementValues: Map<string, number> = new Map();

  constructor(public definition: TableDefinition) {
    // Initialize auto-increment columns
    for (const col of definition.columns) {
      if (col.autoIncrement) {
        this.autoIncrementValues.set(col.name, 0);
      }
    }
  }

  insert(row: SQLRow): number {
    // Handle auto-increment
    for (const col of this.definition.columns) {
      if (col.autoIncrement && (row[col.name] === undefined || row[col.name] === null)) {
        const current = this.autoIncrementValues.get(col.name) || 0;
        const next = current + 1;
        row[col.name] = next;
        this.autoIncrementValues.set(col.name, next);
      }
    }

    // Apply defaults
    for (const col of this.definition.columns) {
      if (row[col.name] === undefined && col.defaultValue !== undefined) {
        row[col.name] = col.defaultValue;
      }
    }

    this.rows.push({ ...row });
    return this.rows.length;
  }

  update(predicate: (row: SQLRow) => boolean, updates: Partial<SQLRow>): number {
    let count = 0;
    for (let i = 0; i < this.rows.length; i++) {
      if (predicate(this.rows[i])) {
        this.rows[i] = { ...this.rows[i], ...updates };
        count++;
      }
    }
    return count;
  }

  delete(predicate: (row: SQLRow) => boolean): number {
    const originalLength = this.rows.length;
    this.rows = this.rows.filter(row => !predicate(row));
    return originalLength - this.rows.length;
  }

  select(predicate?: (row: SQLRow) => boolean): SQLRow[] {
    if (!predicate) return [...this.rows];
    return this.rows.filter(predicate);
  }

  truncate(): void {
    this.rows = [];
    // Reset auto-increment
    for (const col of this.definition.columns) {
      if (col.autoIncrement) {
        this.autoIncrementValues.set(col.name, 0);
      }
    }
  }

  getRowCount(): number {
    return this.rows.length;
  }

  getAllRows(): SQLRow[] {
    // Return deep copy to prevent modification of backup data
    return this.rows.map(row => ({ ...row }));
  }
}

/**
 * SQL Database Engine
 */
export class SQLEngine {
  private schemas: Map<string, Map<string, TableStorage>> = new Map();
  private views: Map<string, Map<string, ViewDefinition>> = new Map();
  private sequences: Map<string, Map<string, SequenceDefinition>> = new Map();
  private users: Map<string, SQLUser> = new Map();
  private roles: Map<string, Role> = new Map();
  private privileges: Privilege[] = [];

  private currentSchema: string = 'public';
  private currentUser: string = 'system';
  private config: DatabaseConfig;

  // Transaction support
  private inTransaction: boolean = false;
  private transactionSavepoints: Map<string, { tables: Map<string, SQLRow[]> }> = new Map();
  private transactionBackup: Map<string, SQLRow[]> = new Map();

  constructor(config?: Partial<DatabaseConfig>) {
    this.config = {
      caseSensitiveIdentifiers: false,
      defaultSchema: 'public',
      dateFormat: 'YYYY-MM-DD',
      timestampFormat: 'YYYY-MM-DD HH24:MI:SS',
      maxRowsReturn: 1000,
      autoCommit: true,
      ...config
    };

    // Normalize default schema name based on case sensitivity setting
    const defaultSchema = this.config.caseSensitiveIdentifiers
      ? this.config.defaultSchema
      : this.config.defaultSchema.toUpperCase();
    this.currentSchema = defaultSchema;

    // Initialize default schema
    this.schemas.set(defaultSchema, new Map());
    this.views.set(defaultSchema, new Map());
    this.sequences.set(defaultSchema, new Map());

    // Create system user
    this.users.set('system', {
      name: 'system',
      createdAt: new Date(),
      locked: false,
      passwordExpired: false,
      defaultSchema: this.currentSchema
    });
  }

  // Schema management
  createSchema(name: string): SQLResult {
    const schemaName = this.normalizeIdentifier(name);
    if (this.schemas.has(schemaName)) {
      return createErrorResult('SCHEMA_EXISTS', `Schema '${schemaName}' already exists`);
    }
    this.schemas.set(schemaName, new Map());
    this.views.set(schemaName, new Map());
    this.sequences.set(schemaName, new Map());
    return createSuccessResult();
  }

  dropSchema(name: string, cascade: boolean = false): SQLResult {
    const schemaName = this.normalizeIdentifier(name);
    if (!this.schemas.has(schemaName)) {
      return createErrorResult('SCHEMA_NOT_FOUND', `Schema '${schemaName}' does not exist`);
    }
    const tables = this.schemas.get(schemaName)!;
    if (tables.size > 0 && !cascade) {
      return createErrorResult('SCHEMA_NOT_EMPTY', `Schema '${schemaName}' is not empty`);
    }
    this.schemas.delete(schemaName);
    this.views.delete(schemaName);
    this.sequences.delete(schemaName);
    return createSuccessResult();
  }

  setCurrentSchema(name: string): SQLResult {
    const schemaName = this.normalizeIdentifier(name);
    if (!this.schemas.has(schemaName)) {
      return createErrorResult('SCHEMA_NOT_FOUND', `Schema '${schemaName}' does not exist`);
    }
    this.currentSchema = schemaName;
    return createSuccessResult();
  }

  // Table management
  createTable(stmt: CreateTableStatement): SQLResult {
    const schemaName = stmt.schema ? this.normalizeIdentifier(stmt.schema) : this.currentSchema;
    const tableName = this.normalizeIdentifier(stmt.table);

    if (!this.schemas.has(schemaName)) {
      return createErrorResult('SCHEMA_NOT_FOUND', `Schema '${schemaName}' does not exist`);
    }

    const tables = this.schemas.get(schemaName)!;
    if (tables.has(tableName)) {
      if (stmt.ifNotExists) {
        return createSuccessResult();
      }
      return createErrorResult('TABLE_EXISTS', `Table '${tableName}' already exists`);
    }

    const definition: TableDefinition = {
      name: tableName,
      schema: schemaName,
      columns: stmt.columns,
      primaryKey: stmt.primaryKey,
      indexes: stmt.indexes || [],
      foreignKeys: stmt.foreignKeys || [],
      checkConstraints: stmt.checkConstraints || []
    };

    tables.set(tableName, new TableStorage(definition));
    return createSuccessResult();
  }

  dropTable(tableName: string, schemaName?: string, ifExists: boolean = false, cascade: boolean = false): SQLResult {
    const schema = schemaName ? this.normalizeIdentifier(schemaName) : this.currentSchema;
    const table = this.normalizeIdentifier(tableName);

    if (!this.schemas.has(schema)) {
      return createErrorResult('SCHEMA_NOT_FOUND', `Schema '${schema}' does not exist`);
    }

    const tables = this.schemas.get(schema)!;
    if (!tables.has(table)) {
      if (ifExists) {
        return createSuccessResult();
      }
      return createErrorResult('TABLE_NOT_FOUND', `Table '${table}' does not exist`);
    }

    tables.delete(table);
    return createSuccessResult();
  }

  truncateTable(tableName: string, schemaName?: string): SQLResult {
    const storage = this.getTableStorage(tableName, schemaName);
    if (!storage) {
      return createErrorResult('TABLE_NOT_FOUND', `Table '${tableName}' does not exist`);
    }
    storage.truncate();
    return createSuccessResult();
  }

  getTableDefinition(tableName: string, schemaName?: string): TableDefinition | null {
    const storage = this.getTableStorage(tableName, schemaName);
    return storage?.definition || null;
  }

  /**
   * Describe a table for psql/sqlplus DESCRIBE command
   * Returns column info in a format suitable for display
   */
  describeTable(tableName: string, schemaName?: string): {
    columns: Array<{
      name: string;
      type: string;
      size?: number;
      nullable: boolean;
      primaryKey: boolean;
      unique: boolean;
      defaultValue?: any;
    }>;
  } | null {
    const definition = this.getTableDefinition(tableName, schemaName);
    if (!definition) return null;

    return {
      columns: definition.columns.map(col => ({
        name: col.name,
        type: col.dataType,
        size: col.length || col.precision,
        nullable: col.nullable !== false,
        primaryKey: col.primaryKey === true,
        unique: col.unique === true,
        defaultValue: col.defaultValue,
      })),
    };
  }

  listTables(schemaName?: string): string[] {
    const schema = schemaName ? this.normalizeIdentifier(schemaName) : this.currentSchema;
    const tables = this.schemas.get(schema);
    return tables ? Array.from(tables.keys()) : [];
  }

  // Query execution
  executeSelect(stmt: SelectStatement): SQLResult {
    const startTime = Date.now();

    try {
      // Get source data from FROM clause
      let rows = this.resolveFromClause(stmt.from);

      // Apply WHERE clause
      if (stmt.where) {
        rows = rows.filter(row => this.evaluateExpression(stmt.where!, row));
      }

      // Apply GROUP BY or aggregate functions
      let aggregated = false;
      if (stmt.groupBy && stmt.groupBy.length > 0) {
        rows = this.applyGroupBy(rows, stmt.groupBy, stmt.columns);
        aggregated = true;
      } else if (this.hasAggregateFunctions(stmt.columns)) {
        // If there are aggregate functions without GROUP BY, treat all rows as one group
        rows = this.applyGroupBy(rows, [], stmt.columns);
        aggregated = true;
      }

      // Apply HAVING
      if (stmt.having) {
        rows = rows.filter(row => this.evaluateExpression(stmt.having!, row));
      }

      // Apply ORDER BY
      if (stmt.orderBy && stmt.orderBy.length > 0) {
        rows = this.applyOrderBy(rows, stmt.orderBy);
      }

      // Apply DISTINCT
      if (stmt.distinct) {
        rows = this.applyDistinct(rows, stmt.columns);
      }

      // Apply OFFSET
      if (stmt.offset && stmt.offset > 0) {
        rows = rows.slice(stmt.offset);
      }

      // Apply LIMIT
      if (stmt.limit !== undefined) {
        rows = rows.slice(0, stmt.limit);
      }

      // Project columns (skip if already aggregated - applyGroupBy already projected)
      let columns: string[];
      let columnTypes: SQLDataType[];
      let projectedRows: SQLRow[];

      if (aggregated) {
        // Use rows directly from aggregation - they're already projected
        columns = Object.keys(rows[0] || {});
        columnTypes = columns.map(() => 'VARCHAR' as SQLDataType);
        projectedRows = rows;
      } else {
        const projected = this.projectColumns(rows, stmt.columns);
        columns = projected.columns;
        columnTypes = projected.columnTypes;
        projectedRows = projected.projectedRows;
      }

      return {
        success: true,
        resultSet: {
          columns,
          columnTypes,
          rows: projectedRows,
          rowCount: projectedRows.length
        },
        executionTime: Date.now() - startTime
      };
    } catch (e) {
      return createErrorResult('QUERY_ERROR', (e as Error).message);
    }
  }

  executeInsert(stmt: InsertStatement): SQLResult {
    const storage = this.getTableStorage(stmt.table, stmt.schema);
    if (!storage) {
      return createErrorResult('TABLE_NOT_FOUND', `Table '${stmt.table}' does not exist`);
    }

    const definition = storage.definition;
    let insertedCount = 0;
    let lastInsertId: number | undefined;

    // Backup for transaction
    if (this.inTransaction) {
      this.backupTable(stmt.table, stmt.schema);
    }

    if (stmt.values) {
      for (const valueRow of stmt.values) {
        const row: SQLRow = {};

        // Map values to columns
        const columns = stmt.columns || definition.columns.map(c => c.name);
        for (let i = 0; i < columns.length; i++) {
          const colName = this.normalizeIdentifier(columns[i]);
          row[colName] = i < valueRow.length ? valueRow[i] : null;
        }

        // Validate constraints
        const validationError = this.validateRow(row, definition);
        if (validationError) {
          return validationError;
        }

        storage.insert(row);
        insertedCount++;

        // Get last insert ID for auto-increment
        const autoIncCol = definition.columns.find(c => c.autoIncrement);
        if (autoIncCol) {
          lastInsertId = row[autoIncCol.name] as number;
        }
      }
    } else if (stmt.select) {
      const selectResult = this.executeSelect(stmt.select);
      if (!selectResult.success || !selectResult.resultSet) {
        return selectResult;
      }

      for (const selectRow of selectResult.resultSet.rows) {
        const row: SQLRow = {};
        const columns = stmt.columns || definition.columns.map(c => c.name);
        const selectCols = selectResult.resultSet.columns;

        for (let i = 0; i < columns.length; i++) {
          const colName = this.normalizeIdentifier(columns[i]);
          row[colName] = i < selectCols.length ? selectRow[selectCols[i]] : null;
        }

        const validationError = this.validateRow(row, definition);
        if (validationError) {
          return validationError;
        }

        storage.insert(row);
        insertedCount++;
      }
    }

    return {
      success: true,
      affectedRows: insertedCount,
      lastInsertId
    };
  }

  executeUpdate(stmt: UpdateStatement): SQLResult {
    const storage = this.getTableStorage(stmt.table, stmt.schema);
    if (!storage) {
      return createErrorResult('TABLE_NOT_FOUND', `Table '${stmt.table}' does not exist`);
    }

    // Backup for transaction
    if (this.inTransaction) {
      this.backupTable(stmt.table, stmt.schema);
    }

    const predicate = stmt.where
      ? (row: SQLRow) => this.evaluateExpression(stmt.where!, row)
      : () => true;

    // Update rows with expression evaluation per row
    let affectedRows = 0;
    const rows = storage.select();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (predicate(row)) {
        // Evaluate SET expressions with current row context
        const updates: Partial<SQLRow> = {};
        for (const setItem of stmt.set) {
          const colName = this.normalizeIdentifier(setItem.column);
          updates[colName] = this.evaluateExpression(setItem.value, row);
        }
        // Apply updates to the row
        Object.assign(row, updates);
        affectedRows++;
      }
    }

    return {
      success: true,
      affectedRows
    };
  }

  executeDelete(stmt: DeleteStatement): SQLResult {
    const storage = this.getTableStorage(stmt.table, stmt.schema);
    if (!storage) {
      return createErrorResult('TABLE_NOT_FOUND', `Table '${stmt.table}' does not exist`);
    }

    // Backup for transaction
    if (this.inTransaction) {
      this.backupTable(stmt.table, stmt.schema);
    }

    const predicate = stmt.where
      ? (row: SQLRow) => this.evaluateExpression(stmt.where!, row)
      : () => true;

    const affectedRows = storage.delete(predicate);

    return {
      success: true,
      affectedRows
    };
  }

  // Transaction support
  beginTransaction(): SQLResult {
    if (this.inTransaction) {
      return createErrorResult('TRANSACTION_ACTIVE', 'Transaction already in progress');
    }
    this.inTransaction = true;
    this.transactionBackup.clear();
    this.transactionSavepoints.clear();

    // Save current state of all tables for rollback
    for (const [schemaName, schemaTables] of this.schemas) {
      for (const [tableName, storage] of schemaTables) {
        const normalizedSchema = this.normalizeIdentifier(schemaName);
        const normalizedTable = this.normalizeIdentifier(tableName);
        this.transactionBackup.set(`${normalizedSchema}.${normalizedTable}`, storage.getAllRows());
      }
    }

    return createSuccessResult();
  }

  commit(): SQLResult {
    // Allow COMMIT without active transaction (standard SQL behavior - no-op)
    if (!this.inTransaction) {
      return createSuccessResult();
    }
    this.inTransaction = false;
    this.transactionBackup.clear();
    this.transactionSavepoints.clear();
    return createSuccessResult();
  }

  rollback(savepoint?: string): SQLResult {
    // Allow ROLLBACK without active transaction (standard SQL behavior - no-op)
    if (!this.inTransaction) {
      return createSuccessResult();
    }

    if (savepoint) {
      const sp = this.transactionSavepoints.get(savepoint);
      if (!sp) {
        return createErrorResult('SAVEPOINT_NOT_FOUND', `Savepoint '${savepoint}' not found`);
      }
      // Restore from savepoint
      for (const [key, rows] of sp.tables) {
        const [schema, table] = key.split('.');
        const storage = this.getTableStorage(table, schema);
        if (storage) {
          storage.truncate();
          for (const row of rows) {
            storage.insert(row);
          }
        }
      }
    } else {
      // Full rollback
      for (const [key, rows] of this.transactionBackup) {
        const [schema, table] = key.split('.');
        const storage = this.getTableStorage(table, schema);
        if (storage) {
          storage.truncate();
          for (const row of rows) {
            storage.insert(row);
          }
        }
      }
      this.inTransaction = false;
      this.transactionBackup.clear();
      this.transactionSavepoints.clear();
    }

    return createSuccessResult();
  }

  savepoint(name: string): SQLResult {
    if (!this.inTransaction) {
      return createErrorResult('NO_TRANSACTION', 'No transaction in progress');
    }

    const tables = new Map<string, SQLRow[]>();
    for (const [schemaName, schemaTables] of this.schemas) {
      for (const [tableName, storage] of schemaTables) {
        tables.set(`${schemaName}.${tableName}`, storage.getAllRows());
      }
    }

    this.transactionSavepoints.set(name, { tables });
    return createSuccessResult();
  }

  // User management
  createUser(name: string, password?: string): SQLResult {
    const userName = this.normalizeIdentifier(name);
    if (this.users.has(userName)) {
      return createErrorResult('USER_EXISTS', `User '${userName}' already exists`);
    }
    this.users.set(userName, {
      name: userName,
      password,
      createdAt: new Date(),
      locked: false,
      passwordExpired: false,
      defaultSchema: this.currentSchema
    });
    return createSuccessResult();
  }

  dropUser(name: string): SQLResult {
    const userName = this.normalizeIdentifier(name);
    if (!this.users.has(userName)) {
      return createErrorResult('USER_NOT_FOUND', `User '${userName}' does not exist`);
    }
    this.users.delete(userName);
    return createSuccessResult();
  }

  grant(privilege: string, objectType: string, objectName: string, grantee: string, withGrantOption: boolean = false): SQLResult {
    this.privileges.push({
      type: privilege.toUpperCase() as any,
      grantee: this.normalizeIdentifier(grantee),
      grantor: this.currentUser,
      objectType: objectType.toUpperCase() as any,
      objectName: this.normalizeIdentifier(objectName),
      withGrantOption
    });
    return createSuccessResult();
  }

  revoke(privilege: string, objectType: string, objectName: string, grantee: string): SQLResult {
    const granteeName = this.normalizeIdentifier(grantee);
    const objName = this.normalizeIdentifier(objectName);
    this.privileges = this.privileges.filter(p =>
      !(p.type === privilege.toUpperCase() &&
        p.objectType === objectType.toUpperCase() &&
        p.objectName === objName &&
        p.grantee === granteeName)
    );
    return createSuccessResult();
  }

  // Sequence support
  createSequence(name: string, schemaName?: string, options?: Partial<SequenceDefinition>): SQLResult {
    const schema = schemaName ? this.normalizeIdentifier(schemaName) : this.currentSchema;
    const seqName = this.normalizeIdentifier(name);

    if (!this.sequences.has(schema)) {
      this.sequences.set(schema, new Map());
    }

    const seqs = this.sequences.get(schema)!;
    if (seqs.has(seqName)) {
      return createErrorResult('SEQUENCE_EXISTS', `Sequence '${seqName}' already exists`);
    }

    seqs.set(seqName, {
      name: seqName,
      schema,
      startWith: options?.startWith ?? 1,
      incrementBy: options?.incrementBy ?? 1,
      minValue: options?.minValue,
      maxValue: options?.maxValue,
      cycle: options?.cycle ?? false,
      cache: options?.cache ?? 20,
      currentValue: (options?.startWith ?? 1) - (options?.incrementBy ?? 1)
    });

    return createSuccessResult();
  }

  nextVal(sequenceName: string, schemaName?: string): SQLValue {
    const schema = schemaName ? this.normalizeIdentifier(schemaName) : this.currentSchema;
    const seqName = this.normalizeIdentifier(sequenceName);

    const seqs = this.sequences.get(schema);
    if (!seqs || !seqs.has(seqName)) {
      throw new Error(`Sequence '${seqName}' does not exist`);
    }

    const seq = seqs.get(seqName)!;
    seq.currentValue += seq.incrementBy;

    if (seq.maxValue !== undefined && seq.currentValue > seq.maxValue) {
      if (seq.cycle) {
        seq.currentValue = seq.minValue ?? seq.startWith;
      } else {
        throw new Error(`Sequence '${seqName}' has reached maximum value`);
      }
    }

    return seq.currentValue;
  }

  currVal(sequenceName: string, schemaName?: string): SQLValue {
    const schema = schemaName ? this.normalizeIdentifier(schemaName) : this.currentSchema;
    const seqName = this.normalizeIdentifier(sequenceName);

    const seqs = this.sequences.get(schema);
    if (!seqs || !seqs.has(seqName)) {
      throw new Error(`Sequence '${seqName}' does not exist`);
    }

    return seqs.get(seqName)!.currentValue;
  }

  // Helper methods
  private getTableStorage(tableName: string, schemaName?: string): TableStorage | null {
    const schema = schemaName ? this.normalizeIdentifier(schemaName) : this.currentSchema;
    const table = this.normalizeIdentifier(tableName);

    const tables = this.schemas.get(schema);
    if (!tables) return null;

    return tables.get(table) || null;
  }

  private normalizeIdentifier(name: string): string {
    if (this.config.caseSensitiveIdentifiers) {
      return name;
    }
    return name.toUpperCase();
  }

  private backupTable(tableName: string, schemaName?: string): void {
    const schema = this.normalizeIdentifier(schemaName || this.currentSchema);
    const table = this.normalizeIdentifier(tableName);
    const key = `${schema}.${table}`;
    if (!this.transactionBackup.has(key)) {
      const storage = this.getTableStorage(tableName, schemaName);
      if (storage) {
        this.transactionBackup.set(key, storage.getAllRows());
      }
    }
  }

  private validateRow(row: SQLRow, definition: TableDefinition): SQLResult | null {
    for (const col of definition.columns) {
      // Normalize column name to match how values are stored
      const normalizedColName = this.normalizeIdentifier(col.name);
      const value = row[normalizedColName];

      // Check NOT NULL
      if (!col.nullable && (value === null || value === undefined)) {
        if (!col.autoIncrement && col.defaultValue === undefined) {
          return createErrorResult('NULL_VIOLATION', `Column '${col.name}' cannot be null`);
        }
      }

      // Check data type (basic validation)
      if (value !== null && value !== undefined) {
        // Type coercion/validation could be expanded here
      }
    }

    return null;
  }

  private resolveFromClause(from: TableReference[]): SQLRow[] {
    if (from.length === 0) {
      return [{}]; // Single row for SELECT without FROM
    }

    let result: SQLRow[] = [];

    for (let i = 0; i < from.length; i++) {
      const ref = from[i];
      let tableRows: SQLRow[];

      if (ref.subquery) {
        const subResult = this.executeSelect(ref.subquery);
        if (!subResult.success || !subResult.resultSet) {
          throw new Error('Subquery failed');
        }
        tableRows = subResult.resultSet.rows;
      } else {
        const storage = this.getTableStorage(ref.table, ref.schema);
        if (!storage) {
          throw new Error(`Table '${ref.table}' does not exist`);
        }
        tableRows = storage.getAllRows();
      }

      // Add table alias prefix to column names
      const alias = ref.alias || ref.table;
      tableRows = tableRows.map(row => {
        const prefixedRow: SQLRow = {};
        for (const [key, value] of Object.entries(row)) {
          prefixedRow[key] = value;
          prefixedRow[`${alias}.${key}`] = value;
        }
        return prefixedRow;
      });

      if (i === 0) {
        result = tableRows;
      } else {
        // Handle joins
        result = this.joinRows(result, tableRows, ref);
      }
    }

    return result;
  }

  private joinRows(left: SQLRow[], right: SQLRow[], ref: TableReference): SQLRow[] {
    const joinType = ref.joinType || 'INNER';
    const result: SQLRow[] = [];

    if (joinType === 'CROSS') {
      // Cartesian product
      for (const leftRow of left) {
        for (const rightRow of right) {
          result.push({ ...leftRow, ...rightRow });
        }
      }
      return result;
    }

    const leftMatched = new Set<number>();
    const rightMatched = new Set<number>();

    for (let i = 0; i < left.length; i++) {
      const leftRow = left[i];
      let hasMatch = false;

      for (let j = 0; j < right.length; j++) {
        const rightRow = right[j];
        const combinedRow = { ...leftRow, ...rightRow };

        if (!ref.joinCondition || this.evaluateExpression(ref.joinCondition, combinedRow)) {
          result.push(combinedRow);
          leftMatched.add(i);
          rightMatched.add(j);
          hasMatch = true;
        }
      }

      // LEFT or FULL join: include unmatched left rows
      if (!hasMatch && (joinType === 'LEFT' || joinType === 'FULL')) {
        const nullRightRow: SQLRow = {};
        // Add null values for right table columns
        if (right.length > 0) {
          for (const key of Object.keys(right[0])) {
            nullRightRow[key] = null;
          }
        }
        result.push({ ...leftRow, ...nullRightRow });
      }
    }

    // RIGHT or FULL join: include unmatched right rows
    if (joinType === 'RIGHT' || joinType === 'FULL') {
      for (let j = 0; j < right.length; j++) {
        if (!rightMatched.has(j)) {
          const nullLeftRow: SQLRow = {};
          if (left.length > 0) {
            for (const key of Object.keys(left[0])) {
              nullLeftRow[key] = null;
            }
          }
          result.push({ ...nullLeftRow, ...right[j] });
        }
      }
    }

    return result;
  }

  evaluateExpression(expr: SQLExpression, row: SQLRow): SQLValue {
    switch (expr.type) {
      case 'LITERAL':
        return expr.value as SQLValue;

      case 'COLUMN_REF':
        // Try different variations of the column name
        const colName = expr.name!;
        const prefix = expr.alias;
        const upperColName = colName.toUpperCase();

        // Case-insensitive lookup with optional prefix
        for (const key of Object.keys(row)) {
          const upperKey = key.toUpperCase();
          if (prefix) {
            // Match "prefix.COLUMN" pattern
            const upperPrefix = prefix.toUpperCase();
            if (upperKey === `${upperPrefix}.${upperColName}`) {
              return row[key];
            }
          } else {
            // Match either exact column name or any prefix.column pattern
            if (upperKey === upperColName || upperKey.endsWith(`.${upperColName}`)) {
              return row[key];
            }
          }
        }

        return null;

      case 'BINARY_OP':
        const left = this.evaluateExpression(expr.left!, row);
        const right = this.evaluateExpression(expr.right!, row);
        return this.evaluateBinaryOp(expr.operator!, left, right);

      case 'UNARY_OP':
        const operand = this.evaluateExpression(expr.left!, row);
        if (expr.operator === '-') {
          return typeof operand === 'number' ? -operand : null;
        }
        return operand;

      case 'AND':
        return this.evaluateExpression(expr.left!, row) && this.evaluateExpression(expr.right!, row);

      case 'OR':
        return this.evaluateExpression(expr.left!, row) || this.evaluateExpression(expr.right!, row);

      case 'NOT':
        return !this.evaluateExpression(expr.left!, row);

      case 'IS_NULL':
        const isNullValue = this.evaluateExpression(expr.left!, row);
        const isNull = isNullValue === null || isNullValue === undefined;
        return expr.operator === 'IS NULL' ? isNull : !isNull;

      case 'IN':
        const inValue = this.evaluateExpression(expr.left!, row);
        const inList = expr.arguments!.map(arg => this.evaluateExpression(arg, row));
        return inList.some(item => this.sqlEquals(inValue, item));

      case 'IN_SUBQUERY':
        const inSubVal = this.evaluateExpression(expr.left!, row);
        // Execute the subquery and get the first column values
        const inSubResult = this.executeSelect(expr.subquery as any);
        if (!inSubResult.success || !inSubResult.resultSet) {
          return false;
        }
        const inSubValues = inSubResult.resultSet.rows.map(r => {
          // Get the first column value from each row
          const firstCol = inSubResult.resultSet!.columns[0];
          return r[firstCol];
        });
        return inSubValues.some(item => this.sqlEquals(inSubVal, item));

      case 'BETWEEN':
        const betweenValue = this.evaluateExpression(expr.left!, row) as number;
        const low = this.evaluateExpression(expr.arguments![0], row) as number;
        const high = this.evaluateExpression(expr.arguments![1], row) as number;
        return betweenValue >= low && betweenValue <= high;

      case 'LIKE':
        const likeValue = String(this.evaluateExpression(expr.left!, row) || '');
        const pattern = String(this.evaluateExpression(expr.right!, row) || '');
        return this.matchLike(likeValue, pattern);

      case 'FUNCTION_CALL':
        return this.evaluateFunction(expr.name!, expr.arguments || [], row);

      case 'CASE':
        return this.evaluateCase(expr, row);

      case 'CAST':
        const castValue = this.evaluateExpression(expr.left!, row);
        return this.castValue(castValue, expr.name!);

      case 'SUBQUERY':
        // Execute subquery and return first value
        const subResult = this.executeSelect(expr.value as SelectStatement);
        if (subResult.success && subResult.resultSet && subResult.resultSet.rows.length > 0) {
          const firstRow = subResult.resultSet.rows[0];
          const firstCol = subResult.resultSet.columns[0];
          return firstRow[firstCol];
        }
        return null;

      case 'EXISTS':
        const existsResult = this.executeSelect(expr.value as SelectStatement);
        return existsResult.success && existsResult.resultSet && existsResult.resultSet.rows.length > 0;

      default:
        return null;
    }
  }

  private evaluateBinaryOp(op: string, left: SQLValue, right: SQLValue): SQLValue {
    // Handle NULL comparisons
    if (left === null || right === null) {
      if (op === '=' || op === '<>' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=') {
        return null; // NULL comparison returns NULL, not true/false
      }
    }

    switch (op) {
      case '=':
        return this.sqlEquals(left, right);
      case '<>':
      case '!=':
        return !this.sqlEquals(left, right);
      case '<':
        return compareSQLValues(left, right) < 0;
      case '<=':
        return compareSQLValues(left, right) <= 0;
      case '>':
        return compareSQLValues(left, right) > 0;
      case '>=':
        return compareSQLValues(left, right) >= 0;
      case '+':
        if (typeof left === 'number' && typeof right === 'number') return left + right;
        return null;
      case '-':
        if (typeof left === 'number' && typeof right === 'number') return left - right;
        return null;
      case '*':
        if (typeof left === 'number' && typeof right === 'number') return left * right;
        return null;
      case '/':
        if (typeof left === 'number' && typeof right === 'number') {
          if (right === 0) return null;
          return left / right;
        }
        return null;
      case '%':
        if (typeof left === 'number' && typeof right === 'number') {
          if (right === 0) return null;
          return left % right;
        }
        return null;
      case '||':
        return String(left ?? '') + String(right ?? '');
      default:
        return null;
    }
  }

  private sqlEquals(a: SQLValue, b: SQLValue): boolean {
    if (a === null || b === null) return false;
    if (typeof a === 'string' && typeof b === 'string') {
      return a.toUpperCase() === b.toUpperCase();
    }
    return a === b;
  }

  private matchLike(value: string, pattern: string): boolean {
    // Convert SQL LIKE pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(value);
  }

  private evaluateFunction(name: string, args: SQLExpression[], row: SQLRow): SQLValue {
    const funcName = name.toUpperCase();
    const values = args.map(arg => this.evaluateExpression(arg, row));

    // Aggregate functions - these should be handled in GROUP BY processing
    // Here we handle them for single-row context
    switch (funcName) {
      case 'COUNT':
        if (values[0] === '*') return 1;
        return values[0] !== null ? 1 : 0;

      case 'SUM':
      case 'AVG':
      case 'MIN':
      case 'MAX':
        return values[0];

      // String functions
      case 'UPPER':
        return values[0] !== null ? String(values[0]).toUpperCase() : null;

      case 'LOWER':
        return values[0] !== null ? String(values[0]).toLowerCase() : null;

      case 'LENGTH':
      case 'LEN':
        return values[0] !== null ? String(values[0]).length : null;

      case 'SUBSTRING':
      case 'SUBSTR':
        if (values[0] === null) return null;
        const str = String(values[0]);
        const start = (values[1] as number) - 1; // SQL is 1-indexed
        const len = values[2] as number | undefined;
        return len !== undefined ? str.substring(start, start + len) : str.substring(start);

      case 'TRIM':
        return values[0] !== null ? String(values[0]).trim() : null;

      case 'LTRIM':
        return values[0] !== null ? String(values[0]).trimStart() : null;

      case 'RTRIM':
        return values[0] !== null ? String(values[0]).trimEnd() : null;

      case 'REPLACE':
        if (values[0] === null) return null;
        return String(values[0]).replace(new RegExp(String(values[1]), 'g'), String(values[2]));

      case 'CONCAT':
        return values.filter(v => v !== null).map(v => String(v)).join('');

      case 'COALESCE':
        return values.find(v => v !== null) ?? null;

      case 'NULLIF':
        return this.sqlEquals(values[0], values[1]) ? null : values[0];

      case 'IFNULL':
      case 'NVL':
        return values[0] !== null ? values[0] : values[1];

      // Numeric functions
      case 'ABS':
        return values[0] !== null ? Math.abs(values[0] as number) : null;

      case 'ROUND':
        if (values[0] === null) return null;
        const decimals = (values[1] as number) ?? 0;
        const multiplier = Math.pow(10, decimals);
        return Math.round((values[0] as number) * multiplier) / multiplier;

      case 'FLOOR':
        return values[0] !== null ? Math.floor(values[0] as number) : null;

      case 'CEIL':
      case 'CEILING':
        return values[0] !== null ? Math.ceil(values[0] as number) : null;

      case 'MOD':
        if (values[0] === null || values[1] === null) return null;
        return (values[0] as number) % (values[1] as number);

      case 'POWER':
      case 'POW':
        if (values[0] === null || values[1] === null) return null;
        return Math.pow(values[0] as number, values[1] as number);

      case 'SQRT':
        return values[0] !== null ? Math.sqrt(values[0] as number) : null;

      // Date functions
      case 'NOW':
      case 'CURRENT_TIMESTAMP':
      case 'SYSDATE':
        return new Date();

      case 'CURRENT_DATE':
        return new Date(new Date().toDateString());

      case 'YEAR':
        return values[0] instanceof Date ? values[0].getFullYear() : null;

      case 'MONTH':
        return values[0] instanceof Date ? values[0].getMonth() + 1 : null;

      case 'DAY':
        return values[0] instanceof Date ? values[0].getDate() : null;

      default:
        // Unknown function - return null
        return null;
    }
  }

  private evaluateCase(expr: SQLExpression, row: SQLRow): SQLValue {
    const caseData = expr.value as any;
    const whenClauses = caseData.whenClauses as { when: SQLExpression; then: SQLExpression }[];
    const elseExpr = caseData.elseExpr as SQLExpression | undefined;

    // Simple CASE vs Searched CASE
    const caseExpr = expr.left;

    for (const { when, then } of whenClauses) {
      let condition: boolean;
      if (caseExpr) {
        // Simple CASE: compare caseExpr with when value
        const caseValue = this.evaluateExpression(caseExpr, row);
        const whenValue = this.evaluateExpression(when, row);
        condition = this.sqlEquals(caseValue, whenValue);
      } else {
        // Searched CASE: evaluate when as boolean
        condition = !!this.evaluateExpression(when, row);
      }

      if (condition) {
        return this.evaluateExpression(then, row);
      }
    }

    if (elseExpr) {
      return this.evaluateExpression(elseExpr, row);
    }

    return null;
  }

  private castValue(value: SQLValue, targetType: string): SQLValue {
    if (value === null) return null;

    switch (targetType.toUpperCase()) {
      case 'INTEGER':
      case 'INT':
      case 'BIGINT':
      case 'SMALLINT':
        return parseInt(String(value), 10);

      case 'DECIMAL':
      case 'NUMERIC':
      case 'FLOAT':
      case 'DOUBLE':
      case 'REAL':
        return parseFloat(String(value));

      case 'VARCHAR':
      case 'CHAR':
      case 'TEXT':
        return String(value);

      case 'DATE':
      case 'TIMESTAMP':
      case 'DATETIME':
        return new Date(String(value));

      case 'BOOLEAN':
        return !!value;

      default:
        return value;
    }
  }

  private hasAggregateFunctions(columns: any[]): boolean {
    const aggregateFunctions = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];
    for (const col of columns) {
      if (col.all) continue;
      const expr = col.expression;
      if (expr && expr.type === 'FUNCTION_CALL' && aggregateFunctions.includes(expr.name?.toUpperCase())) {
        return true;
      }
    }
    return false;
  }

  private applyGroupBy(rows: SQLRow[], groupBy: SQLExpression[], columns: any[]): SQLRow[] {
    if (rows.length === 0) return rows;

    // Group rows by key
    const groups = new Map<string, SQLRow[]>();

    for (const row of rows) {
      const keyParts = groupBy.map(expr => JSON.stringify(this.evaluateExpression(expr, row)));
      const key = keyParts.join('|');

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(row);
    }

    // Process each group
    const result: SQLRow[] = [];
    for (const [, groupRows] of groups) {
      const aggregatedRow: SQLRow = {};

      // For each column in SELECT, compute aggregate or take first value
      for (const col of columns) {
        if (col.all) continue; // Skip *

        const expr = col.expression;
        const alias = col.alias || this.getExpressionName(expr);

        if (expr.type === 'FUNCTION_CALL') {
          aggregatedRow[alias] = this.computeAggregate(expr.name!, expr.arguments || [], groupRows);
        } else {
          // Non-aggregate: take first value
          aggregatedRow[alias] = this.evaluateExpression(expr, groupRows[0]);
        }
      }

      result.push(aggregatedRow);
    }

    return result;
  }

  private computeAggregate(funcName: string, args: SQLExpression[], rows: SQLRow[]): SQLValue {
    const name = funcName.toUpperCase();

    switch (name) {
      case 'COUNT':
        if (args.length === 0 || (args[0].type === 'LITERAL' && args[0].value === '*')) {
          return rows.length;
        }
        return rows.filter(row => this.evaluateExpression(args[0], row) !== null).length;

      case 'SUM':
        let sum = 0;
        for (const row of rows) {
          const val = this.evaluateExpression(args[0], row);
          if (typeof val === 'number') sum += val;
        }
        return sum;

      case 'AVG':
        let total = 0;
        let count = 0;
        for (const row of rows) {
          const val = this.evaluateExpression(args[0], row);
          if (typeof val === 'number') {
            total += val;
            count++;
          }
        }
        return count > 0 ? total / count : null;

      case 'MIN':
        let min: SQLValue = null;
        for (const row of rows) {
          const val = this.evaluateExpression(args[0], row);
          if (val !== null && (min === null || compareSQLValues(val, min) < 0)) {
            min = val;
          }
        }
        return min;

      case 'MAX':
        let max: SQLValue = null;
        for (const row of rows) {
          const val = this.evaluateExpression(args[0], row);
          if (val !== null && (max === null || compareSQLValues(val, max) > 0)) {
            max = val;
          }
        }
        return max;

      default:
        // Non-aggregate function: evaluate on first row
        return this.evaluateFunction(funcName, args, rows[0]);
    }
  }

  private applyOrderBy(rows: SQLRow[], orderBy: any[]): SQLRow[] {
    return [...rows].sort((a, b) => {
      for (const item of orderBy) {
        const aVal = this.evaluateExpression(item.expression, a);
        const bVal = this.evaluateExpression(item.expression, b);

        let cmp = compareSQLValues(aVal, bVal);

        // Handle NULLS FIRST/LAST
        if (aVal === null && bVal === null) cmp = 0;
        else if (aVal === null) cmp = item.nulls === 'FIRST' ? -1 : 1;
        else if (bVal === null) cmp = item.nulls === 'FIRST' ? 1 : -1;

        if (item.direction === 'DESC') cmp = -cmp;

        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  private applyDistinct(rows: SQLRow[], columns: any[]): SQLRow[] {
    const seen = new Set<string>();
    const result: SQLRow[] = [];

    for (const row of rows) {
      const key = columns.map(col => {
        if (col.all) return JSON.stringify(row);
        const val = this.evaluateExpression(col.expression, row);
        return JSON.stringify(val);
      }).join('|');

      if (!seen.has(key)) {
        seen.add(key);
        result.push(row);
      }
    }

    return result;
  }

  private projectColumns(rows: SQLRow[], selectColumns: any[]): { columns: string[]; columnTypes: SQLDataType[]; projectedRows: SQLRow[] } {
    const columns: string[] = [];
    const columnTypes: SQLDataType[] = [];
    const projectedRows: SQLRow[] = [];

    // Determine column names
    for (const col of selectColumns) {
      if (col.all) {
        // SELECT * - add all columns from first row
        if (rows.length > 0) {
          for (const key of Object.keys(rows[0])) {
            if (!key.includes('.')) { // Skip prefixed duplicates
              columns.push(key);
              columnTypes.push('VARCHAR');
            }
          }
        }
      } else {
        const alias = col.alias || this.getExpressionName(col.expression);
        columns.push(alias);
        columnTypes.push('VARCHAR'); // Simplified - would need type inference
      }
    }

    // Project rows
    for (const row of rows) {
      const projectedRow: SQLRow = {};

      let colIndex = 0;
      for (const col of selectColumns) {
        if (col.all) {
          for (const key of Object.keys(row)) {
            if (!key.includes('.')) {
              projectedRow[key] = row[key];
            }
          }
        } else {
          const colName = columns[colIndex];
          projectedRow[colName] = this.evaluateExpression(col.expression, row);
          colIndex++;
        }
      }

      projectedRows.push(projectedRow);
    }

    return { columns, columnTypes, projectedRows };
  }

  private getExpressionName(expr: SQLExpression): string {
    switch (expr.type) {
      case 'COLUMN_REF':
        return expr.alias ? `${expr.alias}.${expr.name}` : expr.name!;
      case 'FUNCTION_CALL':
        return `${expr.name}(...)`;
      case 'LITERAL':
        return String(expr.value);
      default:
        return 'EXPR';
    }
  }

  // Getters for inspection
  getCurrentSchema(): string {
    return this.currentSchema;
  }

  getCurrentUser(): string {
    return this.currentUser;
  }

  setCurrentUser(user: string): void {
    this.currentUser = user;
  }

  getUsers(): Map<string, SQLUser> {
    return this.users;
  }

  getRoles(): Map<string, Role> {
    return this.roles;
  }

  getPrivileges(): Privilege[] {
    return this.privileges;
  }

  getConfig(): DatabaseConfig {
    return this.config;
  }

  isInTransaction(): boolean {
    return this.inTransaction;
  }
}
