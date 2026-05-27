/**
 * DBA_COLL_TYPES — collection types (VARRAY / NESTED TABLE).
 * Native Oracle view.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_COLL_TYPES',
  comment: 'Collection (VARRAY/NESTED TABLE) types',
  query({ instance }) {
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TYPE_NAME', 128),
        col.str('COLL_TYPE', 20),
        col.num('UPPER_BOUND'),
        col.str('ELEM_TYPE_MOD', 7),
        col.str('ELEM_TYPE_OWNER', 128),
        col.str('ELEM_TYPE_NAME', 128),
        col.num('LENGTH'),
        col.num('PRECISION'),
        col.num('SCALE'),
        col.str('CHARACTER_SET_NAME', 44),
        col.str('ELEM_STORAGE', 7),
        col.str('NULLS_STORED', 3),
      ],
      instance.types.getCollectionTypes().map(c => [
        c.owner, c.typeName, c.collType, c.upperBound,
        c.elemTypeMod, c.elemTypeOwner, c.elemTypeName,
        c.length, c.precision, c.scale,
        'CHAR_CS', 'DEFAULT', 'YES',
      ]),
    );
  },
});
