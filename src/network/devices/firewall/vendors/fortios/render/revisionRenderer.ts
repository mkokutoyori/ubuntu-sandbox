import { renderTable, FIXED_TABLE } from '../../../../shells/cli/TextTable';
import type { ConfigRevision } from '../../../config/RevisionStore';

function stamp(at: number, localNow: number): string {
  const offset = localNow - Date.now();
  const local = new Date(at + offset);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-`
    + `${two(local.getUTCDate())} ${two(local.getUTCHours())}:`
    + `${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
}

export function renderRevisionList(
  revisions: readonly ConfigRevision[], localNow: number,
): string {
  return renderTable(revisions, [
    { header: 'ID', width: 5, value: (row) => String(row.id) },
    { header: 'TIME', width: 22, value: (row) => stamp(row.at, localNow) },
    { header: 'ADMIN', width: 18, value: (row) => row.admin },
    { header: 'FIRMWARE VERSION', width: 22, value: (row) => row.firmware },
    { header: 'COMMENT', value: (row) => row.comment },
  ], FIXED_TABLE).join('\n');
}
