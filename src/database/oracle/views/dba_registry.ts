/**
 * DBA_REGISTRY — installed Oracle database components (native).
 *
 * Real Oracle ships ~15 components on a default 19c install. We
 * surface the canonical set so monitoring scripts that query DBA_REGISTRY
 * to verify a healthy upgrade behave as expected.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const COMPONENTS: Array<[string, string, string, string]> = [
  ['CATALOG',  'Oracle Database Catalog Views',      'SYS',   '19.0.0.0.0'],
  ['CATPROC',  'Oracle Database Packages and Types', 'SYS',   '19.0.0.0.0'],
  ['CATJAVA',  'Oracle Database Java Packages',      'SYS',   '19.0.0.0.0'],
  ['XDB',      'Oracle XML Database',                'XDB',   '19.0.0.0.0'],
  ['OWM',      'Oracle Workspace Manager',           'WMSYS', '19.0.0.0.0'],
  ['JAVAVM',   'JServer JAVA Virtual Machine',       'SYS',   '19.0.0.0.0'],
  ['CONTEXT',  'Oracle Text',                        'CTXSYS','19.0.0.0.0'],
  ['ORDIM',    'Oracle Multimedia',                  'ORDSYS','19.0.0.0.0'],
  ['SDO',      'Spatial',                            'MDSYS', '19.0.0.0.0'],
  ['XML',      'Oracle XDK',                         'SYS',   '19.0.0.0.0'],
  ['RAC',      'Oracle Real Application Clusters',   'SYS',   '19.0.0.0.0'],
  ['DV',       'Oracle Database Vault',              'DVSYS', '19.0.0.0.0'],
  ['OLS',      'Oracle Label Security',              'LBACSYS','19.0.0.0.0'],
  ['APEX',     'Oracle Application Express',         'APEX_190200', '19.2.0.00.18'],
  ['OLAP',     'OLAP Analytic Workspace',            'OLAPSYS','19.0.0.0.0'],
];

registerView({
  name: 'DBA_REGISTRY',
  comment: 'Installed database components',
  query({ instance }) {
    const created = instance.startupTime ?? new Date();
    const ts = created.toISOString();
    return queryResult(
      [
        col.str('COMP_ID', 30),
        col.str('COMP_NAME', 255),
        col.str('VERSION', 30),
        col.str('STATUS', 11),
        col.date('MODIFIED'),
        col.str('NAMESPACE', 30),
        col.str('CONTROL', 30),
        col.str('SCHEMA', 30),
        col.str('PROCEDURE', 61),
        col.str('STARTUP', 8),
        col.str('PARENT_ID', 30),
        col.str('OTHER_SCHEMAS', 4000),
      ],
      COMPONENTS.map(([id, name, schema, ver]) => [
        id, name, ver, 'VALID', ts, 'SERVER', schema, schema, '', '', '', null,
      ]),
    );
  },
});
