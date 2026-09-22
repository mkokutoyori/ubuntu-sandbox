const WRITING_VERBS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE',
  'CREATE', 'DROP', 'RENAME', 'GRANT', 'REVOKE', 'FLASHBACK',
  'COMMIT', 'SAVEPOINT', 'LOCK',
];

const ADMIN_PREFIXES = [
  'ALTER DATABASE', 'ALTER SYSTEM', 'ALTER SESSION', 'ALTER PLUGGABLE DATABASE',
];

export const ORA_16000 =
  'ORA-16000: database or pluggable database open for read-only access';

/**
 * Une standby physique n'accepte AUCUNE modification de donnees ni de
 * schema : c'est ce qui la distingue d'une copie qui derive. Les ordres
 * d'administration — dont la bascule elle-meme — restent recevables.
 */
export function standbyRefusesStatement(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  if (ADMIN_PREFIXES.some(p => upper.startsWith(p))) return false;
  if (upper.startsWith('ALTER')) return true;
  return WRITING_VERBS.some(v => upper === v || upper.startsWith(`${v} `));
}
