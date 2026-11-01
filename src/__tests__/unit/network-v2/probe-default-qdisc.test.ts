/**
 * `net.core.default_qdisc` : la discipline de file des interfaces qui n'en ont pas de propre. Ubuntu la fixe a fq_codel par
 * /etc/sysctl.d/10-bufferbloat.conf (paquet procps, texte relevé sur la machine de reference, avec son « - » initial qui fait ignorer
 * l'erreur d'ecriture). Le simulateur ecrivait « fq_codel » EN DUR a trois endroits (`ip link`, `ip -j link`, `tc qdisc show`) et n'avait
 * ni la cle ni le fichier : trois vues d'un fait qu'aucun reglage ne gouvernait (regles 2 et 3). Corrige : la cle est un fichier de
 * /proc/sys (defaut fq_codel, noms de disciplines connus seulement), les trois vues la lisent, et le fichier du paquet est livre.
 * Limite reconnue : le noyau repond ENOENT a un nom inconnu, ce que l'interface d'ecriture des fichiers generes ne sait pas encore dire ;
 * `sysctl` imprime donc « Invalid argument ».
 *
 * Discrimine par `git stash` sur src : 4 des 6 cas tombent avant. TEMOINS : `ip link` nomme fq_codel par defaut, et `lo` garde noqueue
 * quelle que soit la valeur par defaut (le second passe aussi avant : il n'y avait pas de valeur a changer).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function lab(): (command: string) => Promise<string> {
  const pc = new LinuxPC('linux-pc', 'P');
  const peer = new LinuxPC('linux-pc', 'Q');
  pc.powerOn();
  peer.powerOn();
  new Cable('c').connect(pc.getPort('eth0')!, peer.getPort('eth0')!);
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return async (command) => String(await machine.executor.runAsUser('root', () => pc.executeCommand(command))).trim();
}

describe('net.core.default_qdisc', () => {
  it('WITNESS — ip link names fq_codel by default and lo has no queue', async () => {
    const run = lab();
    expect(await run('ip link show eth0 | head -1')).toContain('qdisc fq_codel');
    expect(await run('ip link show lo | head -1')).toContain('qdisc noqueue');
  });

  it('the key is a file, fq_codel by default', async () => {
    const run = lab();
    expect(await run('cat /proc/sys/net/core/default_qdisc')).toBe('fq_codel');
    expect(await run('sysctl net.core.default_qdisc')).toBe('net.core.default_qdisc = fq_codel');
  });

  it('ip link, ip -j link and tc qdisc show follow it', async () => {
    const run = lab();
    await run('sysctl -w net.core.default_qdisc=pfifo_fast');
    expect(await run('ip link show eth0 | head -1')).toContain('qdisc pfifo_fast');
    expect(await run('ip -j link show eth0')).toContain('"qdisc":"pfifo_fast"');
    expect(await run('tc qdisc show dev eth0')).toContain('qdisc pfifo_fast 0: dev eth0 root');
  });

  it('lo keeps noqueue whatever the default is', async () => {
    const run = lab();
    await run('sysctl -w net.core.default_qdisc=fq');
    expect(await run('ip link show lo | head -1')).toContain('qdisc noqueue');
  });

  it('refuses a name that is not a queueing discipline', async () => {
    const run = lab();
    expect(await run('sysctl -w net.core.default_qdisc=banana')).toContain('Invalid argument');
    expect(await run('cat /proc/sys/net/core/default_qdisc')).toBe('fq_codel');
  });

  it('ships the package file with its leading dash and sysctl --system replays it', async () => {
    const run = lab();
    expect(await run('grep -v "^#" /etc/sysctl.d/10-bufferbloat.conf')).toBe('-net.core.default_qdisc = fq_codel');
    const replay = await run('sysctl --system 2>&1');
    expect(replay).toContain('* Applying /etc/sysctl.d/10-bufferbloat.conf ...');
    expect(replay).not.toContain('cannot stat');
  });
});
