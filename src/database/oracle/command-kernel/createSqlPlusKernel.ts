import { Interpreter } from '@/command-kernel/interpreter';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { createSession, Session, SimpleUser } from '@/command-kernel/session/types';
import type { SQLPlusSession } from '../commands/SQLPlusSession';
import { SqlPlusMachineApi } from './SqlPlusMachineApi';
import { SqlPlusSetCommand } from './commands/Set';
import { SqlPlusShowCommand } from './commands/Show';
import { SqlPlusHelpCommand } from './commands/Help';
import { SqlPlusClearCommand } from './commands/Clear';
import { SqlPlusExitCommand } from './commands/Exit';
import { SqlPlusDisconnectCommand } from './commands/Disconnect';

/**
 * Bootstrap du socle command-kernel SQL*Plus (Wave 1 — voir CHANGELOG) :
 * un registre plat (pas de modes, grammaire SQL*Plus non hiérarchique) avec
 * les 6 commandes de session/réglages migrées, et une `SqlPlusMachineApi`
 * qui lit/mute l'état réel de la `SQLPlusSession` fournie.
 *
 * Pas encore câblé sur `SqlPlusSubShell` (frontière sync/async documentée
 * dans le CHANGELOG) : ce bootstrap est consommé directement par les tests
 * de fondation en attendant la vague de branchement live.
 */
export function createSqlPlusKernel(
  sqlPlusSession: SQLPlusSession,
  hostname: string = 'localhost',
): { interpreter: Interpreter; machine: SqlPlusMachineApi; session: Session } {
  const registry = new CommandRegistry();
  registry.register(() => new SqlPlusSetCommand());
  registry.register(() => new SqlPlusShowCommand());
  registry.register(() => new SqlPlusHelpCommand());
  registry.register(() => new SqlPlusClearCommand());
  registry.register(() => new SqlPlusExitCommand());
  registry.register(() => new SqlPlusDisconnectCommand());

  const machine = new SqlPlusMachineApi(sqlPlusSession, hostname);
  const session = createSession({
    id: 'sqlplus-shell',
    user: new SimpleUser(0, 0, 'oracle'),
  });

  return { interpreter: new Interpreter(registry, machine), machine, session };
}

type VerbTest = (upperLine: string) => boolean;

const exact = (...names: readonly string[]): VerbTest => (u) => names.includes(u);
const wordOrPrefix = (...names: readonly string[]): VerbTest =>
  (u) => names.some((n) => u === n || u.startsWith(`${n} `));
const prefixOnly = (...names: readonly string[]): VerbTest =>
  (u) => names.some((n) => u.startsWith(`${n} `));

/**
 * Une famille par verbe canonique ET par alias — miroir exact des
 * prédicats `matches()` de `SQLPlusSession.buildCommands()` pour les 6
 * commandes migrées (mêmes quirks : `SET`/`CLEAR` seuls, sans argument,
 * ne matchent PAS ; `DISCONNECT`/`DISC`/`HELP` n'acceptent aucun texte
 * final ; `SHOW`/`EXIT`/`QUIT` acceptent la forme nue).
 */
const VERB_FAMILIES: Readonly<Record<string, VerbTest>> = {
  EXIT: wordOrPrefix('EXIT', 'QUIT'),
  QUIT: wordOrPrefix('EXIT', 'QUIT'),
  SET: prefixOnly('SET'),
  // `SHOW ERRORS`/`SHOW ERR <target>` reste porté par le legacy : nécessite
  // les DTOs de compilation du catalogue, pas encore exposés côté
  // MachineApi (voir CHANGELOG, Wave 1) — exclu explicitement pour ne pas
  // régresser sur un sous-shell déjà migré pour le reste de SHOW.
  SHOW: (u) => (u === 'SHOW' || u.startsWith('SHOW ')) && !/^SHOW\s+ERR(ORS)?(\s|$)/.test(u),
  DISCONNECT: exact('DISCONNECT', 'DISC'),
  DISC: exact('DISCONNECT', 'DISC'),
  HELP: exact('HELP', 'HELP INDEX'),
  CLEAR: prefixOnly('CLEAR'),
};

/**
 * Reconnaît une ligne SQL*Plus déjà "fraîche" (pas de tampon SQL/PL-SQL en
 * cours — appelant responsable de cette vérification) comme l'une des 6
 * commandes migrées. Retourne le nom de verbe (résolu par `CommandRegistry`,
 * alias compris) et l'argv déjà tokenisé par simples espaces — la grammaire
 * SQL*Plus de ces commandes ne connaît ni quotes ni échappements au niveau
 * verbe (chaque commande gère elle-même son texte libre, comme le legacy).
 * `null` si la ligne ne correspond à aucune des 6 (reste porté par le
 * pipeline legacy `SQLPlusSession`).
 */
export function recognizeSqlPlusKernelVerb(line: string): { name: string; argv: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  const firstToken = upper.split(/\s+/)[0];
  const test = VERB_FAMILIES[firstToken];
  if (!test || !test(upper)) return null;
  const rest = trimmed.slice(firstToken.length).trim();
  const argv = rest ? rest.split(/\s+/) : [];
  return { name: firstToken, argv };
}
