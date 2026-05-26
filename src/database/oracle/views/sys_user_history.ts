/**
 * SYS.USER_HISTORY$ — native SYS-owned table holding the password
 * history Oracle uses to enforce PASSWORD_REUSE_TIME / PASSWORD_REUSE_MAX.
 *
 * One row per (user, changed-on) pair. Oracle stores password hashes;
 * the simulator stores plaintext (PasswordManager keeps them in
 * memory) but the column shape matches the native table 1-to-1 so DBA
 * scripts that read SYS.USER_HISTORY$ keep working.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

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
        // Real Oracle stores the legacy DES hash; emit a deterministic
        // placeholder of the same shape (16 hex chars).
        const hash = Array.from(h.password)
          .reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0)
          .toString(16).padStart(16, '0').toUpperCase().slice(0, 16);
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
