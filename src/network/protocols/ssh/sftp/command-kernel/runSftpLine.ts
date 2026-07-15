import type { Interpreter } from '@/command-kernel/interpreter';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import type { Session } from '@/command-kernel/session/types';
import type { SftpSession } from '../SftpSession';

/**
 * Normalise la casse du seul verbe d'une ligne sftp(1) — insensible à la
 * casse (`PWD` ≡ `pwd`), jamais le reste de la ligne (chemins sensibles à
 * la casse).
 */
export function normalizeSftpVerbCase(line: string): string {
  const verbEnd = line.search(/\s|$/);
  return line.slice(0, verbEnd).toLowerCase() + line.slice(verbEnd);
}

/**
 * Exécute une ligne déjà normalisée de la grammaire sftp sur le shell
 * command-kernel dédié (`createSftpShell`, framework §14.4) — point
 * d'exécution unique partagé par l'hôte REPL interactif (`SftpSubShell`) et
 * le mode batch du lanceur (`SftpConnectApi.runLine`), pour ne jamais
 * dupliquer la synchronisation du cwd local ni la collecte de sortie.
 * Laisse remonter `ExitRequest`/`CommandNotFoundError`/`ShellError` tels
 * quels — chaque appelant leur donne le sens qui lui est propre (fin de
 * session, verbe inconnu, message d'erreur).
 */
export async function runSftpLine(
  shell: { readonly interpreter: Interpreter; readonly session: Session },
  sftpSession: SftpSession,
  normalizedLine: string,
): Promise<string> {
  if (!normalizedLine) return '';
  shell.session.cwd = sftpSession.getLocalCwdPath();
  const stdout = new PipeBuffer();
  const io = { stdin: new PipeBuffer(), stdout, stderr: stdout };
  await shell.interpreter.interpretLine(normalizedLine, shell.session, io);
  sftpSession.setLocalCwdPath(shell.session.cwd);
  return (await stdout.readAll()).replace(/\n$/, '');
}
