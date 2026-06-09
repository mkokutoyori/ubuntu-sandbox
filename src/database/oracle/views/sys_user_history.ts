/**
 * SYS.USER_HISTORY$ — native SYS-owned table holding the password
 * history Oracle uses to enforce PASSWORD_REUSE_TIME / PASSWORD_REUSE_MAX.
 *
 * One row per (user, changed-on) pair. Oracle stores the password hash;
 * the simulator keeps the plaintext in memory (PasswordManager) and renders
 * the genuine legacy 10g (DES) hash here, matching the native column shape.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { oracle10gHash } from '@/crypto';

registerView({
  name: 'SYS.USER_HISTORY$',
  comment: 'Password history backing PASSWORD_REUSE_* enforcement',
  query({ catalog }) {
    const engine = catalog.getSecurityEngine();
    if (!engine) return queryResult(
      [
        col.num('USER#'),
        col.str('PASSWORD', 4000),
        col.date('PASSWORD_DATE'),
      ], []);
    const rows: (string | number)[][] = [];
    for (const u of catalog.getAllUsers()) {
      const hist = engine.passwords.getHistory(u.username);
      for (const h of hist) {
        // The genuine legacy 10g DES hash of UPPER(username||password).
        const hash = oracle10gHash(u.username, h.password);
        rows.push([u.userId, hash, h.changedAt.toISOString()]);
      }
    }
    return queryResult(
      [
        col.num('USER#'),
        col.str('PASSWORD', 4000),
        col.date('PASSWORD_DATE'),
      ],
      rows,
    );
  },
});
