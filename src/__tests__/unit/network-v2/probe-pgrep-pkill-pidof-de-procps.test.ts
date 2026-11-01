/**
 * procps-ng 4.0.4 pgrep/pkill et sysvinit pidof : -c, -d, -n, -o, -v, -P, -u (nom invalide), motif trop long, message « no matching criteria », pidof -s/-q/-o ; sorties relevées sur les binaires réels de cette machine.
 * Mesure de départ : -c et -d ne rendaient rien, -n rendait zéro ligne, pidof -s listait tous les pids, un utilisateur inconnu n'était pas signalé. 11 des 14 cas tombent avant ; passent dans les deux états : les témoins de sélection simple (-x, -l) et pidof -q.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('pgrep / pkill / pidof', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sleep 301 &');
    await pc.executeCommand('sleep 302 &');
  });
  const run = (command: string): Promise<string> => pc.executeCommand(command);
  const shape = (command: string): Promise<string> => run(`${command} | tr 0-9 N`);

  it('témoin : -x compte deux processus', async () => { expect(await run('pgrep -x sleep | wc -l')).toBe('2'); });
  it('témoin : -l rend « pid nom »', async () => { expect(await run("pgrep -l -x sleep | sed 's/^[0-9]*/PID/'")).toBe('PID sleep\nPID sleep'); });
  it('-c compte', async () => { expect(await run('pgrep -c -x sleep')).toBe('2'); });
  it('-c sans correspondance rend 0 et le code 1', async () => { expect(await run('pgrep -c nomatchxx; echo rc=$?')).toBe('0\nrc=1'); });
  it('-d sépare', async () => { expect(await run("pgrep -d, -x sleep | sed 's/[0-9]*/N/g'")).toBe('N,N'); });
  it('-n ne rend qu\'un pid', async () => { expect(await run('pgrep -n -x sleep | wc -l')).toBe('1'); });
  it('-o ne rend qu\'un pid', async () => { expect(await run('pgrep -o -x sleep | wc -l')).toBe('1'); });
  it('-a rend la ligne de commande', async () => { expect(await run("pgrep -a -x sleep | sed 's/^[0-9]*/PID/' | sort")).toBe('PID sleep 301\nPID sleep 302'); });
  it('utilisateur inconnu', async () => { expect(await run('pgrep -u nosuchuser sleep; echo rc=$?')).toBe('pgrep: invalid user name: nosuchuser\nrc=2'); });
  it('numéro invalide', async () => { expect(await run('pgrep -P abc x; echo rc=$?')).toBe('pgrep: not a number: abc\nrc=2'); });
  it('motif de plus de 15 caractères', async () => {
    expect(await run('pgrep averyverylongprocessnamexx; echo rc=$?')).toBe("pgrep: pattern that searches for process name longer than 15 characters will result in zero matches\nTry `pgrep -f' option to match against the complete command line.\nrc=1");
  });
  it('aucun critère', async () => { expect(await run('pgrep -l; echo rc=$?')).toBe("pgrep: no matching criteria specified\nTry `pgrep --help' for more information.\nrc=2"); });
  it('pidof -s ne rend qu\'un pid', async () => { expect(await shape('pidof -s sleep')).toMatch(/^N+$/); });
  it('pidof -q se tait', async () => { expect(await run('pidof -q sleep; echo rc=$?')).toBe('rc=0'); });
});
