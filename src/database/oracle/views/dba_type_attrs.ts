/**
 * DBA_TYPE_ATTRS — one row per attribute of every object type.
 * Native to every Oracle release.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TYPE_ATTRS',
  comment: 'Attributes of object types',
  query({ instance }) {
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TYPE_NAME', 128),
        col.str('ATTR_NAME', 128),
        col.str('ATTR_TYPE_MOD', 7),
        col.str('ATTR_TYPE_OWNER', 128),
        col.str('ATTR_TYPE_NAME', 128),
        col.num('LENGTH'),
        col.num('PRECISION'),
        col.num('SCALE'),
        col.str('CHARACTER_SET_NAME', 44),
        col.num('ATTR_NO'),
        col.str('INHERITED', 3),
      ],
      instance.types.getAllAttributes().map(a => [
        a.parentOwner, a.parentTypeName, a.attrName, a.attrTypeMod,
        a.attrTypeOwner, a.attrTypeName,
        a.length, a.precision, a.scale,
        'CHAR_CS', a.attrPosition, 'NO',
      ]),
    );
  },
});
