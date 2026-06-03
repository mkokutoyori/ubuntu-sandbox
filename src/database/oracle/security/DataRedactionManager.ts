/**
 * DataRedactionManager — Oracle 12c+ Data Redaction (DBMS_REDACT).
 *
 * Owns the in-memory state behind:
 *   - REDACTION_POLICIES  (one row per policy)
 *   - REDACTION_COLUMNS   (one row per redacted column)
 *   - REDACTION_VALUES_FOR_TYPE_FULL (per-data-type FULL-redaction
 *     constants — the values used when ACTION_TYPE='FULL')
 *
 * The manager surfaces the same `ADD_POLICY` / `ALTER_POLICY` /
 * `DROP_POLICY` operations DBAs invoke through `DBMS_REDACT`. The
 * executor does not actually rewrite query results (that would require
 * a real planner rewrite), but the metadata is faithful so monitoring
 * scripts and DV / Database Security Assessments work as expected.
 */

export type RedactionFunctionType =
  | 'FULL' | 'PARTIAL' | 'RANDOM' | 'REGEXP' | 'NONE' | 'NULLIFY';

export interface RedactionPolicy {
  readonly objectOwner: string;
  readonly objectName: string;
  readonly policyName: string;
  readonly expression: string;
  enabled: boolean;
  readonly policyDescription: string;
  readonly createdAt: Date;
}

export interface RedactionColumn {
  readonly objectOwner: string;
  readonly objectName: string;
  readonly columnName: string;
  readonly functionType: RedactionFunctionType;
  readonly functionParameters: string | null;
  readonly regexpPattern: string | null;
  readonly regexpReplaceString: string | null;
  readonly regexpPosition: number | null;
  readonly regexpOccurrence: number | null;
  readonly regexpMatchParameter: string | null;
  readonly columnDescription: string | null;
}

/** Per-Oracle-type FULL-redaction default value table. Real Oracle ships
 *  these constants in DBMS_REDACT — we mirror them so the
 *  REDACTION_VALUES_FOR_TYPE_FULL view returns the same rows. */
export const REDACTION_FULL_VALUES: Array<{ dataType: string; charValue: string; numberValue: number; dateValue: string }> = [
  { dataType: 'NUMBER',    charValue: '',    numberValue: 0, dateValue: '' },
  { dataType: 'CHAR',      charValue: ' ',   numberValue: 0, dateValue: '' },
  { dataType: 'VARCHAR2',  charValue: ' ',   numberValue: 0, dateValue: '' },
  { dataType: 'NCHAR',     charValue: ' ',   numberValue: 0, dateValue: '' },
  { dataType: 'NVARCHAR2', charValue: ' ',   numberValue: 0, dateValue: '' },
  { dataType: 'DATE',      charValue: '',    numberValue: 0, dateValue: '0001-01-01' },
  { dataType: 'TIMESTAMP', charValue: '',    numberValue: 0, dateValue: '0001-01-01' },
  { dataType: 'BINARY_FLOAT',  charValue: '', numberValue: 0, dateValue: '' },
  { dataType: 'BINARY_DOUBLE', charValue: '', numberValue: 0, dateValue: '' },
];

export class DataRedactionManager {
  private policies: RedactionPolicy[] = [];
  private columns: RedactionColumn[] = [];

  constructor(seedDefaults: boolean = true) {
    if (seedDefaults) this.seedDefaults();
  }

  private seedDefaults(): void {
    // Seed one canonical policy per sensitive column in the simulator's
    // demo schemas — matches what a DBA would script after a TSDP scan.
    this.addPolicy({
      objectOwner: 'HR', objectName: 'EMPLOYEES', policyName: 'HR_PII_MASK',
      expression: "SYS_CONTEXT('USERENV','SESSION_USER') NOT IN ('HR','SYS','SYSTEM')",
      policyDescription: 'Mask sensitive HR columns for non-HR readers',
    });
    this.addColumn({
      objectOwner: 'HR', objectName: 'EMPLOYEES', columnName: 'SALARY',
      functionType: 'FULL',
    });
    this.addColumn({
      objectOwner: 'HR', objectName: 'EMPLOYEES', columnName: 'EMAIL',
      functionType: 'PARTIAL', functionParameters: 'VVVVVVVVVV,VVVVV*****,2,5',
    });

    this.addPolicy({
      objectOwner: 'FCUBSLIVE', objectName: 'CARDS', policyName: 'PCI_MASK',
      expression: "SYS_CONTEXT('USERENV','SESSION_USER') <> 'FCUBSLIVE'",
      policyDescription: 'PAN/CVV redaction for non-app readers',
    });
    this.addColumn({
      objectOwner: 'FCUBSLIVE', objectName: 'CARDS', columnName: 'PAN',
      functionType: 'PARTIAL', functionParameters: '9,1,12',
    });
    this.addColumn({
      objectOwner: 'FCUBSLIVE', objectName: 'CARDS', columnName: 'CVV',
      functionType: 'FULL',
    });
  }

  // ── DBMS_REDACT surface ────────────────────────────────────────────

  addPolicy(p: {
    objectOwner: string; objectName: string; policyName: string;
    expression: string; policyDescription?: string;
  }): void {
    const o = p.objectOwner.toUpperCase();
    const t = p.objectName.toUpperCase();
    if (this.policies.some(x => x.objectOwner === o && x.objectName === t)) {
      throw new Error('ORA-28069: only one policy allowed per object');
    }
    this.policies.push({
      objectOwner: o, objectName: t, policyName: p.policyName.toUpperCase(),
      expression: p.expression, enabled: true,
      policyDescription: p.policyDescription ?? '',
      createdAt: new Date(),
    });
  }

  dropPolicy(objectOwner: string, objectName: string): boolean {
    const o = objectOwner.toUpperCase(), t = objectName.toUpperCase();
    const before = this.policies.length;
    this.policies = this.policies.filter(p => !(p.objectOwner === o && p.objectName === t));
    this.columns = this.columns.filter(c => !(c.objectOwner === o && c.objectName === t));
    return before > this.policies.length;
  }

  enablePolicy(objectOwner: string, objectName: string, enable: boolean): boolean {
    const o = objectOwner.toUpperCase(), t = objectName.toUpperCase();
    const p = this.policies.find(x => x.objectOwner === o && x.objectName === t);
    if (!p) return false;
    p.enabled = enable;
    return true;
  }

  addColumn(c: {
    objectOwner: string; objectName: string; columnName: string;
    functionType: RedactionFunctionType; functionParameters?: string;
    regexpPattern?: string; regexpReplaceString?: string;
    regexpPosition?: number; regexpOccurrence?: number;
    regexpMatchParameter?: string; columnDescription?: string;
  }): void {
    const o = c.objectOwner.toUpperCase();
    const t = c.objectName.toUpperCase();
    if (!this.policies.some(p => p.objectOwner === o && p.objectName === t)) {
      throw new Error('ORA-28065: a redaction policy does not exist on the table');
    }
    this.columns.push({
      objectOwner: o, objectName: t, columnName: c.columnName.toUpperCase(),
      functionType: c.functionType,
      functionParameters: c.functionParameters ?? null,
      regexpPattern: c.regexpPattern ?? null,
      regexpReplaceString: c.regexpReplaceString ?? null,
      regexpPosition: c.regexpPosition ?? null,
      regexpOccurrence: c.regexpOccurrence ?? null,
      regexpMatchParameter: c.regexpMatchParameter ?? null,
      columnDescription: c.columnDescription ?? null,
    });
  }

  // ── Read APIs ──────────────────────────────────────────────────────

  getPolicies(): readonly RedactionPolicy[] { return this.policies; }
  getColumns(): readonly RedactionColumn[] { return this.columns; }

  /**
   * Return the per-column redaction action active for the given object.
   * Map key is the upper-cased column name. Empty map if no policy
   * is enabled on the object — callers should skip redaction work then.
   */
  findActiveRedactions(
    objectOwner: string, objectName: string, currentUser?: string,
  ): Map<string, RedactionColumn> {
    const owner = objectOwner.toUpperCase();
    const name = objectName.toUpperCase();
    const policy = this.policies.find((p) =>
      p.objectOwner.toUpperCase() === owner &&
      p.objectName.toUpperCase() === name &&
      p.enabled);
    if (!policy) return new Map();
    if (currentUser && this.expressionExemptsUser(policy.expression, currentUser)) {
      return new Map();
    }
    const out = new Map<string, RedactionColumn>();
    for (const c of this.columns) {
      if (c.objectOwner.toUpperCase() !== owner) continue;
      if (c.objectName.toUpperCase() !== name) continue;
      if (c.functionType === 'NONE') continue;
      out.set(c.columnName.toUpperCase(), c);
    }
    return out;
  }

  /**
   * Parse the common DBMS_REDACT.ADD_POLICY expression idiom
   * `SYS_CONTEXT('USERENV','SESSION_USER') NOT IN ('A','B')` and return
   * true when the current user appears in the exclusion list.
   */
  private expressionExemptsUser(expression: string, currentUser: string): boolean {
    const expr = expression.toUpperCase();
    const user = currentUser.toUpperCase();
    const match = /SESSION_USER'\)\s*NOT\s+IN\s*\(([^)]+)\)/.exec(expr);
    if (!match) return false;
    const names = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    return names.includes(user);
  }

  /**
   * Apply a redaction column's action to a single value. Returns the
   * masked value. Mirrors DBMS_REDACT defaults — see REDACTION_FULL_VALUES.
   */
  applyRedaction(value: unknown, col: RedactionColumn): unknown {
    if (value === null || value === undefined) return value;
    switch (col.functionType) {
      case 'FULL': {
        if (typeof value === 'number') return 0;
        if (value instanceof Date) return new Date('1970-01-01');
        return ' ';
      }
      case 'NULLIFY':
        return null;
      case 'RANDOM': {
        if (typeof value === 'number') return Math.floor(Math.random() * 1_000_000);
        if (value instanceof Date) {
          return new Date(Date.now() - Math.floor(Math.random() * 31536000000));
        }
        const s = String(value);
        return Array.from(s, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
      }
      case 'PARTIAL': {
        const s = String(value);
        const params = (col.functionParameters ?? '').split(',').map((x) => x.trim());
        const [mask = '*', startStr = '1', lengthStr = String(s.length)] = params;
        const start = Math.max(1, parseInt(startStr, 10) || 1) - 1;
        const length = Math.max(0, parseInt(lengthStr, 10) || 0);
        if (start >= s.length) return s;
        const before = s.slice(0, start);
        const middle = mask.repeat(length);
        const after = s.slice(start + length);
        return before + middle + after;
      }
      case 'REGEXP': {
        const s = String(value);
        if (!col.regexpPattern) return s;
        try {
          const flags = col.regexpMatchParameter ?? 'g';
          const re = new RegExp(col.regexpPattern, flags.includes('g') ? flags : flags + 'g');
          return s.replace(re, col.regexpReplaceString ?? '*');
        } catch {
          return s;
        }
      }
      default:
        return value;
    }
  }
}
