/**
 * DBA_POLICY_CONTEXTS — application-context drivers attached to a VPD
 * policy via `DBMS_RLS.ADD_POLICY_CONTEXT`. Live state lives in
 * `OracleCatalog.getRlsPolicyContexts()`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_POLICY_CONTEXTS',
  comment: 'VPD policy application-context drivers',
  query({ catalog }) {
    const c = catalog as unknown as { getRlsPolicyContexts?: () => { objectOwner: string; objectName: string; namespace: string; attribute: string }[] };
    const rows = c.getRlsPolicyContexts ? c.getRlsPolicyContexts() : [];
    return queryResult(
      [
        col.str('OBJECT_OWNER', 30),
        col.str('OBJECT_NAME', 30),
        col.str('NAMESPACE', 30),
        col.str('ATTRIBUTE', 30),
      ],
      rows.map(r => [r.objectOwner, r.objectName, r.namespace, r.attribute])
    );
  },
});
