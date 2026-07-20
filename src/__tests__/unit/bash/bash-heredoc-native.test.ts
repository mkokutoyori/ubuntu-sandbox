/**
 * Heredoc natif du langage bash — collecté par le lexer (plus aucun
 * préprocesseur de chaînes) : délimiteur quoté = corps littéral,
 * délimiteur nu = expansion complète ($var, $(cmd), $((expr)), \$),
 * <<- avec tabulations, << à l'intérieur de quotes = texte littéral,
 * opérateur de décalage arithmétique << intact.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function pc(): LinuxPC {
  return new LinuxPC('linux-pc', 'PC', 0, 0);
}

describe('Heredoc natif dans le lexer bash', () => {
  it("délimiteur quoté ('EOF') : corps strictement littéral", async () => {
    const out = await pc().executeCommand(`cat << 'EOF'
$HOME et $(date) et $((1+1))
! # \\ backslash
EOF`);
    expect(out).toBe('$HOME et $(date) et $((1+1))\n! # \\ backslash');
  });

  it('délimiteur "EOF" (double quotes) : corps littéral aussi', async () => {
    const out = await pc().executeCommand(`cat << "EOF"
$HOME reste littéral
EOF`);
    expect(out).toBe('$HOME reste littéral');
  });

  it('délimiteur nu : $var, $(cmd), $((expr)) expandés, \\$ échappé', async () => {
    const out = await pc().executeCommand(`X=mandeng
cat << EOF
var=$X sub=$(echo ok) arith=$((6*7))
escaped=\\$X
EOF`);
    expect(out).toBe('var=mandeng sub=ok arith=42\nescaped=$X');
  });

  it('<<- : tabulations de tête retirées du corps et de la ligne délimiteur', async () => {
    const out = await pc().executeCommand(`cat <<- EOF
\tindenté par tab
\t\tdouble tab
\tEOF`);
    expect(out).toBe('indenté par tab\ndouble tab');
  });

  it("<< dans une chaîne quotée n'est PAS un heredoc (echo 'a << b')", async () => {
    const out = await pc().executeCommand(`echo 'cat << "EOF" > /tmp/x'
echo suite`);
    expect(out).toBe('cat << "EOF" > /tmp/x\nsuite');
  });

  it("un script généré contenant un heredoc quoté s'exécute intact (pas de corruption à la génération)", async () => {
    const machine = pc();
    await machine.executeCommand(`echo 'cat << "INNER" > /tmp/out.txt' > /tmp/g.sh
echo 'litteral $1$ et !' >> /tmp/g.sh
echo 'INNER' >> /tmp/g.sh`);
    expect(await machine.executeCommand('cat /tmp/g.sh')).toBe(
      'cat << "INNER" > /tmp/out.txt\nlitteral $1$ et !\nINNER',
    );
    await machine.executeCommand('bash /tmp/g.sh');
    expect(await machine.executeCommand('cat /tmp/out.txt')).toBe('litteral $1$ et !');
  });

  it("l'opérateur de décalage $(( 8 << 2 )) n'est pas confondu avec un heredoc", async () => {
    const out = await pc().executeCommand(`echo $((8 << 2))
echo apres`);
    expect(out).toBe('32\napres');
  });

  it('la famille bit-à-bit arithmétique est complète : >> & ^ | et <<=', async () => {
    const machine = pc();
    expect(await machine.executeCommand('echo $((32 >> 2))')).toBe('8');
    expect(await machine.executeCommand('echo $((12 & 10))')).toBe('8');
    expect(await machine.executeCommand('echo $((12 ^ 10))')).toBe('6');
    expect(await machine.executeCommand('echo $((12 | 10))')).toBe('14');
    expect(await machine.executeCommand('N=3; echo $((N <<= 2)); echo $N')).toBe('12\n12');
    // Précédence bash : << au-dessus des comparaisons, | en dessous de ^.
    expect(await machine.executeCommand('echo $((1 << 2 > 3))')).toBe('1');
    expect(await machine.executeCommand('echo $((2 | 1 ^ 1))')).toBe('2');
  });

  it('heredoc suivi d\'une redirection : cat << EOF > fichier', async () => {
    const machine = pc();
    await machine.executeCommand(`cat << 'EOF' > /tmp/hd.txt
ligne 1
ligne 2
EOF`);
    expect(await machine.executeCommand('cat /tmp/hd.txt')).toBe('ligne 1\nligne 2');
    expect((await machine.executeCommand('wc -l < /tmp/hd.txt')).trim()).toBe('2');
  });

  it('heredoc alimentant un pipe : cat << EOF | grep', async () => {
    const out = await pc().executeCommand(`cat << 'EOF' | grep motif
sans
avec motif ici
EOF`);
    expect(out).toBe('avec motif ici');
  });

  it('deux heredocs sur la même ligne logique : corps collectés dans l\'ordre', async () => {
    const out = await pc().executeCommand(`cat << 'A' && cat << 'B'
premier corps
A
second corps
B`);
    expect(out).toBe('premier corps\nsecond corps');
  });

  it('le corps peut contenir des lignes ressemblant à des commandes sans être exécutées', async () => {
    const out = await pc().executeCommand(`cat << 'EOF'
rm -rf /
exit 1
EOF
echo encore-la`);
    expect(out).toBe('rm -rf /\nexit 1\nencore-la');
  });
});
