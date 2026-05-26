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
}
