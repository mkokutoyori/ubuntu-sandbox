/**
 * dash 0.5.12 (Ubuntu 24.04) : « dash -n » et « sh -n » rendent les diagnostics d'analyse de dash (« t.sh: 2: Syntax error: end of file unexpected (expecting "fi") ») et non ceux de bash ; 48 scripts rejoués sur le vrai dash de cette machine, sortie relevée avec « dash -n t.sh ».
 * Mesure de départ : la machine n'avait pas de commande dash, et sh parlait comme bash (« syntax error near unexpected token »). Les 49 cas tombent avant ; passe dans les deux états : le témoin bash -n, dont le format ne change pas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["echo \"abc\n", "t.sh: 2: Syntax error: Unterminated quoted string"],
  ["echo 'abc\n", "t.sh: 2: Syntax error: Unterminated quoted string"],
  ["if true; then echo x\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"fi\")"],
  ["echo x; fi\n", "t.sh: 1: Syntax error: \"fi\" unexpected"],
  ["for i in 1 2; do echo $i\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"done\")"],
  ["case x in a) echo;;\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \")\")"],
  ["echo (x)\n", "t.sh: 1: Syntax error: word unexpected (expecting \")\")"],
  ["echo x ||\n", "t.sh: 2: Syntax error: end of file unexpected"],
  ["echo ${x\n", "t.sh: 1: Syntax error: Missing '}'"],
  ["echo $(echo x\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \")\")"],
  ["while true; do\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"done\")"],
  ["f() {\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"}\")"],
  ["done\n", "t.sh: 1: Syntax error: \"done\" unexpected"],
  ["echo x; esac\n", "t.sh: 1: Syntax error: \"esac\" unexpected"],
  ["x=1; ; echo\n", "t.sh: 1: Syntax error: \";\" unexpected"],
  ["echo a && && echo b\n", "t.sh: 1: Syntax error: \"&&\" unexpected"],
  ["echo `echo x\n", "t.sh: 2: Syntax error: EOF in backquote substitution"],
  ["{ echo x\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"}\")"],
  ["( echo x\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \")\")"],
  ["echo x)\n", "t.sh: 1: Syntax error: \")\" unexpected"],
  ["case x in\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \")\")"],
  ["case x in a) echo\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \";;\")"],
  ["case x in a)\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \";;\")"],
  ["case x in a) echo;;\nb)\n", "t.sh: 3: Syntax error: end of file unexpected (expecting \";;\")"],
  ["if true; then\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"fi\")"],
  ["if true; then echo; else\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"fi\")"],
  ["if true\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"then\")"],
  ["for i in 1; do\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"done\")"],
  ["for i in 1\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"do\")"],
  ["until true; do\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"done\")"],
  ["f() {\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"}\")"],
  ["f()\n", "t.sh: 2: Syntax error: end of file unexpected"],
  ["( \n", "t.sh: 2: Syntax error: end of file unexpected (expecting \")\")"],
  ["{ echo; \n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"}\")"],
  ["while true; do (\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \")\")"],
  ["echo x |\n", "t.sh: 2: Syntax error: end of file unexpected"],
  ["if true; then { echo\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"}\")"],
  ["echo $((1+\n", "t.sh: 2: Syntax error: Missing '))'"],
  ["echo \"x\n", "t.sh: 2: Syntax error: Unterminated quoted string"],
  ["echo x &&\n", "t.sh: 2: Syntax error: end of file unexpected"],
  ["if ; then x; fi\n", "t.sh: 1: Syntax error: \";\" unexpected"],
  ["if true; then ; fi\n", "t.sh: 1: Syntax error: \";\" unexpected"],
  ["echo >\n", "t.sh: 2: Syntax error: newline unexpected"],
  ["echo <\n", "t.sh: 2: Syntax error: newline unexpected"],
  ["echo ;;\n", "t.sh: 1: Syntax error: \";;\" unexpected"],
  ["if true; then echo; elif\n", "t.sh: 2: Syntax error: end of file unexpected (expecting \"then\")"],
  ["case x in a) echo;; esac esac\n", "t.sh: 1: Syntax error: \"esac\" unexpected"],
  ["echo x &&\n\n", "t.sh: 3: Syntax error: end of file unexpected"],
];

describe('diagnostics d\'analyse de dash', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });
  const check = async (command: 'dash' | 'sh', script: string): Promise<string> => {
    await pc.executeCommand(`cat > /tmp/t.sh <<'EOF'\n${script}EOF`);
    return (await pc.executeCommand(`cd /tmp; ${command} -n t.sh 2>&1`)).trim();
  };

  for (const [script, expected] of CASES) {
    it(`dash -n ${JSON.stringify(script)}`, async () => { expect(await check('dash', script)).toBe(expected); });
  }
  it('sh -n parle comme dash, /bin/sh étant dash sur Ubuntu', async () => {
    expect(await check('sh', 'if true; then echo x\n')).toBe('t.sh: 2: Syntax error: end of file unexpected (expecting "fi")');
  });
  it('témoin : bash -n garde son format', async () => {
    expect(await check('bash' as 'dash', 'if true; then echo x\n')).toBe('t.sh: line 2: syntax error: unexpected end of file');
  });
});
