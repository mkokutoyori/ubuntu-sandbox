/**
 * Probes — le canal d'entrée standard de `LinuxCommand`.
 *
 * Le contrat du registre n'avait pas de `stdin`. L'interpréteur bash
 * colle le contenu canalisé en dernier mot d'`argv`, et chaque commande
 * devait le deviner de là. Une mesure de ce qui arrive réellement montre
 * pourquoi c'est indécidable :
 *
 *     printf abc | cmd -x   →  ['-x', 'abc']
 *     cmd fichier.txt       →  ['fichier.txt']
 *
 * Même forme, sens opposé. Le discriminant employé jusqu'ici — « le mot
 * contient un saut de ligne » — lit donc toute canalisation d'une seule
 * ligne comme un nom de fichier.
 *
 * `ExternalRequest.stdin` porte désormais le contenu jusqu'aux deux
 * ponts du registre, et `LinuxCommand.readsStdin` dit lesquelles des
 * commandes le veulent en paramètre. Ces probes vérifient les deux
 * chemins de dispatch — celui du prompt (asynchrone) et celui des
 * scripts et substitutions (synchrone) — et la compatibilité des
 * commandes qui ne déclarent rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { LinuxCommand } from '@/network/devices/linux/commands/LinuxCommand';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

interface Seen { args: string[]; stdin?: string }

function lab(): { pc: LinuxPC; seen: Seen[] } {
  const seen: Seen[] = [];
  const declared: LinuxCommand = {
    name: 'probestdin',
    needsNetworkContext: true,
    readsStdin: true,
    run(_ctx, args, stdin) {
      seen.push({ args: [...args], stdin });
      return 'ok';
    },
  };
  const silent: LinuxCommand = {
    name: 'probesilent',
    needsNetworkContext: true,
    run(_ctx, args, stdin) {
      seen.push({ args: [...args], stdin });
      return 'ok';
    },
  };
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  const registry = (pc as unknown as { commands: { register(c: LinuxCommand): void } }).commands;
  registry.register(declared);
  registry.register(silent);
  return { pc, seen };
}

describe('Scénario 1 — une commande qui déclare `readsStdin`', () => {
  it('reçoit le contenu en paramètre, et un argv débarrassé de lui', async () => {
    const { pc, seen } = lab();
    await pc.executeCommand('printf "a\\nb\\n" | probestdin -x');
    expect(seen).toHaveLength(1);
    expect(seen[0].args).toEqual(['-x']);
    expect(seen[0].stdin).toBe('a\nb\n');
  });

  it('le reçoit aussi quand il ne contient aucun saut de ligne', async () => {
    const { pc, seen } = lab();
    // Le cas que l'ancienne heuristique lisait comme un nom de fichier.
    await pc.executeCommand('printf "abc" | probestdin -x');
    expect(seen[0].args).toEqual(['-x']);
    expect(seen[0].stdin).toBe('abc');
  });

  it('sans canalisation, `stdin` est absent — pas une chaîne vide', async () => {
    const { pc, seen } = lab();
    await pc.executeCommand('probestdin fichier.txt');
    expect(seen[0].args).toEqual(['fichier.txt']);
    // `undefined` distingue « rien sur l'entrée » de « une entrée vide ».
    expect(seen[0].stdin).toBeUndefined();
  });

  it('une chaîne ici-même (`<<<`) est de l\'entrée standard comme une autre', async () => {
    const { pc, seen } = lab();
    await pc.executeCommand('probestdin <<< "ici"');
    expect(seen[0].args).toEqual([]);
    expect(seen[0].stdin).toBe('ici\n');
  });
});

describe('Scénario 2 — les deux ponts se comportent pareil', () => {
  it('la substitution de commande passe par le dispatch synchrone', async () => {
    const { pc, seen } = lab();
    const out = await pc.executeCommand('echo "R=$(printf abc | probestdin -x)"');
    expect(out).toContain('R=ok');
    expect(seen[0].args).toEqual(['-x']);
    expect(seen[0].stdin).toBe('abc');
  });

  it('un script obtient le même découpage que le prompt', async () => {
    const { pc, seen } = lab();
    await pc.executeCommand('echo "printf hello | probestdin -x" > s.sh');
    await pc.executeCommand('chmod +x s.sh');
    await pc.executeCommand('./s.sh');
    expect(seen).toHaveLength(1);
    expect(seen[0].args).toEqual(['-x']);
    expect(seen[0].stdin).toBe('hello');
  });
});

describe('Scénario 3 — ce qui ne déclare rien ne change pas', () => {
  it('une commande sans `readsStdin` voit toujours le mot de queue', async () => {
    const { pc, seen } = lab();
    await pc.executeCommand('printf "a\\nb\\n" | probesilent -x');
    // Exactement la forme d'avant le canal : rien à ré-écrire dans les
    // 88 commandes du registre qui ne lisent pas l'entrée standard.
    expect(seen[0].args).toEqual(['-x', 'a\nb\n']);
    expect(seen[0].stdin).toBeUndefined();
  });
});

describe('Scénario 4 — les commandes réelles qui s\'en servent', () => {
  it('`xxd` vide une canalisation d\'une seule ligne, pas un fichier de ce nom', async () => {
    const { pc } = lab();
    const out = await pc.executeCommand('printf "abc" | xxd');
    expect(out).toContain('6162 63');
    expect(out).not.toContain('No such file');
  });

  it('`tac` distingue le fichier de la canalisation', async () => {
    const { pc } = lab();
    await pc.executeCommand('printf "un\\ndeux\\n" > a.txt');
    expect(await pc.executeCommand('tac a.txt')).toBe('deux\nun');
    expect(await pc.executeCommand('printf "un\\ndeux\\n" | tac')).toBe('deux\nun');
  });
});
