/**
 * `scp` et `sftp` sont des commandes déclarées, chacune dans son fichier,
 * et non deux `case` d'un switch. Ce que cela change est observable : une
 * commande déclarée porte son manuel et sa liste d'options, et c'est la
 * même déclaration qui la rend joignable par le pont asynchrone — donc
 * par une vraie session — quelle que soit la façon dont on l'écrit.
 */
import { describe, it, expect } from 'vitest';
import { CORE_LINUX_COMMANDS } from '@/network/devices/linux/commands';

describe('scp et sftp sont des LinuxCommand', () => {
  it.each(['scp', 'sftp'])('%s est déclarée et exige le contexte réseau', (name) => {
    const cmd = CORE_LINUX_COMMANDS.find((c) => c.name === name);
    expect(cmd).toBeDefined();
    // Sans ce drapeau le pont asynchrone ne la sert pas, et la commande
    // retombe sur le dispatch synchrone, qui n'ouvre aucune session.
    expect(cmd!.needsNetworkContext).toBe(true);
    expect(cmd!.usage).toMatch(new RegExp(`usage: ${name}`));
    expect(cmd!.runWithStatus).toBeTypeOf('function');
  });

  it('sftp lit son entrée standard, scp non', () => {
    const sftp = CORE_LINUX_COMMANDS.find((c) => c.name === 'sftp');
    const scp = CORE_LINUX_COMMANDS.find((c) => c.name === 'scp');
    // Le lot de verbes arrive par un tube ou un document en ligne : c'est
    // l'écriture qui glissait autrefois sur le dispatch synchrone.
    expect(sftp!.readsStdin).toBe(true);
    expect(scp!.readsStdin).toBeFalsy();
  });
});
