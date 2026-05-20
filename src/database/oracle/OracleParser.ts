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
  MergeStatement, Expression, SetTransactionStatement,
  AuditStatement, NoauditStatement,
} from '../engine/parser/ASTNode';
import type { SourcePosition } from '../engine/lexer/Token';

export class OracleParser extends BaseParser {

  // ── PRIOR as unary operator ──────────────────────────────────────

  protected override parseUnary(): Expression {
    if (this.checkKeyword('PRIOR')) {
      const pos = this.current().position;
      this.advance();
      const operand = this.parseUnary();
      return { type: 'UnaryExpr', position: pos, operator: 'PRIOR', operand };
    }
    return super.parseUnary();
  }

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
      case 'MERGE': return this.parseMerge();
      case 'EXPLAIN': return this.parseExplainPlan();
      case 'AUDIT': return this.parseAudit();
      case 'NOAUDIT': return this.parseNoaudit();
      case 'ADMINISTER': return this.parseAdministerKeyManagement();
    }
    return null;
  }

  /**
   * `ADMINISTER KEY MANAGEMENT <operation> …` — Transparent Data
   * Encryption administration. Real Oracle accepts a small grammar
   * built from CREATE / OPEN / CLOSE / SET / BACKUP / EXPORT / IMPORT
   * verbs operating on keystores and master keys. The parser captures
   * just enough to execute the operation; freeform clauses (e.g.
   * `WITH BACKUP`, `TO 'path'`) are surfaced on the AST node.
   */
  private parseAdministerKeyManagement(): import('../engine/parser/ASTNode').AdministerKeyManagementStatement {
    const pos = this.current().position;
    this.expectKeyword('ADMINISTER');
    this.expectIdentifierOrKeyword(); // KEY
    this.expectIdentifierOrKeyword(); // MANAGEMENT

    let operation: import('../engine/parser/ASTNode').AdministerKeyManagementStatement['operation'] = 'CREATE_KEYSTORE';
    let location: string | undefined;
    let toLocation: string | undefined;
    let password: string | undefined;
    let tag: string | undefined;
    let backupId: string | undefined;
    let withBackup = false;

    const peek = (): string => this.current().value.toUpperCase();

    if (this.matchKeyword('CREATE')) {
      if (this.matchKeyword('AUTO_LOGIN')) {
        this.expectKeyword('KEYSTORE');
        this.expectKeyword('FROM');
        this.expectKeyword('KEYSTORE');
        location = this.expectIdentifierOrString();
        operation = 'CREATE_AUTO_LOGIN_KEYSTORE';
      } else {
        this.matchKeyword('LOCAL');
        this.expectKeyword('KEYSTORE');
        location = this.expectIdentifierOrString();
        operation = 'CREATE_KEYSTORE';
      }
    } else if (this.matchKeyword('SET')) {
      if (this.matchKeyword('KEYSTORE')) {
        if (this.matchKeyword('OPEN')) operation = 'OPEN_KEYSTORE';
        else if (this.matchKeyword('CLOSE')) operation = 'CLOSE_KEYSTORE';
        else operation = 'OPEN_KEYSTORE';
      } else if (this.matchKeyword('KEY')) {
        operation = 'SET_KEY';
        if (this.matchKeyword('USING')) {
          this.expectKeyword('TAG');
          tag = this.expectIdentifierOrString();
        }
      }
    } else if (this.matchKeyword('BACKUP')) {
      this.expectKeyword('KEYSTORE');
      operation = 'BACKUP_KEYSTORE';
      if (this.matchKeyword('USING')) backupId = this.expectIdentifierOrString();
    } else if (this.matchKeyword('MERGE')) {
      this.expectKeyword('KEYSTORE');
      operation = 'MERGE_KEYSTORE';
      location = this.expectIdentifierOrString();
    } else if (this.matchKeyword('EXPORT')) {
      this.expectKeyword('KEYS');
      operation = 'EXPORT_KEYS';
    } else if (this.matchKeyword('IMPORT')) {
      this.expectKeyword('KEYS');
      operation = 'IMPORT_KEYS';
    }

    // Tail clauses: IDENTIFIED BY "<pwd>", TO '<path>', WITH BACKUP — order is free.
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('IDENTIFIED')) {
        this.expectKeyword('BY');
        password = this.expectIdentifierOrString();
      } else if (this.matchKeyword('TO')) {
        toLocation = this.expectIdentifierOrString();
      } else if (this.matchKeyword('WITH')) {
        this.expectKeyword('BACKUP');
        withBackup = true;
      } else if (this.matchKeyword('USING')) {
        // Some variants place USING here (CREATE AUTO_LOGIN ... USING tag).
        if (peek() === 'TAG') { this.advance(); tag = this.expectIdentifierOrString(); }
        else backupId = this.expectIdentifierOrString();
      } else if (this.matchKeyword('FORCE') || this.matchKeyword('KEYSTORE')
                 || this.matchKeyword('CONTAINER')) {
        // Tolerated keyword chatter — consume the value if any.
        if (peek() === '=') this.advance();
        if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.STRING_LITERAL)) this.advance();
      } else {
        // Unknown trailing token — swallow to keep the parser robust.
        this.advance();
      }
    }

    return {
      type: 'AdministerKeyManagementStatement', position: pos,
      operation, location, toLocation, password, tag, backupId, withBackup,
    };
  }

  // ── MERGE ────────────────────────────────────────────────────────

  private parseMerge(): MergeStatement {
    const pos = this.current().position;
    this.expectKeyword('MERGE');
    this.expectKeyword('INTO');

    // Target table
    const targetSchema = this.parseSchemaPrefix();
    const targetName = this.expectIdentifier();
    const targetAlias = this.parseOptionalAlias();
    const target = {
      type: 'TableRef' as const, position: pos,
      schema: targetSchema, name: targetName, alias: targetAlias,
    };

    this.expectKeyword('USING');
    const sourceSchema = this.parseSchemaPrefix();
    const sourceName = this.expectIdentifier();
    const sourceAlias = this.parseOptionalAlias();
    const source = {
      type: 'TableRef' as const, position: pos,
      schema: sourceSchema, name: sourceName, alias: sourceAlias,
    };

    this.expectKeyword('ON');
    this.expect(TokenType.LPAREN);
    const on = this.parseExpression();
    this.expect(TokenType.RPAREN);

    let whenMatched: MergeStatement['whenMatched'];
    let whenNotMatched: MergeStatement['whenNotMatched'];

    // WHEN MATCHED / WHEN NOT MATCHED (in any order)
    for (let i = 0; i < 2; i++) {
      if (!this.checkKeyword('WHEN')) break;
      this.advance(); // WHEN

      if (this.matchKeyword('MATCHED')) {
        this.expectKeyword('THEN');
        this.expectKeyword('UPDATE');
        this.expectKeyword('SET');

        const assignments: import('../engine/parser/ASTNode').Assignment[] = [];
        do {
          // Parse qualified column: t.col = s.col or col = value
          let colName: string;
          const id1 = this.expectIdentifier();
          if (this.match(TokenType.DOT)) {
            colName = this.expectIdentifier();
          } else {
            colName = id1;
          }
          this.expect(TokenType.COMPARISON_OP, '=');
          const value = this.parseExpression();
          assignments.push({ type: 'Assignment', position: pos, column: colName, value });
        } while (this.match(TokenType.COMMA));

        whenMatched = { assignments };
      } else if (this.matchKeyword('NOT')) {
        this.expectKeyword('MATCHED');
        this.expectKeyword('THEN');
        this.expectKeyword('INSERT');

        this.expect(TokenType.LPAREN);
        const columns: string[] = [];
        do { columns.push(this.expectIdentifier()); } while (this.match(TokenType.COMMA));
        this.expect(TokenType.RPAREN);

        this.expectKeyword('VALUES');
        this.expect(TokenType.LPAREN);
        const values: Expression[] = [];
        do { values.push(this.parseExpression()); } while (this.match(TokenType.COMMA));
        this.expect(TokenType.RPAREN);

        whenNotMatched = { columns, values };
      }
    }

    return { type: 'MergeStatement', position: pos, target, source, on, whenMatched, whenNotMatched };
  }

  private parseSchemaPrefix(): string | undefined {
    // Look ahead for schema.name pattern
    if (this.check(TokenType.IDENTIFIER) && this.peekNext()?.type === TokenType.DOT) {
      const schema = this.advance().value;
      this.advance(); // consume .
      return schema;
    }
    return undefined;
  }

  private parseOptionalAlias(): string | undefined {
    // Check for alias (optional AS keyword)
    if (this.checkKeyword('ON') || this.checkKeyword('USING') || this.checkKeyword('WHEN') ||
        this.check(TokenType.SEMICOLON) || this.check(TokenType.EOF) ||
        this.check(TokenType.LPAREN)) {
      return undefined;
    }
    if (this.matchKeyword('AS')) {
      return this.expectIdentifier();
    }
    if (this.check(TokenType.IDENTIFIER)) {
      return this.advance().value;
    }
    return undefined;
  }

  protected override parseDialectCreate(pos: SourcePosition, orReplace: boolean): Statement | null {
    if (this.matchKeyword('TABLESPACE')) return this.parseCreateTablespace(pos);
    if (this.matchKeyword('BIGFILE') || this.matchKeyword('SMALLFILE')) {
      // BIGFILE / SMALLFILE are pure metadata hints; treat as a plain
      // CREATE TABLESPACE (the simulator doesn't enforce file-count limits).
      if (this.matchKeyword('TEMPORARY')) {
        this.expectKeyword('TABLESPACE');
        return this.parseCreateTablespace(pos, true);
      }
      if (this.matchKeyword('UNDO')) {
        this.expectKeyword('TABLESPACE');
        return this.parseCreateTablespace(pos, false, true);
      }
      this.expectKeyword('TABLESPACE');
      return this.parseCreateTablespace(pos);
    }
    if (this.matchKeyword('TEMPORARY')) {
      this.expectKeyword('TABLESPACE');
      return this.parseCreateTablespace(pos, true);
    }
    if (this.matchKeyword('UNDO')) {
      this.expectKeyword('TABLESPACE');
      return this.parseCreateTablespace(pos, false, true);
    }
    if (this.matchKeyword('PFILE')) return this.parseCreatePfileOrSpfile(pos, 'PFILE');
    if (this.matchKeyword('SPFILE')) return this.parseCreatePfileOrSpfile(pos, 'SPFILE');
    if (this.matchKeyword('DISKGROUP')) return this.parseCreateDiskgroup(pos);
    if (this.matchKeyword('TRIGGER')) return this.parseCreateTrigger(pos, orReplace);
    if (this.matchKeyword('SYNONYM')) return this.parseCreateSynonym(pos, orReplace, false);
    if (this.matchKeyword('PUBLIC')) {
      if (this.matchKeyword('SYNONYM')) return this.parseCreateSynonym(pos, orReplace, true);
      if (this.matchKeyword('DATABASE')) { this.expectKeyword('LINK'); return this.parseCreateDbLink(pos, true); }
    }
    if (this.matchKeyword('DATABASE')) { this.expectKeyword('LINK'); return this.parseCreateDbLink(pos, false); }
    if (this.matchKeyword('MATERIALIZED')) { this.expectKeyword('VIEW'); return this.parseCreateMaterializedView(pos, orReplace); }
    if (this.matchKeyword('AUDIT')) {
      this.expectKeyword('POLICY');
      return this.parseCreateAuditPolicy(pos);
    }
    return null;
  }

  protected override parseDialectAlter(pos: SourcePosition): Statement | null {
    if (this.matchKeyword('SYSTEM')) return this.parseAlterSystem(pos);
    if (this.matchKeyword('DATABASE')) return this.parseAlterDatabase(pos);
    if (this.matchKeyword('SEQUENCE')) return this.parseAlterSequence(pos);
    if (this.matchKeyword('INDEX')) return this.parseAlterIndex(pos);
    if (this.matchKeyword('TABLESPACE')) return this.parseAlterTablespace(pos);
    if (this.matchKeyword('DISKGROUP')) return this.parseAlterDiskgroup(pos);
    return null;
  }

  /**
   * CREATE PFILE[=path] FROM SPFILE[=path]
   * CREATE PFILE[=path] FROM MEMORY
   * CREATE SPFILE[=path] FROM PFILE[=path]
   * CREATE SPFILE[=path] FROM MEMORY
   */
  private parseCreatePfileOrSpfile(
    pos: SourcePosition,
    target: 'PFILE' | 'SPFILE',
  ): import('../engine/parser/ASTNode').CreatePfileSpfileStatement {
    const readQuoted = (): string => {
      const raw = this.advance().value;
      return raw.startsWith("'") ? raw.slice(1, -1) : raw;
    };
    let outputPath: string | undefined;
    if (this.match(TokenType.COMPARISON_OP, '=')) outputPath = readQuoted();
    this.expectKeyword('FROM');
    let source: 'PFILE' | 'SPFILE' | 'MEMORY';
    let sourcePath: string | undefined;
    if (this.matchKeyword('MEMORY')) source = 'MEMORY';
    else if (this.matchKeyword('PFILE')) {
      source = 'PFILE';
      if (this.match(TokenType.COMPARISON_OP, '=')) sourcePath = readQuoted();
    } else {
      this.expectKeyword('SPFILE');
      source = 'SPFILE';
      if (this.match(TokenType.COMPARISON_OP, '=')) sourcePath = readQuoted();
    }
    return {
      type: 'CreatePfileSpfileStatement', position: pos,
      target, outputPath, source, sourcePath,
    };
  }

  // ── CREATE / ALTER / DROP DISKGROUP ──────────────────────────────

  private parseCreateDiskgroup(pos: SourcePosition): import('../engine/parser/ASTNode').CreateDiskgroupStatement {
    const name = this.expectIdentifier();
    let redundancy: 'EXTERNAL' | 'NORMAL' | 'HIGH' = 'EXTERNAL';
    if (this.matchKeyword('EXTERNAL')) { redundancy = 'EXTERNAL'; this.matchKeyword('REDUNDANCY'); }
    else if (this.matchKeyword('NORMAL')) { redundancy = 'NORMAL'; this.matchKeyword('REDUNDANCY'); }
    else if (this.matchKeyword('HIGH')) { redundancy = 'HIGH'; this.matchKeyword('REDUNDANCY'); }
    else if (this.matchKeyword('REDUNDANCY')) {
      const r = this.expectIdentifier().toUpperCase();
      if (r === 'EXTERNAL' || r === 'NORMAL' || r === 'HIGH') redundancy = r;
    }
    this.matchKeyword('DISK');
    const disks: { path: string; name?: string; sizeMb?: number }[] = [];
    do {
      disks.push(this.parseDiskSpec());
    } while (this.match(TokenType.COMMA));
    // Optional ATTRIBUTE clause / FAILGROUP — swallow.
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) this.advance();
    return { type: 'CreateDiskgroupStatement', position: pos, name, redundancy, disks };
  }

  private parseDropDiskgroup(pos: SourcePosition): import('../engine/parser/ASTNode').DropDiskgroupStatement {
    const name = this.expectIdentifier();
    let includingContents = false;
    if (this.matchKeyword('INCLUDING')) { this.expectKeyword('CONTENTS'); includingContents = true; }
    if (this.matchKeyword('FORCE')) { this.matchKeyword('INCLUDING'); this.matchKeyword('CONTENTS'); includingContents = true; }
    return { type: 'DropDiskgroupStatement', position: pos, name, includingContents };
  }

  private parseAlterDiskgroup(pos: SourcePosition): import('../engine/parser/ASTNode').AlterDiskgroupStatement {
    type Action = import('../engine/parser/ASTNode').AlterDiskgroupAction;
    const name = this.expectIdentifier();
    let action: Action;
    if (this.matchKeyword('ADD')) {
      // ADD [FAILGROUP fg] DISK 'path' [NAME x] [SIZE n M] [, …]
      let failgroup: string | undefined;
      if (this.matchKeyword('FAILGROUP')) failgroup = this.expectIdentifier();
      this.expectKeyword('DISK');
      const disks: { path: string; name?: string; sizeMb?: number; failgroup?: string }[] = [];
      do {
        const d = this.parseDiskSpec();
        disks.push({ ...d, failgroup });
      } while (this.match(TokenType.COMMA));
      action = { kind: 'ADD_DISK', disks };
    } else if (this.matchKeyword('DROP')) {
      this.expectKeyword('DISK');
      const ids: string[] = [];
      do {
        if (this.check(TokenType.STRING_LITERAL)) {
          const raw = this.advance().value;
          ids.push(raw.slice(1, -1));
        } else {
          ids.push(this.expectIdentifier());
        }
      } while (this.match(TokenType.COMMA));
      action = { kind: 'DROP_DISK', identifiers: ids };
    } else if (this.matchKeyword('REBALANCE')) {
      let power: number | undefined;
      if (this.matchKeyword('POWER')) power = Number(this.advance().value);
      action = { kind: 'REBALANCE', power };
    } else if (this.matchKeyword('MOUNT')) {
      action = { kind: 'MOUNT' };
    } else if (this.matchKeyword('DISMOUNT')) {
      action = { kind: 'DISMOUNT' };
    } else {
      while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) this.advance();
      action = { kind: 'REBALANCE' };
    }
    // Swallow optional trailing clauses (NOWAIT, WAIT, etc.)
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) this.advance();
    return { type: 'AlterDiskgroupStatement', position: pos, name, action };
  }

  private parseDiskSpec(): { path: string; name?: string; sizeMb?: number } {
    let path = '';
    if (this.check(TokenType.STRING_LITERAL)) {
      const raw = this.advance().value;
      path = raw.slice(1, -1);
    } else {
      path = this.expectIdentifier();
    }
    let name: string | undefined;
    let sizeMb: number | undefined;
    // Use matchKeyword (which also matches non-reserved IDENTIFIER tokens)
    // in a loop until neither NAME nor SIZE is found.
    for (;;) {
      if (this.matchKeyword('NAME')) { name = this.expectIdentifier(); continue; }
      if (this.matchKeyword('SIZE')) {
        const n = Number(this.advance().value);
        let mult = 1;
        if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.KEYWORD)) {
          const u = this.current().value.toUpperCase();
          if (u === 'M' || u === 'G' || u === 'K' || u === 'T') {
            this.advance();
            mult = u === 'K' ? 1 / 1024 : u === 'M' ? 1 : u === 'G' ? 1024 : 1024 * 1024;
          }
        }
        sizeMb = n * mult;
        continue;
      }
      break;
    }
    return { path, name, sizeMb };
  }

  private parseAlterTablespace(pos: SourcePosition): import('../engine/parser/ASTNode').AlterTablespaceStatement {
    const name = this.expectIdentifier();
    type Action = import('../engine/parser/ASTNode').AlterTablespaceAction;
    const action: Action = this.parseAlterTablespaceAction();
    return { type: 'AlterTablespaceStatement', position: pos, name, action };
  }

  private parseAlterTablespaceAction(): import('../engine/parser/ASTNode').AlterTablespaceAction {
    type A = import('../engine/parser/ASTNode').AlterTablespaceAction;
    const readQuoted = (): string => {
      const raw = this.advance().value;
      return raw.startsWith("'") ? raw.slice(1, -1) : raw;
    };
    const readSize = (): string => {
      let s = this.advance().value;
      if (this.check(TokenType.IDENTIFIER)) s += this.advance().value;
      return s;
    };
    if (this.matchKeyword('ADD')) {
      this.expectKeyword('DATAFILE');
      const path = readQuoted();
      this.expectKeyword('SIZE');
      const size = readSize();
      let autoextend: boolean | undefined;
      if (this.matchKeyword('AUTOEXTEND')) {
        if (this.matchKeyword('ON')) autoextend = true;
        else if (this.matchKeyword('OFF')) autoextend = false;
        // Optional NEXT/MAXSIZE clauses are accepted but not parsed in detail.
        while (this.matchKeyword('NEXT') || this.matchKeyword('MAXSIZE')) {
          if (this.matchKeyword('UNLIMITED')) continue;
          readSize();
        }
      }
      return { kind: 'ADD_DATAFILE', path, size, autoextend } as A;
    }
    if (this.matchKeyword('ONLINE')) return { kind: 'ONLINE' };
    if (this.matchKeyword('OFFLINE')) {
      let mode: 'NORMAL' | 'TEMPORARY' | 'IMMEDIATE' | undefined;
      if (this.matchKeyword('NORMAL')) mode = 'NORMAL';
      else if (this.matchKeyword('TEMPORARY')) mode = 'TEMPORARY';
      else if (this.matchKeyword('IMMEDIATE')) mode = 'IMMEDIATE';
      return { kind: 'OFFLINE', mode };
    }
    if (this.matchKeyword('READ')) {
      if (this.matchKeyword('ONLY')) return { kind: 'READ_ONLY' };
      if (this.matchKeyword('WRITE')) return { kind: 'READ_WRITE' };
    }
    if (this.matchKeyword('RENAME')) {
      if (this.matchKeyword('TO')) {
        const newName = this.expectIdentifier();
        return { kind: 'RENAME_TO', newName };
      }
      if (this.matchKeyword('DATAFILE')) {
        const oldPath = readQuoted();
        this.expectKeyword('TO');
        const newPath = readQuoted();
        return { kind: 'RENAME_DATAFILE', oldPath, newPath };
      }
    }
    if (this.matchKeyword('BEGIN')) { this.expectKeyword('BACKUP'); return { kind: 'BEGIN_BACKUP' }; }
    if (this.matchKeyword('END')) { this.expectKeyword('BACKUP'); return { kind: 'END_BACKUP' }; }
    if (this.matchKeyword('NOLOGGING')) return { kind: 'NOLOGGING' };
    if (this.matchKeyword('LOGGING')) return { kind: 'LOGGING' };
    if (this.matchKeyword('FORCE')) { this.expectKeyword('LOGGING'); return { kind: 'FORCE_LOGGING' }; }
    if (this.matchKeyword('NO')) { this.expectKeyword('FORCE'); this.expectKeyword('LOGGING'); return { kind: 'NO_FORCE_LOGGING' }; }
    if (this.matchKeyword('FLASHBACK')) {
      if (this.matchKeyword('ON')) return { kind: 'FLASHBACK_ON' };
      if (this.matchKeyword('OFF')) return { kind: 'FLASHBACK_OFF' };
    }
    if (this.matchKeyword('SHRINK')) { this.matchKeyword('SPACE'); return { kind: 'SHRINK_SPACE' }; }
    if (this.matchKeyword('COALESCE')) return { kind: 'COALESCE' };
    // Fallback: swallow the rest so we don't choke on unknown clauses.
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) this.advance();
    return { kind: 'LOGGING' };
  }

  protected override parseDialectDrop(pos: SourcePosition): Statement | null {
    if (this.matchKeyword('AUDIT')) {
      this.expectKeyword('POLICY');
      const name = this.expectIdentifier().toUpperCase();
      return { type: 'DropAuditPolicyStatement', position: pos, name } as import('../engine/parser/ASTNode').DropAuditPolicyStatement;
    }
    if (this.matchKeyword('TABLESPACE')) return this.parseDropTablespace(pos);
    if (this.matchKeyword('DISKGROUP')) return this.parseDropDiskgroup(pos);
    if (this.matchKeyword('TRIGGER')) {
      const schema = this.parseSchemaPrefix();
      const name = this.expectIdentifier();
      return { type: 'DropTriggerStatement', position: pos, schema, name } as import('../engine/parser/ASTNode').DropTriggerStatement;
    }
    if (this.matchKeyword('SYNONYM')) {
      const schema = this.parseSchemaPrefix();
      const name = this.expectIdentifier();
      return { type: 'DropSynonymStatement', position: pos, isPublic: false, schema, name } as import('../engine/parser/ASTNode').DropSynonymStatement;
    }
    if (this.matchKeyword('PUBLIC')) {
      if (this.matchKeyword('SYNONYM')) {
        const name = this.expectIdentifier();
        return { type: 'DropSynonymStatement', position: pos, isPublic: true, name } as import('../engine/parser/ASTNode').DropSynonymStatement;
      }
      if (this.matchKeyword('DATABASE')) {
        this.expectKeyword('LINK');
        const name = this.expectIdentifier();
        return { type: 'DropDbLinkStatement', position: pos, isPublic: true, name } as any;
      }
    }
    if (this.matchKeyword('DATABASE')) {
      this.expectKeyword('LINK');
      const name = this.expectIdentifier();
      return { type: 'DropDbLinkStatement', position: pos, isPublic: false, name } as any;
    }
    if (this.matchKeyword('MATERIALIZED')) {
      this.expectKeyword('VIEW');
      const schema = this.parseSchemaPrefix();
      const name = this.expectIdentifier();
      return { type: 'DropMaterializedViewStatement', position: pos, schema, name } as any;
    }
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
    else if (this.matchKeyword('UPGRADE') || this.matchKeyword('DOWNGRADE')) mode = 'MOUNT';
    else if (this.matchKeyword('OPEN')) mode = undefined; // explicit OPEN — same as default
    // Allow trailing optional clauses: RESTRICT, EXCLUSIVE, RECOVER,
    // PFILE='…', etc. They have no effect on the simulator but should
    // not break the parse.
    this.consumeRestOfStatement();
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
    // ALTER SYSTEM KILL SESSION 'sid,serial#' [IMMEDIATE]
    // ALTER SYSTEM DISCONNECT SESSION 'sid,serial#' [IMMEDIATE]
    // ALTER SYSTEM ARCHIVE LOG {ALL|NEXT|CURRENT}
    // ALTER SYSTEM ENABLE/DISABLE RESTRICTED SESSION
    if (this.matchKeyword('SET')) {
      const parameter = this.expectIdentifier();
      // ALTER SYSTEM SET EVENTS '…'  — the EVENTS variant accepts a
      // bare string literal (no `=`).
      if (parameter.toUpperCase() === 'EVENTS' && this.check(TokenType.STRING_LITERAL)) {
        const raw = this.advance().value;
        const value = raw.slice(1, -1);
        this.consumeRestOfStatement();
        return { type: 'AlterSystemStatement', position: pos, action: 'SET', parameter, value };
      }
      this.expect(TokenType.COMPARISON_OP, '=');
      let value: string;
      if (this.check(TokenType.STRING_LITERAL)) {
        const raw = this.advance().value;
        value = raw.slice(1, -1);
      } else if (this.check(TokenType.NUMBER_LITERAL)) {
        value = this.advance().value;
        // Size literals like 4G / 100M / 512K are tokenised as
        // NUMBER + IDENTIFIER ("G"); re-glue the suffix.
        if (this.check(TokenType.IDENTIFIER)) {
          const suffix = this.current().value;
          if (/^[KMGT]$/i.test(suffix)) {
            value += this.advance().value;
          }
        }
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
      // ALTER SYSTEM CHECKPOINT [GLOBAL | LOCAL] — both accepted.
      this.matchKeyword('GLOBAL') || this.matchKeyword('LOCAL');
      return { type: 'AlterSystemStatement', position: pos, action: 'CHECKPOINT' };
    }
    if (this.matchKeyword('KILL')) {
      this.expectKeyword('SESSION');
      // Session ID string: 'sid,serial#'
      const raw = this.expect(TokenType.STRING_LITERAL).value;
      const sessionId = raw.slice(1, -1); // strip quotes
      const immediate = this.matchKeyword('IMMEDIATE');
      return { type: 'AlterSystemStatement', position: pos, action: 'KILL SESSION', sessionId, immediate };
    }
    if (this.matchKeyword('DISCONNECT')) {
      this.expectKeyword('SESSION');
      const raw = this.expect(TokenType.STRING_LITERAL).value;
      const sessionId = raw.slice(1, -1);
      const immediate = this.matchKeyword('IMMEDIATE')
        || (this.matchKeyword('POST') ? (this.matchKeyword('TRANSACTION'), false) : false);
      return { type: 'AlterSystemStatement', position: pos, action: 'DISCONNECT SESSION', sessionId, immediate };
    }
    if (this.matchKeyword('ARCHIVE')) {
      this.expectKeyword('LOG');
      let target = 'NEXT';
      if (this.matchKeyword('ALL')) target = 'ALL';
      else if (this.matchKeyword('CURRENT')) target = 'CURRENT';
      else if (this.matchKeyword('NEXT')) target = 'NEXT';
      else if (this.matchKeyword('START')) target = 'START';
      else if (this.matchKeyword('STOP')) target = 'STOP';
      return { type: 'AlterSystemStatement', position: pos, action: 'ARCHIVE LOG', parameter: target };
    }
    if (this.matchKeyword('ENABLE')) {
      if (this.matchKeyword('RESTRICTED')) {
        this.matchKeyword('SESSION');
        return { type: 'AlterSystemStatement', position: pos, action: 'ENABLE RESTRICTED SESSION' };
      }
      return { type: 'AlterSystemStatement', position: pos, action: 'ENABLE' };
    }
    if (this.matchKeyword('DISABLE')) {
      if (this.matchKeyword('RESTRICTED')) {
        this.matchKeyword('SESSION');
        return { type: 'AlterSystemStatement', position: pos, action: 'DISABLE RESTRICTED SESSION' };
      }
      return { type: 'AlterSystemStatement', position: pos, action: 'DISABLE' };
    }
    if (this.matchKeyword('RESET')) {
      const parameter = this.expectIdentifier();
      let scope: AlterSystemStatement['scope'];
      if (this.matchKeyword('SCOPE')) {
        this.expect(TokenType.COMPARISON_OP, '=');
        const s = this.expectIdentifier().toUpperCase();
        if (s === 'MEMORY' || s === 'SPFILE' || s === 'BOTH') scope = s;
      }
      return { type: 'AlterSystemStatement', position: pos, action: 'RESET', parameter, scope };
    }
    // Fallback: consume remaining tokens as generic action
    let action = '';
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      action += this.advance().value + ' ';
    }
    return { type: 'AlterSystemStatement', position: pos, action: action.trim() || 'UNKNOWN' };
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

    // Parse trailing storage-attribute clauses so they reach the meta.
    let logging: boolean | undefined;
    let extentManagement: 'LOCAL' | 'DICTIONARY' | undefined;
    let segmentSpaceManagement: 'AUTO' | 'MANUAL' | undefined;
    let allocationType: 'SYSTEM' | 'UNIFORM' | 'USER' | undefined;
    let encrypted: boolean | undefined;
    let safety = 200;
    while (--safety > 0 && !this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('LOGGING')) { logging = true; continue; }
      if (this.matchKeyword('NOLOGGING')) { logging = false; continue; }
      if (this.matchKeyword('EXTENT')) {
        this.expectKeyword('MANAGEMENT');
        extentManagement = this.matchKeyword('DICTIONARY') ? 'DICTIONARY' : (this.matchKeyword('LOCAL'), 'LOCAL');
        if (this.matchKeyword('UNIFORM')) {
          allocationType = 'UNIFORM';
          if (this.matchKeyword('SIZE')) { this.advance(); if (this.check(TokenType.IDENTIFIER)) this.advance(); }
        } else if (this.matchKeyword('AUTOALLOCATE')) {
          allocationType = 'SYSTEM';
        }
        continue;
      }
      if (this.matchKeyword('SEGMENT')) {
        this.expectKeyword('SPACE'); this.expectKeyword('MANAGEMENT');
        segmentSpaceManagement = this.matchKeyword('MANUAL') ? 'MANUAL' : (this.matchKeyword('AUTO'), 'AUTO');
        continue;
      }
      if (this.matchKeyword('ENCRYPTION')) {
        encrypted = true;
        // USING 'algorithm' DEFAULT STORAGE (ENCRYPT) — swallow.
        while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF) && !this.checkKeyword('LOGGING') && !this.checkKeyword('NOLOGGING')) {
          this.advance();
        }
        continue;
      }
      // Unknown trailing clause — skip one token to make progress.
      this.advance();
    }

    return {
      type: 'CreateTablespaceStatement', position: pos,
      name, temporary: temporary || undefined, undo: undo || undefined,
      datafile, size, autoextend,
      logging, extentManagement, segmentSpaceManagement, allocationType, encrypted,
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
    // Optional trailing CASCADE CONSTRAINTS — accepted, no effect in the simulator.
    if (this.matchKeyword('CASCADE')) {
      this.matchKeyword('CONSTRAINTS');
    }
    // KEEP DATAFILES (Oracle 12c+) — accepted for symmetry.
    if (this.matchKeyword('KEEP')) {
      this.matchKeyword('DATAFILES');
    }
    return {
      type: 'DropTablespaceStatement', position: pos, name,
      includeContents: includeContents || undefined,
      includeDatafiles: includeDatafiles || undefined,
    };
  }

  // ── CREATE TRIGGER ─────────────────────────────────────────────────

  private parseCreateTrigger(pos: import('../engine/lexer/Token').SourcePosition, orReplace?: boolean): import('../engine/parser/ASTNode').CreateTriggerStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();

    // Timing: BEFORE | AFTER | INSTEAD OF
    let timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    if (this.matchKeyword('BEFORE')) {
      timing = 'BEFORE';
    } else if (this.matchKeyword('AFTER')) {
      timing = 'AFTER';
    } else if (this.matchKeyword('INSTEAD')) {
      this.expectKeyword('OF');
      timing = 'INSTEAD OF';
    } else {
      throw this.error('Expected BEFORE, AFTER, or INSTEAD OF');
    }

    // Events: INSERT | UPDATE | DELETE (separated by OR)
    const events: Array<'INSERT' | 'UPDATE' | 'DELETE'> = [];
    do {
      if (this.matchKeyword('INSERT')) events.push('INSERT');
      else if (this.matchKeyword('UPDATE')) events.push('UPDATE');
      else if (this.matchKeyword('DELETE')) events.push('DELETE');
      else throw this.error('Expected INSERT, UPDATE, or DELETE');
    } while (this.matchKeyword('OR'));

    // ON table
    this.expectKeyword('ON');
    const tableSchema = this.parseSchemaPrefix();
    const tableName = this.expectIdentifier();

    // Optional: FOR EACH ROW
    let forEachRow = false;
    if (this.matchKeyword('FOR')) {
      this.expectKeyword('EACH');
      this.expectKeyword('ROW');
      forEachRow = true;
    }

    // Optional: WHEN (condition) - skip for now, consume as string
    let whenCondition: string | undefined;
    if (this.matchKeyword('WHEN')) {
      // Consume everything in parens
      this.expect(TokenType.LPAREN);
      let depth = 1;
      const parts: string[] = [];
      while (depth > 0 && !this.check(TokenType.EOF) && !this.check(TokenType.SEMICOLON)) {
        if (this.check(TokenType.LPAREN)) depth++;
        if (this.check(TokenType.RPAREN)) depth--;
        if (depth > 0) parts.push(this.advance().value);
        else this.advance(); // consume closing paren
      }
      whenCondition = parts.join(' ');
    }

    // Body: everything from BEGIN/DECLARE to END; (or just a single PL/SQL statement)
    // Consume all remaining tokens as body text
    const bodyParts: string[] = [];
    while (!this.check(TokenType.EOF) && !this.check(TokenType.SEMICOLON)) {
      bodyParts.push(this.advance().value);
    }
    const body = bodyParts.join(' ');

    return {
      type: 'CreateTriggerStatement', position: pos,
      orReplace, schema, name, timing, events,
      tableName, tableSchema,
      forEachRow, whenCondition, body,
    };
  }

  // ── EXPLAIN PLAN ──────────────────────────────────────────────────

  private parseExplainPlan(): import('../engine/parser/ASTNode').ExplainPlanStatement {
    const pos = this.current().position;
    this.expectKeyword('EXPLAIN');
    this.expectKeyword('PLAN');

    let statementId: string | undefined;
    if (this.matchKeyword('SET')) {
      this.expectKeyword('STATEMENT_ID');
      // Consume '=' (tokenized as COMPARISON_OP)
      if (this.current().type === TokenType.COMPARISON_OP && this.current().value === '=') {
        this.advance();
      }
      const tok = this.current();
      if (tok.type === TokenType.STRING_LITERAL) {
        statementId = tok.value;
        this.advance();
      }
    }

    let targetTable: string | undefined;
    if (this.matchKeyword('INTO')) {
      targetTable = this.expectIdentifier();
    }

    this.expectKeyword('FOR');

    // Parse the inner statement (SELECT, INSERT, UPDATE, DELETE)
    const statement = this.parseStatement();

    return {
      type: 'ExplainPlanStatement', position: pos,
      statementId, targetTable, statement,
    };
  }

  // ── CREATE SYNONYM ─────────────────────────────────────────────────

  private parseCreateSynonym(pos: SourcePosition, orReplace: boolean, isPublic: boolean): import('../engine/parser/ASTNode').CreateSynonymStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    this.expectKeyword('FOR');
    const targetSchema = this.parseSchemaPrefix();
    const targetName = this.expectIdentifier();
    return { type: 'CreateSynonymStatement', position: pos, orReplace: orReplace || undefined, isPublic: isPublic || undefined, schema, name, targetSchema, targetName };
  }

  // ── ALTER SEQUENCE ─────────────────────────────────────────────────

  private parseAlterSequence(pos: SourcePosition): import('../engine/parser/ASTNode').AlterSequenceStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    const result: import('../engine/parser/ASTNode').AlterSequenceStatement = { type: 'AlterSequenceStatement', position: pos, schema, name };

    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('INCREMENT')) { this.expectKeyword('BY'); result.incrementBy = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('MINVALUE')) { result.minValue = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('MAXVALUE')) { result.maxValue = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('CACHE')) { result.cache = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('NOCACHE')) { result.cache = 0; }
      else if (this.matchKeyword('CYCLE')) { result.cycle = true; }
      else if (this.matchKeyword('NOCYCLE')) { result.cycle = false; }
      else break;
    }
    return result;
  }

  // ── ALTER INDEX ────────────────────────────────────────────────────

  private parseAlterIndex(pos: SourcePosition): import('../engine/parser/ASTNode').AlterIndexStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    if (this.matchKeyword('REBUILD')) {
      // Swallow optional ONLINE / TABLESPACE x / PARALLEL n / NOLOGGING — the
      // simulator doesn't track index storage attributes yet.
      while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) this.advance();
      return { type: 'AlterIndexStatement', position: pos, schema, name, action: 'REBUILD' };
    }
    if (this.matchKeyword('RENAME')) {
      this.expectKeyword('TO');
      const newName = this.expectIdentifier();
      return { type: 'AlterIndexStatement', position: pos, schema, name, action: 'RENAME', newName };
    }
    if (this.matchKeyword('LOGGING') || this.matchKeyword('NOLOGGING')
        || this.matchKeyword('MONITORING') || this.matchKeyword('NOMONITORING')
        || this.matchKeyword('PARALLEL') || this.matchKeyword('NOPARALLEL')
        || this.matchKeyword('COALESCE')
        || this.matchKeyword('UNUSABLE') || this.matchKeyword('USABLE')) {
      // Metadata flips that the simulator does not persist yet — swallow.
      this.consumeRestOfStatement();
      return { type: 'AlterIndexStatement', position: pos, schema, name, action: 'REBUILD' };
    }
    throw this.error('Expected REBUILD or RENAME after ALTER INDEX');
  }

  // ── CREATE DATABASE LINK (stub) ────────────────────────────────────

  private parseCreateDbLink(pos: SourcePosition, isPublic: boolean): any {
    const name = this.expectIdentifier();
    // Consume CONNECT TO user IDENTIFIED BY password USING 'tns_alias'
    let connectUser: string | undefined;
    let usingAlias: string | undefined;
    if (this.matchKeyword('CONNECT')) {
      this.expectKeyword('TO');
      connectUser = this.expectIdentifier();
      this.expectKeyword('IDENTIFIED');
      this.expectKeyword('BY');
      this.advance(); // skip password
    }
    if (this.matchKeyword('USING')) {
      usingAlias = this.expect(TokenType.STRING_LITERAL).value;
    }
    return { type: 'CreateDbLinkStatement', position: pos, isPublic, name, connectUser, usingAlias };
  }

  // ── CREATE MATERIALIZED VIEW (stub) ────────────────────────────────

  private parseCreateMaterializedView(pos: SourcePosition, _orReplace: boolean): any {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    // Skip optional BUILD, REFRESH clauses
    while (!this.check(TokenType.EOF) && !this.checkKeyword('AS')) {
      this.advance();
    }
    this.expectKeyword('AS');
    const query = this.parseSelect();
    return { type: 'CreateMaterializedViewStatement', position: pos, schema, name, query };
  }

  // ── Unified audit policies ─────────────────────────────────────

  private parseCreateAuditPolicy(pos: SourcePosition): import('../engine/parser/ASTNode').CreateAuditPolicyStatement {
    const name = this.expectIdentifier().toUpperCase();
    const actions: string[] = [];
    const roles: string[] = [];
    let onObject: import('../engine/parser/ASTNode').AuditObjectTarget | undefined;

    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('ACTIONS') || this.matchKeyword('PRIVILEGES')) {
        do {
          // Each action is a multi-word verb (LOGON, UPDATE, CREATE TABLE…)
          // terminated by comma, ON, ROLES, ';' or EOF.
          let verb = this.expectIdentifierOrKeyword().toUpperCase();
          while (this.check(TokenType.KEYWORD) || this.check(TokenType.IDENTIFIER)) {
            const next = this.current().value.toUpperCase();
            if (['ON', 'ROLES', 'WHEN', 'CONTAINER'].includes(next)) break;
            verb += ' ' + this.advance().value.toUpperCase();
          }
          actions.push(verb);
        } while (this.match(TokenType.COMMA));
      } else if (this.matchKeyword('ON')) {
        const schema = this.parseSchemaPrefix();
        const objName = this.expectIdentifier();
        onObject = { schema: schema?.toUpperCase(), name: objName.toUpperCase() };
      } else if (this.matchKeyword('ROLES')) {
        do { roles.push(this.expectIdentifier().toUpperCase()); } while (this.match(TokenType.COMMA));
      } else if (this.matchKeyword('CONTAINER')) {
        // CONTAINER = CURRENT|ALL — accept and ignore (single-tenant sim).
        this.match(TokenType.EQUAL);
        this.advance();
      } else if (this.matchKeyword('WHEN')) {
        // Skip the predicate body — we don't evaluate it.
        while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) this.advance();
      } else break;
    }
    return {
      type: 'CreateAuditPolicyStatement', position: pos, name, actions,
      onObject, roles: roles.length ? roles : undefined,
    };
  }

  private parseEnableAuditPolicy(pos: SourcePosition, disable: boolean): import('../engine/parser/ASTNode').AuditPolicyStatement {
    const policyName = this.expectIdentifier().toUpperCase();
    let byUsers: string[] | undefined;
    let exceptUsers: string[] | undefined;
    if (this.matchKeyword('BY')) {
      byUsers = [];
      do { byUsers.push(this.expectIdentifier().toUpperCase()); } while (this.match(TokenType.COMMA));
    } else if (this.matchKeyword('EXCEPT')) {
      exceptUsers = [];
      do { exceptUsers.push(this.expectIdentifier().toUpperCase()); } while (this.match(TokenType.COMMA));
    }
    return { type: 'AuditPolicyStatement', position: pos, policyName, byUsers, exceptUsers, disable: disable || undefined };
  }

  // ── AUDIT / NOAUDIT ────────────────────────────────────────────

  /**
   * Parse one or more comma-separated audit options. Each option is a
   * multi-word phrase (CREATE TABLE, SELECT, CREATE ANY TABLE, …). The
   * list terminates at ON, BY, WHENEVER, ';' or EOF.
   */
  private parseAuditOptionList(): string[] {
    const options: string[] = [];
    do {
      let opt = this.expectIdentifierOrKeyword();
      while (this.check(TokenType.KEYWORD) || this.check(TokenType.IDENTIFIER)) {
        const next = this.current().value.toUpperCase();
        if (['BY', 'WHENEVER', 'ON'].includes(next)) break;
        opt += ' ' + this.advance().value;
      }
      options.push(opt.toUpperCase());
    } while (this.match(TokenType.COMMA));
    return options;
  }

  /** Parse `ON [schema.]object` after the audit option list, if present. */
  private parseAuditOnObject(): { schema?: string; name: string } | undefined {
    if (!this.matchKeyword('ON')) return undefined;
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    return { schema: schema?.toUpperCase(), name: name.toUpperCase() };
  }

  private parseAudit(): AuditStatement | import('../engine/parser/ASTNode').AuditPolicyStatement {
    const pos = this.current().position;
    this.expectKeyword('AUDIT');
    if (this.matchKeyword('POLICY')) {
      return this.parseEnableAuditPolicy(pos, false);
    }
    const auditOptions = this.parseAuditOptionList();
    const onObject = this.parseAuditOnObject();

    let byUser: string | undefined;
    let byMode: 'ACCESS' | 'SESSION' | undefined;
    // `BY user` and `BY ACCESS|SESSION` can both appear, in either order.
    for (let i = 0; i < 2 && this.matchKeyword('BY'); i++) {
      const next = this.current().value.toUpperCase();
      if (next === 'ACCESS') { this.advance(); byMode = 'ACCESS'; }
      else if (next === 'SESSION') { this.advance(); byMode = 'SESSION'; }
      else byUser = this.expectIdentifier();
    }

    let whenever: 'SUCCESSFUL' | 'NOT SUCCESSFUL' | undefined;
    if (this.matchKeyword('WHENEVER')) {
      whenever = this.matchKeyword('NOT') ? 'NOT SUCCESSFUL' : 'SUCCESSFUL';
      this.expectKeyword('SUCCESSFUL');
    }

    return {
      type: 'AuditStatement', position: pos,
      auditOption: auditOptions[0], auditOptions, onObject,
      byUser: byUser?.toUpperCase(), byMode, whenever,
    };
  }

  private parseNoaudit(): NoauditStatement | import('../engine/parser/ASTNode').AuditPolicyStatement {
    const pos = this.current().position;
    this.expectKeyword('NOAUDIT');
    if (this.matchKeyword('POLICY')) {
      return this.parseEnableAuditPolicy(pos, true);
    }
    const auditOptions = this.parseAuditOptionList();
    const onObject = this.parseAuditOnObject();

    let byUser: string | undefined;
    if (this.matchKeyword('BY')) {
      const next = this.current().value.toUpperCase();
      if (next === 'ACCESS' || next === 'SESSION') this.advance();
      else byUser = this.expectIdentifier();
    }
    // Tolerate a trailing WHENEVER [NOT] SUCCESSFUL on NOAUDIT.
    if (this.matchKeyword('WHENEVER')) {
      this.matchKeyword('NOT');
      this.expectKeyword('SUCCESSFUL');
    }

    return {
      type: 'NoauditStatement', position: pos,
      auditOption: auditOptions[0], auditOptions, onObject,
      byUser: byUser?.toUpperCase(),
    };
  }
}
