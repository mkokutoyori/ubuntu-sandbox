/**
 * DBA_FEATURE_USAGE_STATISTICS — per-feature usage telemetry the MMON
 * background process accumulates over each AWR window. Native 10g+.
 *
 * The simulator drives a few features through real bus events
 * (audit, ASM, encryption, RAC, …); for each one we compute its
 * "detected usage" from live state. Unused features still appear
 * exactly as they do on a real DB — a row with `currently_used='FALSE'`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

interface FeatureProbe {
  name: string;
  used: (ctx: { instance: import('../OracleInstance').OracleInstance;
                catalog: import('../OracleCatalog').OracleCatalog }) => number;
}

const FEATURES: FeatureProbe[] = [
  { name: 'Audit Options',                  used: (c) => c.catalog.getAuditTrail().length > 0 ? 1 : 0 },
  { name: 'Audit Options - Unified Auditing', used: (c) => c.catalog.getAuditTrail().length > 0 ? 1 : 0 },
  { name: 'Automatic SGA Tuning',           used: () => 1 },
  { name: 'Automatic Storage Management',   used: (c) => c.instance.asm.getAllDiskgroups().length > 0 ? 1 : 0 },
  { name: 'Data Redaction',                 used: (c) => c.instance.redaction.getPolicies().length > 0 ? 1 : 0 },
  { name: 'Database Vault',                 used: (c) => c.catalog.getDvRealms().length > 0 ? 1 : 0 },
  { name: 'Encrypted Tablespaces',          used: () => 0 },
  { name: 'Fine Grained Auditing',          used: (c) => c.catalog.getFgaPolicies().length > 0 ? 1 : 0 },
  { name: 'Flashback Database',             used: (c) => c.instance.flashbackOn ? 1 : 0 },
  { name: 'Network ACLs',                   used: (c) => c.instance.networkAcls.getAcls().length > 0 ? 1 : 0 },
  { name: 'OLAP - Analytic Workspaces',     used: () => 0 },
  { name: 'Partitioning (system)',          used: () => 0 },
  { name: 'Real Application Clusters (RAC)', used: () => 0 },
  { name: 'Recovery Manager (RMAN)',        used: (c) => c.instance.getRuntimeState().backups.length > 0 ? 1 : 0 },
  { name: 'SecureFile Encryption (user)',   used: () => 0 },
  { name: 'Server Parameter File',          used: () => 1 },
  { name: 'Transparent Data Encryption',    used: (c) => c.catalog.getTdeMasterKeys().length > 0 ? 1 : 0 },
];

registerView({
  name: 'DBA_FEATURE_USAGE_STATISTICS',
  comment: 'Feature usage telemetry (MMON sampled)',
  query(ctx) {
    const now = (ctx.instance.startupTime ?? new Date()).toISOString();
    return queryResult(
      [
        col.num('DBID'),
        col.str('NAME', 64),
        col.num('VERSION'),
        col.num('DETECTED_USAGES'),
        col.num('TOTAL_SAMPLES'),
        col.str('CURRENTLY_USED', 5),
        col.date('FIRST_USAGE_DATE'),
        col.date('LAST_USAGE_DATE'),
        col.date('LAST_SAMPLE_DATE'),
        col.num('LAST_SAMPLE_PERIOD'),
        col.num('SAMPLE_INTERVAL'),
        col.str('DESCRIPTION', 256),
      ],
      FEATURES.map(f => {
        const used = f.used({ instance: ctx.instance, catalog: ctx.catalog });
        return [
          1, f.name, 19, used, 1,
          used ? 'TRUE' : 'FALSE',
          used ? now : null,
          used ? now : null,
          now, 604800, 604800,
          `${f.name} usage`,
        ];
      }),
    );
  },
});
