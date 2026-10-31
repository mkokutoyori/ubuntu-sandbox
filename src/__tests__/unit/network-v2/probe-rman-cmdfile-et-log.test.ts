/**
 * `rman target / cmdfile=x.rman log=x.log` (et `rman target / @x.rman`) est la forme des sauvegardes lancees par cron : le
 * fichier de commandes s'execute en lot et, avec `log=`, la sortie va dans le journal et non a l'ecran (`append` ajoute au
 * journal). Mesure de depart : le simulateur ignorait les deux options, et dans le terminal interactif la ligne ouvrait le
 * REPL `RMAN>` au lieu de s'executer. Corrige : RmanInvocation lit cmdfile / @ / log / append ; LinuxServer lit le fichier
 * dans le VFS de la machine et ecrit le journal ; le lanceur de shell ne pousse plus un sous-shell pour une ligne en lot ;
 * le code de sortie reste 1 si le journal contient une erreur RMAN-/ORA-.
 * Non source (TODO.md [rman]) : le texte d'un fichier de commandes introuvable, ici `cmdfile=<f>: No such file or directory`.
 *
 * Discrimine par `git stash` sur src : 5 des 7 cas tombent avant. TEMOINS : l'entree par stdin (heredoc) et la ligne
 * `rman target /` seule, qui valent avant comme apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { isBatchRmanLine, parseRmanInvocation } from '@/terminal/subshells/rman/RmanInvocation';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SELECT 1 FROM dual;');
});

const run = async (command: string): Promise<string> => String(await lab.prod.executeCommand(command));
const writeFile = (path: string, lines: readonly string[]) =>
  run(`printf '${lines.join('\\n')}\\n' > ${path}`);

describe('invocation parsing', () => {
  it('reads cmdfile=, @file, log= and append, with or without quotes', () => {
    expect(parseRmanInvocation(['target', '/', 'cmdfile=/a.rman', 'log=/a.log', 'append']))
      .toEqual({ commandFile: '/a.rman', logFile: '/a.log', appendToLog: true });
    expect(parseRmanInvocation(['target', '/', '@/b.rman']).commandFile).toBe('/b.rman');
    expect(parseRmanInvocation(['cmdfile="/c d.rman"']).commandFile).toBe('/c d.rman');
    expect(isBatchRmanLine('rman target / cmdfile=/a.rman')).toBe(true);
    expect(isBatchRmanLine('rman target /')).toBe(false);
  });
});

describe('rman cmdfile and log', () => {
  it('TEMOIN — commands read on standard input still run', async () => {
    const out = await run("printf 'CONNECT TARGET /;\\nLIST BACKUP SUMMARY;\\n' | rman");
    expect(out).toContain('Recovery Manager');
  });

  it('cmdfile= runs the commands of the file and prints their output', async () => {
    await writeFile('/tmp/a.rman', ['CONNECT TARGET /;', "BACKUP DATABASE TAG 'CMD1';"]);
    const out = await run('rman target / cmdfile=/tmp/a.rman');
    expect(out).toContain('Starting backup');
    expect(out).toContain('CMD1');
  });

  it('@file is the same as cmdfile=', async () => {
    await writeFile('/tmp/b.rman', ['CONNECT TARGET /;', "BACKUP DATABASE TAG 'AT1';"]);
    expect(await run('rman target / @/tmp/b.rman')).toContain('AT1');
  });

  it('log= sends the output to the file and none to the screen', async () => {
    await writeFile('/tmp/c.rman', ['CONNECT TARGET /;', "BACKUP DATABASE TAG 'LOG1';"]);
    const screen = await run('rman target / cmdfile=/tmp/c.rman log=/tmp/c.log');
    expect(screen.trim()).toBe('');
    expect(await run('cat /tmp/c.log')).toContain('LOG1');
  });

  it('append adds to an existing log instead of replacing it', async () => {
    await writeFile('/tmp/d.rman', ['CONNECT TARGET /;', "BACKUP DATABASE TAG 'FIRST';"]);
    await writeFile('/tmp/e.rman', ['CONNECT TARGET /;', 'LIST BACKUP SUMMARY;']);
    await run('rman target / cmdfile=/tmp/d.rman log=/tmp/f.log');
    await run('rman target / cmdfile=/tmp/e.rman log=/tmp/f.log append');
    const log = await run('cat /tmp/f.log');
    expect(log).toContain('FIRST');
    expect(log).toContain('List of Backups');
  });

  it('the exit status is 1 when the log holds an RMAN error, 0 otherwise', async () => {
    await writeFile('/tmp/bad.rman', ['CONNECT TARGET /;', 'FROBNICATE;']);
    await writeFile('/tmp/good.rman', ['CONNECT TARGET /;', 'LIST BACKUP SUMMARY;']);
    expect((await run('rman target / cmdfile=/tmp/bad.rman log=/tmp/bad.log; echo rc=$?')).trim()).toBe('rc=1');
    expect((await run('rman target / cmdfile=/tmp/good.rman log=/tmp/good.log; echo rc=$?')).trim()).toBe('rc=0');
  });
});
