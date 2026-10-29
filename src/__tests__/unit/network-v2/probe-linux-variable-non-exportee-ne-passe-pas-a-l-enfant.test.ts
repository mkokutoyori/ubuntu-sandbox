/*
 * Une variable du shell qui n'est pas exportee passait pourtant a l'environnement :
 * apres `X=1`, `env | grep ^X=` repondait `X=1`, et un `bash -c 'echo $X'` enfant
 * la lisait; `BASHOPTS` et `PIPESTATUS`, poses par l'interprete pour lui-meme,
 * apparaissaient dans `env` des la deuxieme commande (probe-env-ne-rend-que-
 * l-environnement); `unset Y` n'etait pas retenu d'une commande a l'autre; et un
 * script (`bash f.sh`, `./f.sh`) ne recevait qu'un environnement minimal :
 * `export Y=2; bash f.sh` ne voyait pas Y.
 *
 * Cause : l'executeur gardait toutes les variables du shell dans une seule table et
 * la passait en bloc a l'interprete comme ENVIRONNEMENT. Il retient maintenant les
 * noms que l'interprete n'exporte pas (ScriptResult.exported), les lui rend comme
 * variables locales (SHELL_ONLY_VARIABLES), les retire de l'environnement des
 * enfants, suit les `unset`, et passe l'environnement exporte aux scripts.
 *
 * Mesure avant le changement : 12 cas, 7 tombent; 5 passent des deux cotes (les 2 temoins,
 * la variable encore lisible dans le shell, exportee elle devient visible, et un script ne voit
 * pas une variable non exportee, puisqu'il ne recevait presque rien).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function lab(...lines: string[]): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  for (const line of lines) await machine.executeCommand(line);
  return machine;
}

describe('witnesses', () => {
  it('an exported variable reaches a child shell', async () => {
    expect(await (await lab('export Y=2')).executeCommand('bash -c "echo [\\$Y]"')).toBe('[2]');
  });
  it('a prefix assignment reaches the command it prefixes', async () => {
    expect(await (await lab()).executeCommand('Z=9 env | grep "^Z="')).toBe('Z=9');
  });
});

describe('a shell variable that is not exported', () => {
  it('stays out of env', async () => { expect(await (await lab('X=1')).executeCommand('env | grep -c "^X="')).toBe('0'); });
  it('stays out of printenv', async () => { expect(await (await lab('X=1')).executeCommand('printenv X; echo $?')).toBe('1'); });
  it('is still readable in the shell', async () => { expect(await (await lab('X=1')).executeCommand('echo $X')).toBe('1'); });
  it('does not reach a child shell', async () => {
    expect(await (await lab('X=1')).executeCommand('bash -c "echo [\\$X]"')).toBe('[]');
  });
  it('becomes visible once exported', async () => {
    expect(await (await lab('X=1', 'export X')).executeCommand('env | grep "^X="')).toBe('X=1');
  });
  it('keeps the shell\'s own BASHOPTS and PIPESTATUS out of env', async () => {
    expect(await (await lab('true')).executeCommand('env | grep -cE "^(BASHOPTS|PIPESTATUS)="')).toBe('0');
  });
});

describe('unset and scripts', () => {
  it('unset is remembered from one command to the next', async () => {
    expect(await (await lab('export Y=2', 'unset Y')).executeCommand('echo [$Y]')).toBe('[]');
  });
  it('a script file sees the exported variables', async () => {
    const machine = await lab('export Y=2', 'echo "echo [\\$Y]" > /tmp/s.sh');
    expect(await machine.executeCommand('bash /tmp/s.sh')).toBe('[2]');
  });
  it('a script file does not see a variable that is not exported', async () => {
    const machine = await lab('X=1', 'echo "echo [\\$X]" > /tmp/s.sh');
    expect(await machine.executeCommand('bash /tmp/s.sh')).toBe('[]');
  });
  it('a prefix assignment reaches a script file', async () => {
    const machine = await lab('echo "echo [\\$Z]" > /tmp/s.sh', 'chmod +x /tmp/s.sh');
    expect(await machine.executeCommand('Z=9 /tmp/s.sh')).toBe('[9]');
  });
});
