/**
 * V$NLS_VALID_VALUES — supported NLS parameter values.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const VALUES: Array<[string, string]> = [
  ['LANGUAGE', 'AMERICAN'], ['LANGUAGE', 'FRENCH'], ['LANGUAGE', 'GERMAN'],
  ['LANGUAGE', 'JAPANESE'], ['LANGUAGE', 'KOREAN'], ['LANGUAGE', 'SIMPLIFIED CHINESE'],
  ['TERRITORY', 'AMERICA'], ['TERRITORY', 'FRANCE'], ['TERRITORY', 'GERMANY'],
  ['TERRITORY', 'JAPAN'], ['TERRITORY', 'UNITED KINGDOM'],
  ['CHARACTERSET', 'AL32UTF8'], ['CHARACTERSET', 'UTF8'], ['CHARACTERSET', 'WE8ISO8859P1'],
  ['CHARACTERSET', 'AL16UTF16'], ['CHARACTERSET', 'US7ASCII'],
  ['SORT', 'BINARY'], ['SORT', 'FRENCH'], ['SORT', 'GERMAN'],
  ['CALENDAR', 'GREGORIAN'], ['CALENDAR', 'JAPANESE IMPERIAL'],
];

registerView({
  name: 'V$NLS_VALID_VALUES',
  comment: 'NLS parameter valid value catalogue',
  query() {
    return queryResult(
      [col.str('PARAMETER', 30), col.str('VALUE', 60), col.str('ISDEPRECATED', 5)],
      VALUES.map(([p, v]) => [p, v, 'FALSE'])
    );
  },
});
