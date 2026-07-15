import { Interpreter } from '@/command-kernel/interpreter';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { Session, SimpleUser, createSession } from '@/command-kernel/session/types';
import type { SftpSession } from '../SftpSession';
import { SftpMachineApi } from './SftpMachineApi';
import {
  SftpCdCommand,
  SftpExitCommand,
  SftpHelpCommand,
  SftpLcdCommand,
  SftpLlsCommand,
  SftpLpwdCommand,
  SftpLsCommand,
  SftpPwdCommand,
  SftpVersionCommand,
} from './commands/navigation';
import {
  SftpChmodCommand,
  SftpChownCommand,
  SftpDfCommand,
  SftpGetCommand,
  SftpLmkdirCommand,
  SftpMkdirCommand,
  SftpPutCommand,
  SftpRenameCommand,
  SftpRmCommand,
  SftpRmdirCommand,
  SftpStatCommand,
} from './commands/transfer';

/**
 * Bootstrap du shell sftp — même modèle que `create<Vendeur>HostShell`
 * (framework §4) : un registre dédié aux commandes de la session SFTP, une
 * machine dont `fs` est le VFS local du client et `sftp` le canal réel de
 * la connexion. La `Session` kernel porte le cwd LOCAL (le cwd distant est
 * un état de la connexion, dans la façade).
 */
export function createSftpShell(sftpSession: SftpSession): { interpreter: Interpreter; session: Session } {
  const registry = new CommandRegistry();
  registry.register(() => new SftpPwdCommand());
  registry.register(() => new SftpLpwdCommand());
  registry.register(() => new SftpCdCommand());
  registry.register(() => new SftpLcdCommand());
  registry.register(() => new SftpLsCommand());
  registry.register(() => new SftpLlsCommand());
  registry.register(() => new SftpVersionCommand());
  registry.register(() => new SftpHelpCommand());
  registry.register(() => new SftpExitCommand());
  registry.register(() => new SftpGetCommand());
  registry.register(() => new SftpPutCommand());
  registry.register(() => new SftpMkdirCommand());
  registry.register(() => new SftpRmCommand());
  registry.register(() => new SftpRmdirCommand());
  registry.register(() => new SftpRenameCommand());
  registry.register(() => new SftpChmodCommand());
  registry.register(() => new SftpChownCommand());
  registry.register(() => new SftpStatCommand());
  registry.register(() => new SftpDfCommand());
  registry.register(() => new SftpLmkdirCommand());

  const machine = new SftpMachineApi(sftpSession);
  const owner = sftpSession.localOwner();
  const session = createSession({
    id: 'sftp-shell',
    user: new SimpleUser(owner.uid, owner.gid, owner.user),
    cwd: sftpSession.getLocalCwdPath(),
    // HOME distant : `~` dans un shell sftp désigne le home DISTANT pour
    // toutes les commandes du canal (cd/ls/get/put) — c'est le cas
    // dominant ; les commandes locales re-résolvent via machine.fs.
    env: new Map([['HOME', `/home/${sftpSession.getRemoteUserName()}`]]),
  });
  return { interpreter: new Interpreter(registry, machine), session };
}
