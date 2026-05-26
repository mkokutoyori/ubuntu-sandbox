/**
 * DBA_SENSITIVE_COLUMN_TYPES — TSDP sensitive-type catalogue.
 *
 * The simulator ships the canonical Oracle 19c set (CREDIT_CARD_NUMBER,
 * EMAIL_ID, NATIONAL_INSURANCE_NUMBER, US_SOCIAL_SECURITY_NUMBER,
 * IP_ADDRESS, FULL_NAME, US_PHONE_NUMBER, …) plus the simulator's
 * domain classifications (PII / PCI / PHI / FINANCIAL / CREDENTIALS).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const ORACLE_BUILTIN_TYPES: Array<[string, string, string, string]> = [
  ['CREDIT_CARD_NUMBER', 'NUMBER', 'Y', 'Credit card numbers'],
  ['US_SOCIAL_SECURITY_NUMBER', 'VARCHAR2', 'Y', 'US social security'],
  ['EMAIL_ID', 'VARCHAR2', 'Y', 'Email addresses'],
  ['IP_ADDRESS', 'VARCHAR2', 'Y', 'IP addresses'],
  ['FULL_NAME', 'VARCHAR2', 'Y', 'Full names'],
  ['US_PHONE_NUMBER', 'VARCHAR2', 'Y', 'US phone numbers'],
  ['NATIONAL_INSURANCE_NUMBER', 'VARCHAR2', 'Y', 'UK NI numbers'],
];

const SIMULATOR_CLASSES: Array<[string, string, string, string]> = [
  ['PII', 'ANY', 'Y', 'Personally identifiable information'],
  ['PCI', 'ANY', 'Y', 'Payment card industry data'],
  ['PHI', 'ANY', 'Y', 'Protected health information'],
  ['FINANCIAL', 'ANY', 'Y', 'Financial / banking data'],
  ['CREDENTIALS', 'ANY', 'Y', 'Authentication credentials'],
  ['CUSTOM', 'ANY', 'Y', 'User-defined classification'],
];

registerView({
  name: 'DBA_SENSITIVE_COLUMN_TYPES',
  comment: 'Catalogue of TSDP sensitive types',
  query() {
    return queryResult(
      [
        col.str('NAME', 128),
        col.str('DATA_TYPE', 128),
        col.str('USER_COMMENTS', 4000),
        col.str('PRE_DEFINED', 3),
      ],
      [...ORACLE_BUILTIN_TYPES, ...SIMULATOR_CLASSES].map(t => [t[0], t[1], t[3], t[2]]),
    );
  },
});
