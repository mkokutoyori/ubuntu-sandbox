/**
 * V$MUTEX_SLEEP — cumulative mutex sleep counts by location.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const MUTEX_LOCATIONS = [
  'kgllkc', 'kksLockDelete', 'kksfbc child', 'kkschsmrLock',
  'kglpndl', 'kglhdgn1', 'kglget2', 'kglobpn',
];

registerView({
  name: 'V$MUTEX_SLEEP',
  comment: 'Mutex sleep cumulative stats',
  query({ runtime }) {
    return queryResult(
      [
        col.str('MUTEX_TYPE', 64),
        col.str('LOCATION', 40),
        col.num('SLEEPS'),
        col.num('WAIT_TIME'),
      ],
      MUTEX_LOCATIONS.map(loc => [
        'Library Cache', loc,
        Math.floor(runtime.counters.parseHard / MUTEX_LOCATIONS.length),
        0,
      ])
    );
  },
});
