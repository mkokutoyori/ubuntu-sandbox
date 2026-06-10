import { col } from './_columns';
import { queryResult, type ResultSet } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import type { ViewContext } from './types';

const ERROR_COLUMNS = [
  col.str('OWNER', 30),
  col.str('NAME', 30),
  col.str('TYPE', 12),
  col.num('SEQUENCE'),
  col.num('LINE'),
  col.num('POSITION'),
  col.str('TEXT', 4000),
  col.str('ATTRIBUTE', 9),
  col.num('MESSAGE_NUMBER'),
];

function errorRows(ctx: ViewContext, ownerFilter: string | null): ResultSet {
  const rows: (string | number)[][] = [];
  for (const entry of ctx.catalog.getAllCompilationErrors()) {
    if (ownerFilter && entry.owner !== ownerFilter) continue;
    entry.errors.forEach((err, idx) => {
      const messageNumber = parseInt(err.text.match(/PLS-(\d+)/)?.[1] ?? '0', 10);
      rows.push([
        entry.owner, entry.name, entry.type,
        idx + 1, err.line, err.position, err.text,
        'ERROR', messageNumber,
      ]);
    });
  }
  return queryResult(ERROR_COLUMNS, rows);
}

registerView({
  name: 'DBA_ERRORS',
  comment: 'Current errors on all stored objects in the database',
  query(ctx) {
    return errorRows(ctx, null);
  },
});

registerView({
  name: 'ALL_ERRORS',
  comment: 'Current errors on stored objects that user is allowed to create',
  query(ctx) {
    return errorRows(ctx, null);
  },
});

registerView({
  name: 'USER_ERRORS',
  comment: 'Current errors on stored objects in user account',
  query(ctx) {
    return errorRows(ctx, ctx.currentUser.toUpperCase());
  },
});
