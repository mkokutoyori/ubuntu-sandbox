/**
 * bash 5.2 diagnostics : une erreur de syntaxe dans un $(...) entre guillemets est relevée au parsage, et un script lu sur l'entrée standard s'annonce « bash: line N: » (« bash: -c: line N: » reste pour -c) ; sorties relevées sur le bash réel de cette machine.
 * Mesure de départ : `echo "$(if)"` exécutait « if » (command not found) et le libellé stdin était « bash: -c ». 2 des 4 cas tombent avant ; passent dans les deux états : le témoin (-c) et le $() correct entre guillemets (non-régression).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('diagnostics bash', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand(`printf 'echo hi\\necho "$(if)"\\necho after\\n' > /tmp/q.sh`);
    await pc.executeCommand(`printf 'echo "ok $(echo a) $((1+2))"\\n' > /tmp/ok.sh`);
  });

  it('erreur dans un $() entre guillemets', async () => {
    expect(await pc.executeCommand('cd /tmp; bash q.sh; echo rc=$?')).toBe("hi\nq.sh: line 2: syntax error near unexpected token `)'\nq.sh: line 2: `echo \"$(if)\"'\nrc=2");
  });
  it('un $() et un $(()) corrects entre guillemets passent', async () => { expect(await pc.executeCommand('cd /tmp; bash ok.sh')).toBe('ok a 3'); });
  it('script lu sur l\'entrée standard', async () => {
    expect(await pc.executeCommand("printf 'echo hi\\nfi\\n' | bash; echo rc=$?")).toBe("hi\nbash: line 2: syntax error near unexpected token `fi'\nbash: line 2: `fi'\nrc=2");
  });
  it('témoin : -c garde son libellé', async () => {
    expect(await pc.executeCommand("bash -c 'echo hi\nfi'; echo rc=$?")).toBe("hi\nbash: -c: line 2: syntax error near unexpected token `fi'\nbash: -c: line 2: `fi'\nrc=2");
  });
});
