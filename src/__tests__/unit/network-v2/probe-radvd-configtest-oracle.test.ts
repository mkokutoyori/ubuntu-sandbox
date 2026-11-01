/**
 * `radvd -c` : l'analyseur de `radvd.conf` contre le VRAI binaire. Mesure de depart : `radvd` n'existait pas (`grep -ri radvd src/` ne rendait rien). Le corpus
 * `support/oracle/radvd/radvd-2.19.json` a ete enregistre en lancant `radvd --logmethod stderr_clean -c -C /tmp/r.conf` du paquet Ubuntu 24.04 `radvd 1:2.19-1ubuntu1`
 * (archive.ubuntu.com, extrait avec dpkg -x, execute sans reseau : -c ne touche aucune interface) sur 36 configurations ; chaque cas rejoue la meme ligne de commande sur une machine Linux
 * de l'emulateur et compare la sortie et le code retour caractere pour caractere. La grammaire (gram.y et scanner.l de radvd v2.19) est portee a la main : les ecarts qu'elle
 * cacherait (un « syntax error » a la mauvaise ligne, un avertissement oublie, une valeur refusee la ou le vrai l'accepte) sont exactement ce que ce corpus mesure.
 * Limite assumee : les options d'interface que le vrai accepte et que l'emulateur n'emet pas sur le fil (Mobile IPv6, 6LoWPAN, ABRO) sont LUES et ne changent aucune annonce (TODO.md).
 *
 * Discrimine par `git stash` sur src/network : tous les cas tombent avant (la commande n'existait pas). TEMOIN : aucun cas ne passe sans le correctif, c'est le contrat d'un oracle ;
 * le cas `minimal` prouve le laboratoire (paquet installe, fichier lu, sortie du succes).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import corpus from '../../support/oracle/radvd/radvd-2.19.json';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

interface Case { id: string; config: string; output: string; exitCode: number }

async function machine() {
  const server = new LinuxServer('linux-server', 'R1');
  server.powerOn();
  const machineWithExecutor = server as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } };
  const root = async (command: string): Promise<string> =>
    String(await machineWithExecutor.executor.runAsUser('root', () => server.executeCommand(command)));
  await root('apt install -y radvd');
  return { server, root };
}

describe('radvd -c against the recorded binary', () => {
  for (const entry of (corpus as { cases: Case[] }).cases) {
    it(entry.id, async () => {
      const { server, root } = await machine();
      const vfs = (server as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
      vfs.writeFile('/tmp/r.conf', entry.config, 0, 0, 0o022);
      const output = (await root('radvd --logmethod stderr_clean -c -C /tmp/r.conf; echo "rc=$?"')).replace(/\n$/, '');
      const expected = `${entry.output}${entry.output === '' ? '' : '\n'}rc=${entry.exitCode}`;
      expect(output).toBe(expected);
    });
  }
});
