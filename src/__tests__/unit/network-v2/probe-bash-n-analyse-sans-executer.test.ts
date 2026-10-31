/**
 * bash(1) INVOCATION / set -n : « bash -n » et « sh -n » analysent sans exécuter, et les lettres d'option de l'invocation (-n -e -x -u) arrivent à l'interpréteur ; sorties relevées sur bash 5.1 réel.
 * Mesure de départ : le script était exécuté malgré -n. 5 des 6 cas tombent avant ; seul le témoin (script correct sans -n) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('bash -n', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("printf 'echo ran\\n' > /tmp/ok.sh");
    await pc.executeCommand("printf 'echo hi\\nif true; then\\necho x\\n' > /tmp/bad.sh");
  });

  it('bash -n ne lance pas un script correct', async () => { expect(await pc.executeCommand('bash -n /tmp/ok.sh; echo rc=$?')).toBe('rc=0'); });
  it('sh -n ne lance pas un script correct', async () => { expect(await pc.executeCommand('sh -n /tmp/ok.sh; echo rc=$?')).toBe('rc=0'); });
  it('bash -n -c ne lance pas la commande', async () => { expect(await pc.executeCommand("bash -n -c 'echo ran'; echo rc=$?")).toBe('rc=0'); });
  it('bash -n signale la fin de fichier inattendue', async () => {
    expect(await pc.executeCommand('bash -n /tmp/bad.sh; echo rc=$?')).toBe('/tmp/bad.sh: line 4: syntax error: unexpected end of file\nrc=2');
  });
  it('bash -x trace', async () => { expect(await pc.executeCommand("bash -x -c 'echo a' 2>&1")).toBe('+ echo a\na'); });
  it('témoin : sans -n le script est lancé', async () => { expect(await pc.executeCommand('bash /tmp/ok.sh')).toBe('ran'); });
});
