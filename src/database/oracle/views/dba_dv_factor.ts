/**
 * DBA_DV_FACTOR — Database Vault factors. Reads live catalog state.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DV_FACTOR',
  comment: 'Database Vault factors',
  query({ catalog }) {
    const c = catalog as unknown as { getDvFactors?: () => { name: string; description: string; factorType: string; validateExpr: string; identifyBy: string; labeledBy: string; evalOptions: string; auditOptions: number; failOptions: number }[] };
    const rows = c.getDvFactors ? c.getDvFactors() : [];
    return queryResult(
      [
        col.str('NAME', 30),
        col.str('DESCRIPTION', 1024),
        col.str('FACTOR_TYPE_NAME', 30),
        col.str('VALIDATE_EXPR', 1024),
        col.str('IDENTIFY_BY', 16),
        col.str('LABELED_BY', 16),
        col.str('EVAL_OPTIONS', 16),
        col.num('AUDIT_OPTIONS'),
        col.num('FAIL_OPTIONS'),
      ],
      rows.map(r => [r.name, r.description, r.factorType, r.validateExpr, r.identifyBy, r.labeledBy, r.evalOptions, r.auditOptions, r.failOptions])
    );
  },
});
