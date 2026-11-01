/**
 * Les reglages que le paquet procps d'Ubuntu 24.04 pose au demarrage par /etc/sysctl.d/10-*.conf (fichiers lus sur la machine de
 * reference) : kernel.kptr_restrict = 1, kernel.sysrq = 176, kernel.yama.ptrace_scope = 1, vm.max_map_count = 1048576,
 * vm.mmap_min_addr = 65536, plus kernel.pid_max = 4194304 par /usr/lib/sysctl.d/50-pid-max.conf. Le simulateur n'avait AUCUNE de ces cles
 * (`sysctl -w vm.max_map_count=262144`, geste courant des labs Elasticsearch, repondait « cannot stat ») ni les fichiers.
 * Corrige : cinq fichiers de /proc/sys, bornes du noyau, fichiers du paquet livres, `sysctl --system` les rejoue sans erreur.
 * RESERVE ASSUMEE (regle 6, cas d'une machine qui ACCEPTE un reglage que le moteur ne peut pas honorer) : ces cinq reglages sont stockes et
 * rendus, aucun lecteur ne les evalue, faute de la fonction qu'ils gouvernent (pas de clavier pour le SysRq : /proc/sysrq-trigger ignore
 * d'ailleurs le masque, __handle_sysrq(c, false) ; pas de ptrace ; pas de /proc/kallsyms ; pas de modele de memoire par processus).
 * `rp_filter` et `use_tempaddr`, qui rejettent ou changent de vrais paquets, restent NON livres plutot que stockes sans effet.
 *
 * Discrimine par `git stash` sur src : 8 des 9 cas tombent avant. TEMOIN : kernel.pid_max se relit, c'est deja le cas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function lab(): (command: string) => Promise<string> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return async (command) => String(await machine.executor.runAsUser('root', () => pc.executeCommand(command))).trim();
}

describe('the settings Ubuntu ships in sysctl.d', () => {
  it('WITNESS — kernel.pid_max is readable', async () => {
    expect(await lab()('sysctl -n kernel.pid_max')).toBe('4194304');
  });

  it.each([
    ['kernel.kptr_restrict', '1'],
    ['kernel.sysrq', '176'],
    ['kernel.yama.ptrace_scope', '1'],
    ['vm.max_map_count', '1048576'],
    ['vm.mmap_min_addr', '65536'],
  ])('%s starts at the Ubuntu value %s', async (key, value) => {
    expect(await lab()(`sysctl -n ${key}`)).toBe(value);
  });

  it('vm.max_map_count can be raised, the Elasticsearch lab gesture', async () => {
    const run = lab();
    expect(await run('sysctl -w vm.max_map_count=262144')).toBe('vm.max_map_count = 262144');
    expect(await run('cat /proc/sys/vm/max_map_count')).toBe('262144');
  });

  it('keeps the kernel bounds', async () => {
    const run = lab();
    expect(await run('sysctl -w kernel.kptr_restrict=3')).toContain('Invalid argument');
    expect(await run('sysctl -w kernel.yama.ptrace_scope=4')).toContain('Invalid argument');
    expect(await run('sysctl -n kernel.kptr_restrict')).toBe('1');
  });

  it('ships the package files and sysctl --system replays them all without error', async () => {
    const run = lab();
    const replay = await run('sysctl --system 2>&1');
    for (const file of ['10-kernel-hardening', '10-magic-sysrq', '10-map-count', '10-ptrace', '10-zeropage']) {
      expect(replay).toContain(`* Applying /etc/sysctl.d/${file}.conf ...`);
    }
    expect(replay).toContain('* Applying /usr/lib/sysctl.d/50-pid-max.conf ...');
    expect(replay).not.toContain('cannot stat');
  });
});
