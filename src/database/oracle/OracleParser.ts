/**
 * OracleParser — SQL parser for Oracle dialect.
 *
 * Extends BaseParser with Oracle-specific syntax:
 *   - CONNECT BY / START WITH (hierarchical queries)
 *   - STARTUP / SHUTDOWN
 *   - ALTER SYSTEM / ALTER DATABASE
 *   - CREATE TABLESPACE
 *   - Oracle outer join (+)
 */

import { TokenType } from '../engine/lexer/Token';
import { BaseParser } from '../engine/parser/BaseParser';
import type {
  Statement, ConnectByClause, StartupStatement, ShutdownStatement,
  AlterSystemStatement, AlterDatabaseStatement,
  CreateTablespaceStatement, DropTablespaceStatement,
} from '../engine/parser/ASTNode';
import type { SourcePosition } from '../engine/lexer/Token';

export class OracleParser extends BaseParser {

  // ── CONNECT BY / START WITH ───────────────────────────────────────

  protected override parseConnectByClause(): ConnectByClause | null {
    const pos = this.current().position;

    if (this.matchKeyword('START')) {
      this.expectKeyword('WITH');
      const startWith = this.parseExpression();
      this.expectKeyword('CONNECT');
      this.expectKeyword('BY');
      const noCycle = this.matchKeyword('NOCYCLE');
      const condition = this.parseExpression();
      return { type: 'ConnectByClause', position: pos, condition, noCycle, startWith };
    }

    if (this.matchKeyword('CONNECT')) {
      this.expectKeyword('BY');
      const noCycle = this.matchKeyword('NOCYCLE');
      const condition = this.parseExpression();
      let startWith = undefined;
      if (this.matchKeyword('START')) {
        this.expectKeyword('WITH');
        startWith = this.parseExpression();
      }
      return { type: 'ConnectByClause', position: pos, condition, noCycle, startWith };
    }

    return null;
  }

  // ── Dialect-specific statements ───────────────────────────────────

  protected override parseDialectStatement(): Statement | null {
    const token = this.current();
    if (token.type !== TokenType.KEYWORD) return null;

    switch (token.value) {
      case 'STARTUP': return this.parseStartup();
      case 'SHUTDOWN': return this.parseShutdown();
    }
    return null;
  }

  protected override parseDialectCreate(pos: SourcePosition, _orReplace: boolean): Statement | null {
    if (this.matchKeyword('TABLESPACE')) return this.parseCreateTablespace(pos);
    if (this.matchKeyword('TEMPORARY')) {
      this.expectKeyword('TABLESPACE');
      return this.parseCreateTablespace(pos, true);
    }
    if (this.matchKeyword('UNDO')) {
      this.expectKeyword('TABLESPACE');
      return this.parseCreateTablespace(pos, false, true);
    }
    return null;
  }

  protected override parseDialectAlter(pos: SourcePosition): Statement | null {
    if (this.matchKeyword('SYSTEM')) return this.parseAlterSystem(pos);
    if (this.matchKeyword('DATABASE')) return this.parseAlterDatabase(pos);
    return null;
  }

  protected override parseDialectDrop(pos: SourcePosition): Statement | null {
    if (this.matchKeyword('TABLESPACE')) return this.parseDropTablespace(pos);
    return null;
  }

  // ── STARTUP ───────────────────────────────────────────────────────

  private parseStartup(): StartupStatement {
    const pos = this.current().position;
    this.expectKeyword('STARTUP');
    let mode: StartupStatement['mode'];
    if (this.matchKeyword('NOMOUNT')) mode = 'NOMOUNT';
    else if (this.matchKeyword('MOUNT')) mode = 'MOUNT';
    else if (this.matchKeyword('RESTRICT')) mode = 'RESTRICT';
    else if (this.matchKeyword('FORCE')) mode = 'FORCE';
    return { type: 'StartupStatement', position: pos, mode };
  }

  // ── SHUTDOWN ──────────────────────────────────────────────────────

  private parseShutdown(): ShutdownStatement {
    const pos = this.current().position;
    this.expectKeyword('SHUTDOWN');
    let mode: ShutdownStatement['mode'];
    if (this.matchKeyword('IMMEDIATE')) mode = 'IMMEDIATE';
    else if (this.matchKeyword('ABORT')) mode = 'ABORT';
    else if (this.matchKeyword('TRANSACTIONAL')) mode = 'TRANSACTIONAL';
    else if (this.matchKeyword('NORMAL')) mode = 'NORMAL';
    return { type: 'ShutdownStatement', position: pos, mode };
  }

  // ── ALTER SYSTEM ──────────────────────────────────────────────────

  private parseAlterSystem(pos: SourcePosition): AlterSystemStatement {
    // ALTER SYSTEM SET param = value [SCOPE = ...]
    // ALTER SYSTEM FLUSH SHARED_POOL / BUFFER_CACHE
    // ALTER SYSTEM SWITCH LOGFILE
    // ALTER SYSTEM CHECKPOINT
    if (this.matchKeyword('SET')) {
      const parameter = this.expectIdentifier();
      this.expect(TokenType.COMPARISON_OP, '=');
      // Value can be string, number, or identifier
      let value: string;
      if (this.check(TokenType.STRING_LITERAL)) {
        const raw = this.advance().value;
        value = raw.slice(1, -1);
      } else if (this.check(TokenType.NUMBER_LITERAL)) {
        value = this.advance().value;
      } else {
        value = this.expectIdentifier();
      }
      let scope: AlterSystemStatement['scope'];
      if (this.matchKeyword('SCOPE')) {
        this.expect(TokenType.COMPARISON_OP, '=');
        const s = this.expectIdentifier().toUpperCase();
        if (s === 'MEMORY' || s === 'SPFILE' || s === 'BOTH') scope = s;
      }
      return { type: 'AlterSystemStatement', position: pos, action: 'SET', parameter, value, scope };
    }
    if (this.matchKeyword('FLUSH')) {
      const target = this.expectIdentifier();
      return { type: 'AlterSystemStatement', position: pos, action: 'FLUSH', parameter: target };
    }
    if (this.matchKeyword('SWITCH')) {
      this.expectKeyword('LOGFILE');
      return { type: 'AlterSystemStatement', position: pos, action: 'SWITCH LOGFILE' };
    }
    if (this.matchKeyword('CHECKPOINT')) {
      return { type: 'AlterSystemStatement', position: pos, action: 'CHECKPOINT' };
    }
    throw this.error('Unsupported ALTER SYSTEM action');
  }

  // ── ALTER DATABASE ────────────────────────────────────────────────

  private parseAlterDatabase(pos: SourcePosition): AlterDatabaseStatement {
    if (this.matchKeyword('OPEN')) {
      const readOnly = this.matchKeyword('READ') ? (this.expectKeyword('ONLY'), true) : false;
      return { type: 'AlterDatabaseStatement', position: pos, action: 'OPEN', details: readOnly ? 'READ ONLY' : undefined };
    }
    if (this.matchKeyword('MOUNT')) {
      return { type: 'AlterDatabaseStatement', position: pos, action: 'MOUNT' };
    }
    if (this.matchKeyword('ARCHIVELOG')) {
      return { type: 'AlterDatabaseStatement', position: pos, action: 'ARCHIVELOG' };
    }
    if (this.matchKeyword('NOARCHIVELOG')) {
      return { type: 'AlterDatabaseStatement', position: pos, action: 'NOARCHIVELOG' };
    }
    // Generic fallback
    let action = '';
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      action += this.advance().value + ' ';
    }
    return { type: 'AlterDatabaseStatement', position: pos, action: action.trim() };
  }

  // ── CREATE TABLESPACE ─────────────────────────────────────────────

  private parseCreateTablespace(pos: SourcePosition, temporary: boolean = false, undo: boolean = false): CreateTablespaceStatement {
    const name = this.expectIdentifier();
    const fileKeyword = temporary ? 'TEMPFILE' : 'DATAFILE';
    let datafile = '';
    let size = '';
    let autoextend: CreateTablespaceStatement['autoextend'];

    if (this.matchKeyword(fileKeyword)) {
      if (this.check(TokenType.STRING_LITERAL)) {
        const raw = this.advance().value;
        datafile = raw.slice(1, -1);
      }
      if (this.matchKeyword('SIZE')) {
        size = this.advance().value;
        // Allow size suffixes: 100M, 2G, etc.
        if (this.check(TokenType.IDENTIFIER)) size += this.advance().value;
      }
      if (this.matchKeyword('AUTOEXTEND')) {
        if (this.matchKeyword('ON')) {
          let next: string | undefined;
          let maxSize: string | undefined;
          if (this.matchKeyword('NEXT')) {
            next = this.advance().value;
            if (this.check(TokenType.IDENTIFIER)) next += this.advance().value;
          }
          if (this.matchKeyword('MAXSIZE')) {
            if (this.matchKeyword('UNLIMITED')) maxSize = 'UNLIMITED';
            else {
              maxSize = this.advance().value;
              if (this.check(TokenType.IDENTIFIER)) maxSize += this.advance().value;
            }
          }
          autoextend = { on: true, next, maxSize };
        } else {
          this.matchKeyword('OFF');
          autoextend = { on: false };
        }
      }
    }

    // Consume remaining clauses (EXTENT MANAGEMENT, SEGMENT SPACE, etc.) — skip for now
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      this.advance();
    }

    return {
      type: 'CreateTablespaceStatement', position: pos,
      name, temporary: temporary || undefined, undo: undo || undefined,
      datafile, size, autoextend,
    };
  }

  // ── DROP TABLESPACE ───────────────────────────────────────────────

  private parseDropTablespace(pos: SourcePosition): DropTablespaceStatement {
    const name = this.expectIdentifier();
    let includeContents = false;
    let includeDatafiles = false;
    if (this.matchKeyword('INCLUDING')) {
      this.expectKeyword('CONTENTS');
      includeContents = true;
      if (this.matchKeyword('AND')) {
        this.expectKeyword('DATAFILES');
        includeDatafiles = true;
      }
    }
    return {
      type: 'DropTablespaceStatement', position: pos, name,
      includeContents: includeContents || undefined,
      includeDatafiles: includeDatafiles || undefined,
    };
  }
}
