/**
 * Bash lit un script commande par commande : un `shopt -s extglob` pose par un `source` ou par une fonction, sur une
 * ligne precedente, vaut pour les lignes suivantes, et le globbing de chemins honore l'option. Mesure de depart sur la
 * machine (bash 5.2.21, repertoire d avec les fichiers a b c) :
 *   source ./lib.sh (shopt -s extglob) ; cd d ; echo +(a|b) !(a) @(a|c)  -> a b b c a c
 *   f() { shopt -s extglob; } ; f ; cd d ; echo +(a|b) ?(a)               -> a b a
 *   cd d ; echo @(a|c)  (extglob jamais pose)                             -> syntax error near unexpected token `(' (sortie 2)
 *   echo before ; shopt -s extglob ; cd d ; echo !(b) ; echo @(a          -> before / a c / `unexpected EOF while looking for matching `)'` (sortie 2)
 * Le simulateur lisait extglob dans le TEXTE du script (TODO.md [bash-ecarts-restants]) : `source` ou fonction -> erreur
 * de syntaxe a la ligne suivante ; et l'expansion de chemins ignorait l'option (`echo +(a|b)` restait litteral, meme
 * apres un `shopt -s extglob` ecrit dans le script).
 * Corrige : quand l'analyse en mode « declare » echoue et que l'option est active a l'execution, le reste du script est
 * relu avec l'option (Program.resume), et hasMagic / globPaths / VirtualFileSystem.globExpand portent `extglob`.
 *
 * Un motif etendu non ferme dit « line N: unexpected EOF while looking for matching `)' » ou N est la ligne OU LE MOTIF
 * S'OUVRE (relevee : `echo @(a b` puis `echo x` -> line 3), les commandes precedentes ayant tourne ; le simulateur
 * ecrivait « syntax error near unexpected token `(' ».
 *
 * Discrimine par `git stash` sur src/bash et src/network, en deux temps : 3 des 7 cas tombent avant la lecture de
 * l'option au moment de l'execution (source, fonction, globbing in-script), puis 2 avant le message du motif non ferme.
 * TEMOINS, verts avant comme apres : l'erreur de syntaxe sans extglob et un motif ferme qui s'etend sur plusieurs mots.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  await pc.executeCommand('mkdir -p /tmp/d');
  await pc.executeCommand('sh -c "cd /tmp/d; touch a b c"');
  await pc.executeCommand(`printf 'shopt -s extglob\\n' > /tmp/lib.sh`);
  return pc;
}

const script = async (pc: LinuxPC, body: string): Promise<string> => {
  await pc.executeCommand(`printf '${body}' > /tmp/t.sh`);
  return String(await pc.executeCommand('bash /tmp/t.sh')).trim();
};

describe('extglob set by another command of the script', () => {
  it('a sourced file that sets extglob applies to the following lines', async () => {
    const out = await script(await lab(), 'source /tmp/lib.sh\\ncd /tmp/d\\necho +(a|b) !(a) @(a|c)\\n');
    expect(out).toBe('a b b c a c');
  });

  it('a function that sets extglob applies once it has run', async () => {
    const out = await script(await lab(), 'f() { shopt -s extglob; }\\nf\\ncd /tmp/d\\necho +(a|b) ?(a)\\n');
    expect(out).toBe('a b a');
  });

  it('pathname expansion honours extglob set earlier in the same script', async () => {
    const out = await script(await lab(), 'shopt -s extglob\\ncd /tmp/d\\necho !(b)\\n');
    expect(out).toBe('a c');
  });

  it('WITNESS — without extglob an extended pattern is a syntax error', async () => {
    const out = await script(await lab(), 'cd /tmp/d\\necho @(a|c)\\n');
    expect(out).toContain("syntax error near unexpected token `('");
  });

  it('an unterminated extended pattern names the line where it opens, after the earlier commands ran', async () => {
    const out = await script(await lab(), 'shopt -s extglob\\necho b\\necho @(a b\\necho x\\n');
    expect(out).toBe("b\n/tmp/t.sh: line 3: unexpected EOF while looking for matching `)'");
  });

  it('the same refusal when the pattern is the whole last line, without a trailing newline', async () => {
    const out = await script(await lab(), 'shopt -s extglob\\necho @(a|b');
    expect(out).toBe("/tmp/t.sh: line 2: unexpected EOF while looking for matching `)'");
  });

  it('WITNESS — a closed pattern that spans several words is expanded', async () => {
    const out = await script(await lab(), 'shopt -s extglob\\ncd /tmp/d\\necho @(a|c)\\n');
    expect(out).toBe('a c');
  });
});
