/**
 * DBA_TYPES — every user-defined and system-supplied SQL object type.
 *
 * Native to every Oracle release; populated by `CREATE TYPE …`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TYPES',
  comment: 'Object types',
  query({ instance }) {
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TYPE_NAME', 128),
        col.str('TYPE_OID', 32),
        col.str('TYPECODE', 30),
        col.num('ATTRIBUTES'),
        col.num('METHODS'),
        col.str('PREDEFINED', 3),
        col.str('INCOMPLETE', 3),
        col.str('FINAL', 3),
        col.str('INSTANTIABLE', 3),
        col.str('SUPERTYPE_OWNER', 128),
        col.str('SUPERTYPE_NAME', 128),
        col.num('LOCAL_ATTRIBUTES'),
        col.num('LOCAL_METHODS'),
        col.str('TYPEID', 32),
      ],
      instance.types.getObjectTypes().map(t => [
        t.owner, t.typeName, t.typeOid, t.typeCode,
        t.attributes.length, 0,
        t.predefined ? 'YES' : 'NO',
        t.incomplete ? 'YES' : 'NO',
        t.finalType ? 'YES' : 'NO',
        t.instantiable ? 'YES' : 'NO',
        t.supertypeOwner, t.supertypeName,
        t.attributes.length, 0,
        t.typeOid,
      ]),
    );
  },
});
