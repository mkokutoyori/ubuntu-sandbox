/**
 * SensitiveObjectRegistry — declares which (schema, object) pairs carry
 * sensitive data and what classification applies.
 *
 * Pre-loaded with the well-known examples carried by the simulator's
 * seed schemas (HR.EMPLOYEES, FCUBSLIVE.ACCOUNTS, SYS.USER$, …) so a
 * fresh database already has plausible sensitive-data behaviour. Real
 * deployments would have DBAs adding more via `SECDEMO.MARK_SENSITIVE`.
 */

import type { ISensitiveObject, SensitivityClass, SensitiveObjectRegistryView } from './interfaces';

export class SensitiveObject implements ISensitiveObject {
  readonly schema: string;
  readonly object: string;
  readonly classification: SensitivityClass;
  readonly sensitiveColumns: string[];
  readonly description: string;
  /** Seeded at registration to allow age-based reporting in future views. */
  readonly registeredAt: Date;

  constructor(init: {
    schema: string; object: string; classification: SensitivityClass;
    sensitiveColumns?: string[]; description?: string; registeredAt?: Date;
  }) {
    this.schema = init.schema.toUpperCase();
    this.object = init.object.toUpperCase();
    this.classification = init.classification;
    this.sensitiveColumns = (init.sensitiveColumns ?? []).map(c => c.toUpperCase());
    this.description = init.description ?? '';
    this.registeredAt = init.registeredAt ?? new Date();
  }
}

export class SensitiveObjectRegistry implements SensitiveObjectRegistryView {
  private readonly objects = new Map<string, SensitiveObject>();

  constructor(seed: boolean = true) {
    if (seed) this.seedDefaults();
  }

  private seedDefaults(): void {
    // The simulator already provisions HR / SCOTT / FCUBSLIVE — mark
    // their canonical sensitive tables so demo queries are recognised.
    this.register({
      schema: 'HR', object: 'EMPLOYEES', classification: 'PII',
      sensitiveColumns: ['SALARY', 'PHONE_NUMBER', 'EMAIL', 'COMMISSION_PCT'],
      description: 'HR employees roster — personally identifiable + compensation',
    });
    this.register({
      schema: 'HR', object: 'JOB_HISTORY', classification: 'PII',
      sensitiveColumns: [], description: 'Employee employment history',
    });
    this.register({
      schema: 'SCOTT', object: 'EMP', classification: 'PII',
      sensitiveColumns: ['SAL', 'COMM'], description: 'Classic SCOTT.EMP — salaries',
    });
    this.register({
      schema: 'FCUBSLIVE', object: 'ACCOUNTS', classification: 'FINANCIAL',
      sensitiveColumns: ['BALANCE', 'IBAN', 'SWIFT'],
      description: 'FCUBS core-banking accounts',
    });
    this.register({
      schema: 'FCUBSLIVE', object: 'TRANSACTIONS', classification: 'FINANCIAL',
      sensitiveColumns: ['AMOUNT', 'COUNTERPARTY_IBAN'],
      description: 'FCUBS transaction history',
    });
    this.register({
      schema: 'FCUBSLIVE', object: 'CUSTOMERS', classification: 'PII',
      sensitiveColumns: ['NATIONAL_ID', 'DATE_OF_BIRTH', 'EMAIL'],
      description: 'FCUBS customer master',
    });
    this.register({
      schema: 'FCUBSLIVE', object: 'CARDS', classification: 'PCI',
      sensitiveColumns: ['PAN', 'CVV', 'EXPIRY'], description: 'Payment card details',
    });
    // SYS internals — credentials & audit
    this.register({
      schema: 'SYS', object: 'USER$', classification: 'CREDENTIALS',
      sensitiveColumns: ['PASSWORD', 'SPARE4'], description: 'Password hashes',
    });
    this.register({
      schema: 'SYS', object: 'AUD$', classification: 'CREDENTIALS',
      sensitiveColumns: [], description: 'Audit trail base table',
    });
    this.register({
      schema: 'SYS', object: 'LINK$', classification: 'CREDENTIALS',
      sensitiveColumns: ['PASSWORD', 'PASSWORDX'], description: 'Database link credentials',
    });
  }

  register(obj: SensitiveObject | ConstructorParameters<typeof SensitiveObject>[0]): SensitiveObject {
    const so = obj instanceof SensitiveObject ? obj : new SensitiveObject(obj);
    this.objects.set(`${so.schema}.${so.object}`, so);
    return so;
  }

  unregister(schema: string, object: string): boolean {
    return this.objects.delete(`${schema.toUpperCase()}.${object.toUpperCase()}`);
  }

  list(): readonly ISensitiveObject[] {
    return [...this.objects.values()];
  }

  lookup(schema: string, object: string): SensitiveObject | undefined {
    return this.objects.get(`${schema.toUpperCase()}.${object.toUpperCase()}`);
  }

  isSensitive(schema: string, object: string): boolean {
    return this.objects.has(`${schema.toUpperCase()}.${object.toUpperCase()}`);
  }
}
