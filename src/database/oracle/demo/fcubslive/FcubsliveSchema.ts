/**
 * FlexCube Universal Banking — FCUBSLIVE schema installer.
 *
 * Installs the FCUBSLIVE schema simulating Oracle FLEXCUBE tables
 * for a fictional "Banque Centrale d'Afrique" (BCA).
 *
 * Usage: call installFcubsliveSchema(db) after database startup.
 */

import type { OracleDatabase } from '../../OracleDatabase';
import { FCUBSLIVE_DDL } from './FcubsliveDDL';
import {
  CUSTOMER_INSERTS,
  KYC_MASTER_INSERTS,
  KYC_RETAIL_INSERTS,
  USER_INSERTS,
  CUST_ACCOUNT_INSERTS,
  ACCOUNT_INSERTS,
  RATES_HISTORY_INSERTS,
  ACTB_HISTORY_INSERTS,
  ACCBAL_HISTORY_INSERTS,
  LOAN_MASTER_INSERTS,
  LOAN_SCHEDULE_INSERTS,
  TELLER_INSERTS,
  TILL_TXN_INSERTS,
} from './FcubsliveData';

/**
 * Install the FCUBSLIVE (FlexCube) demo schema with all tables and sample data.
 */
export function installFcubsliveSchema(db: OracleDatabase): void {
  const { executor } = db.connectAsSysdba();

  // Ensure schema exists
  db.storage.ensureSchema('FCUBSLIVE');

  // Create all tables
  for (const ddl of FCUBSLIVE_DDL) {
    db.executeSql(executor, ddl);
  }

  // Insert data in dependency order
  const allInserts = [
    ...CUSTOMER_INSERTS,
    ...KYC_MASTER_INSERTS,
    ...KYC_RETAIL_INSERTS,
    ...USER_INSERTS,
    ...CUST_ACCOUNT_INSERTS,
    ...ACCOUNT_INSERTS,
    ...RATES_HISTORY_INSERTS,
    ...ACTB_HISTORY_INSERTS,
    ...ACCBAL_HISTORY_INSERTS,
    ...LOAN_MASTER_INSERTS,
    ...LOAN_SCHEDULE_INSERTS,
    ...TELLER_INSERTS,
    ...TILL_TXN_INSERTS,
  ];

  for (const sql of allInserts) {
    db.executeSql(executor, sql);
  }
}
