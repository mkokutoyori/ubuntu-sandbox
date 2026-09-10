import type { LinuxCommand } from '../LinuxCommand';

/**
 * `sync` vide les tampons d'ecriture. Le VFS de ce simulateur ecrit
 * SYNCHRONEMENT : il n'y a aucun tampon a vider, et la commande n'a donc
 * rien a faire — ce qui est exactement ce qu'elle fait sur une machine
 * dont rien n'est en attente. Elle est declaree parce qu'un operateur la
 * tape apres `dd`, et qu'un `sync: command not found` a cet endroit du
 * geste ferait douter du geste entier.
 */
export const syncCommand: LinuxCommand = {
  name: 'sync',
  package: 'coreutils',
  needsNetworkContext: false,
  usage: 'sync [FILE]...',
  help: 'Synchronize cached writes to persistent storage.',
  run: () => '',
  runWithStatusSync: () => ({ output: '', exitCode: 0 }),
  runWithStatus: () => Promise.resolve({ output: '', exitCode: 0 }),
};
