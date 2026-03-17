# PRD — Oracle DBMS Simulator Implementation

## Project Overview

Implementation of a realistic Oracle Database simulator within the Ubuntu Sandbox web application.
The simulator provides an in-browser Oracle 19c experience with SQL execution, data dictionary views,
instance management, and SQL*Plus command-line interface.

---

## Architecture

### Design Principles
- **OOP with Abstract Base Classes**: Shared `Base*` classes for reuse across future DBMS dialects (PostgreSQL, MySQL)
- **Recursive Descent Parser**: LL(1) parser with precedence climbing for expressions
- **In-Memory Storage**: All data stored in JavaScript Maps — no persistence layer needed
- **State Machine**: Oracle instance lifecycle (SHUTDOWN → NOMOUNT → MOUNT → OPEN)

### Component Diagram

```
┌─────────────────────────────────────────────────────┐
│                  LinuxTerminalSession                │
│               (sqlplus command interception)          │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   SQLPlusSession                     │
│  SET/SHOW commands, DESC, multi-line input, output   │
│  formatting, CONNECT, EXIT, column alignment         │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   OracleDatabase                     │
│            (Orchestrator / Entry Point)              │
│  Manages: Instance + Storage + Catalog + Executor    │
│  Connection management, SQL execution pipeline       │
└──────────────────────┬──────────────────────────────┘
          ┌────────────┼────────────┐
          │            │            │
    ┌─────▼─────┐ ┌───▼───┐ ┌─────▼─────┐
    │  Lexer    │ │Parser │ │ Executor  │
    │  (Oracle) │ │(Oracle)│ │ (Oracle)  │
    └─────┬─────┘ └───┬───┘ └─────┬─────┘
          │           │           │
    ┌─────▼───────────▼───────────▼──────────────────┐
    │              Shared Engine Layer                 │
    │  BaseLexer · BaseParser · BaseExecutor           │
    │  BaseStorage · BaseCatalog · DataType            │
    └─────────────────────────────────────────────────┘
```

---

## Implementation Progress

### Phase 1: Core Engine & Oracle Foundation — COMPLETE

| Component | File | Status | Tests |
|-----------|------|--------|-------|
| SQL Dialect Types | `src/database/engine/types/SQLDialect.ts` | Done | - |
| Database Error | `src/database/engine/types/DatabaseError.ts` | Done | - |
| Database Config | `src/database/engine/types/DatabaseConfig.ts` | Done | - |
| Token Types | `src/database/engine/lexer/Token.ts` | Done | 15 tests |
| Base Lexer | `src/database/engine/lexer/BaseLexer.ts` | Done | (via Oracle) |
| AST Node Types | `src/database/engine/parser/ASTNode.ts` | Done | - |
| Parser Error | `src/database/engine/parser/ParserError.ts` | Done | - |
| Base Parser | `src/database/engine/parser/BaseParser.ts` | Done | (via Oracle) |
| Result Set | `src/database/engine/executor/ResultSet.ts` | Done | - |
| Base Executor | `src/database/engine/executor/BaseExecutor.ts` | Done | - |
| Base Storage | `src/database/engine/storage/BaseStorage.ts` | Done | - |
| Base Catalog | `src/database/engine/catalog/BaseCatalog.ts` | Done | - |
| Data Type | `src/database/engine/catalog/DataType.ts` | Done | - |

### Phase 2: Oracle-Specific Implementation — COMPLETE

| Component | File | Status | Tests |
|-----------|------|--------|-------|
| Oracle Lexer | `src/database/oracle/OracleLexer.ts` | Done | 15 tests |
| Oracle Parser | `src/database/oracle/OracleParser.ts` | Done | 25 tests |
| Oracle Storage | `src/database/oracle/OracleStorage.ts` | Done | (via integration) |
| Oracle Instance | `src/database/oracle/OracleInstance.ts` | Done | (via integration) |
| Oracle Catalog | `src/database/oracle/OracleCatalog.ts` | Done | (via integration) |
| Oracle Executor | `src/database/oracle/OracleExecutor.ts` | Done | 55 tests |
| Oracle Database | `src/database/oracle/OracleDatabase.ts` | Done | (orchestrator) |

### Phase 3: User Interface & Integration — COMPLETE

| Component | File | Status | Tests |
|-----------|------|--------|-------|
| SQL*Plus Session | `src/database/oracle/commands/SQLPlusSession.ts` | Done | 5 tests |
| Demo Schemas | `src/database/oracle/demo/DemoSchemas.ts` | Done | 2 tests |
| Terminal Integration | `src/terminal/sessions/LinuxTerminalSession.ts` | Done | - |
| Terminal View Update | `src/components/terminal/TerminalView.tsx` | Done | - |
| Database Commands | `src/terminal/commands/database.ts` | Done | - |

### Phase 3b: Advanced SQL Features — COMPLETE

| Component | File | Status | Tests |
|-----------|------|--------|-------|
| Advanced Tests (TDD) | `src/__tests__/unit/database/oracle-advanced.test.ts` | Done | 44 tests |
| JOIN execution | `src/database/oracle/OracleExecutor.ts` | Done | (via advanced) |
| GROUP BY + Aggregates | `src/database/oracle/OracleExecutor.ts` | Done | (via advanced) |
| HAVING clause | `src/database/oracle/OracleExecutor.ts` | Done | (via advanced) |
| Set operations | `src/database/oracle/OracleExecutor.ts` | Done | (via advanced) |
| Subqueries (IN, EXISTS, scalar) | `src/database/oracle/OracleExecutor.ts` | Done | (via advanced) |
| ALTER TABLE MODIFY | `src/database/oracle/OracleExecutor.ts` | Done | (via advanced) |

### Test Summary

- **Total Oracle Tests**: 139 passing
  - Lexer: 15 tests (tokenization, keywords, operators, positions)
  - Parser: 31 tests (SELECT, DML, DDL, DCL, Oracle syntax, expressions)
  - Database Integration: 49 tests (DUAL, DDL, DML, WHERE, ORDER BY, functions, catalog, users, connections, demo schemas, SQL*Plus)
  - Advanced: 44 tests (JOINs, GROUP BY, aggregates, HAVING, set operations, subqueries, ALTER TABLE MODIFY, advanced expressions)
- **TypeScript**: Clean compilation (`tsc --noEmit` passes)
- **Existing Tests**: No regressions

---

## Feature Coverage

### SQL Statements
- **SELECT**: columns, aliases, *, DISTINCT, FROM, JOIN (INNER/LEFT/RIGHT/FULL/CROSS — fully executed), WHERE, GROUP BY (with aggregates), HAVING, ORDER BY, FETCH FIRST, FOR UPDATE, set operations (UNION/UNION ALL/INTERSECT/MINUS — fully executed), subqueries (IN subquery, EXISTS/NOT EXISTS, correlated, scalar in SELECT and WHERE), WITH (CTE)
- **INSERT**: VALUES, column list, INSERT...SELECT
- **UPDATE**: SET assignments, WHERE
- **DELETE**: WHERE
- **CREATE**: TABLE, INDEX, SEQUENCE, VIEW, USER, ROLE, TABLESPACE
- **ALTER**: TABLE (ADD/DROP/MODIFY COLUMN), USER (IDENTIFIED BY), SYSTEM, DATABASE
- **DROP**: TABLE, INDEX, SEQUENCE, VIEW, USER, ROLE, TABLESPACE
- **TRUNCATE**: TABLE
- **GRANT/REVOKE**: System privileges, table privileges, roles
- **COMMIT/ROLLBACK/SAVEPOINT**
- **STARTUP/SHUTDOWN**: Instance state management

### Oracle Functions (40+)
UPPER, LOWER, LENGTH, SUBSTR, INSTR, REPLACE, TRIM, LTRIM, RTRIM, LPAD, RPAD, NVL, NVL2, DECODE, COALESCE, NULLIF, TO_CHAR, TO_NUMBER, TO_DATE, ROUND, TRUNC, MOD, ABS, CEIL, FLOOR, SIGN, POWER, SQRT, GREATEST, LEAST, COUNT, SUM, AVG, MIN, MAX, CONCAT, INITCAP, REVERSE, SYSDATE, SYSTIMESTAMP, USER

### Data Dictionary Views
- **V$ Views**: V$VERSION, V$INSTANCE, V$DATABASE, V$SESSION, V$PARAMETER, V$SGA, V$TABLESPACE, V$DATAFILE, V$LOG, V$LOGFILE, V$PROCESS, V$CONTROLFILE, V$DIAG_INFO
- **DBA_ Views**: DBA_USERS, DBA_ROLES, DBA_ROLE_PRIVS, DBA_SYS_PRIVS, DBA_TABLES, DBA_TAB_COLUMNS, DBA_OBJECTS, DBA_TABLESPACES, DBA_DATA_FILES, DBA_INDEXES, DBA_CONSTRAINTS, DBA_SEQUENCES
- **ALL_/USER_ Views**: Automatically derived from DBA_ views with user filtering
- **DICTIONARY View**: Lists all available views

### SQL*Plus Features
- `SQL>` prompt with multi-line input (terminated by `;`)
- `/` to re-execute last statement
- SET commands: LINESIZE, PAGESIZE, SERVEROUTPUT, FEEDBACK, TIMING, HEADING, ECHO, AUTOCOMMIT, COLSEP, NULL, WRAP, UNDERLINE, SQLPROMPT
- SHOW commands: USER, LINESIZE, PAGESIZE, SGA, PARAMETER, ALL, ERRORS
- DESC/DESCRIBE table
- CONNECT user/password [AS SYSDBA]
- EXIT/QUIT
- HELP
- Column-formatted output with headers and separators
- Page breaks based on PAGESIZE

### Demo Schemas

#### HR Schema (Human Resources)
- REGIONS (4 rows), COUNTRIES (10 rows), LOCATIONS (8 rows)
- DEPARTMENTS (11 rows), JOBS (19 rows), EMPLOYEES (20 rows)
- JOB_HISTORY (5 rows)
- Sequences: EMPLOYEES_SEQ, DEPARTMENTS_SEQ, LOCATIONS_SEQ

#### SCOTT Schema (Classic)
- DEPT (4 rows): DEPTNO, DNAME, LOC
- EMP (14 rows): EMPNO, ENAME, JOB, MGR, HIREDATE, SAL, COMM, DEPTNO
- BONUS, SALGRADE (5 rows)

### Default Users
| Username | Password | Role |
|----------|----------|------|
| SYS | oracle | DBA (SYSDBA) |
| SYSTEM | oracle | DBA |
| HR | hr | CONNECT, RESOURCE |
| SCOTT | tiger | CONNECT, RESOURCE |
| DBSNMP | dbsnmp | SELECT_CATALOG_ROLE |

---

## Future Phases (Planned)

### Phase 4: Advanced Oracle Features
- PL/SQL blocks (BEGIN...END)
- Stored procedures and functions
- Packages
- Triggers
- Cursors
- Exception handling

### Phase 5: Listener & Network
- `lsnrctl` command (start, stop, status)
- `tnsping` command
- tnsnames.ora configuration
- listener.ora configuration

### Phase 6: Additional DBMS Dialects
- PostgreSQL (reuse BaseLexer/BaseParser/BaseStorage)
- MySQL (reuse BaseLexer/BaseParser/BaseStorage)
- SQL Server (future consideration)

---

## File Structure

```
src/database/
├── engine/                         # Shared SQL engine (dialect-agnostic)
│   ├── catalog/
│   │   ├── BaseCatalog.ts         # Abstract user/role/privilege management
│   │   └── DataType.ts           # SQL type descriptors and Oracle type factories
│   ├── executor/
│   │   ├── BaseExecutor.ts       # Abstract statement executor
│   │   └── ResultSet.ts          # Query result container
│   ├── lexer/
│   │   ├── BaseLexer.ts          # Abstract single-pass tokenizer
│   │   └── Token.ts              # Token types and SQL keywords
│   ├── parser/
│   │   ├── ASTNode.ts            # 60+ AST node interfaces
│   │   ├── BaseParser.ts         # Recursive descent parser (~1500 lines)
│   │   └── ParserError.ts        # Parser error with position
│   ├── storage/
│   │   └── BaseStorage.ts        # In-memory table/row/index/sequence storage
│   └── types/
│       ├── DatabaseConfig.ts     # Configuration interfaces
│       ├── DatabaseError.ts      # Error classes (OracleError)
│       └── SQLDialect.ts         # Dialect type union
│
├── oracle/                        # Oracle-specific implementations
│   ├── OracleLexer.ts            # 200+ Oracle keywords
│   ├── OracleParser.ts           # CONNECT BY, STARTUP, ALTER SYSTEM
│   ├── OracleStorage.ts          # Tablespace management, DUAL table
│   ├── OracleInstance.ts         # State machine, SGA, background processes
│   ├── OracleCatalog.ts          # V$ views, DBA_ views, authentication
│   ├── OracleExecutor.ts         # Full SQL execution engine
│   ├── OracleDatabase.ts         # Orchestrator
│   ├── commands/
│   │   └── SQLPlusSession.ts     # SQL*Plus CLI emulation
│   └── demo/
│       └── DemoSchemas.ts        # HR and SCOTT sample data
│
src/terminal/
├── commands/
│   └── database.ts               # Oracle instance management per device
├── sessions/
│   └── LinuxTerminalSession.ts   # sqlplus command interception
└── sql/oracle/
    └── sqlplus.ts                # Re-exports (backward compat)

src/__tests__/unit/database/
├── oracle-lexer.test.ts          # 15 lexer tests
├── oracle-parser.test.ts         # 31 parser tests
├── oracle-database.test.ts       # 49 integration tests
└── oracle-advanced.test.ts       # 44 advanced TDD tests (JOINs, GROUP BY, subqueries, etc.)
```
