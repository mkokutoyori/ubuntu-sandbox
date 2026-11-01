/**
 * `HOST` sans commande, dans RMAN, ouvre un shell interactif sur la machine ; en le quittant (`exit`) on revient au `RMAN>` de la MEME session, avec la
 * ligne `host command complete`. Le simulateur refusait la forme nue (RMAN-01009) ; de plus, quitter un sous-shell EMPILE au-dessus d'un autre ramenait tout en
 * haut (`exitSubShell` vidait la pile et ne la depilait jamais), donc un shell ouvert depuis RMAN aurait emporte RMAN avec lui. Le texte `host command complete` est celui de
 * `HOST 'commande'` deja livre ; son emission au retour d'un shell interactif n'est PAS source (docs.oracle.com inaccessible), voir TODO.md.
 *
 * SQL*Plus : `host` ou `!` nus repondaient SP2-0738 (« interactive HOST subshell is not supported ») ; ils ouvrent maintenant le meme shell, par le meme mecanisme (SubShellResult.hostShell,
 * AbstractShell.openOsShell), et `exit` revient a SQL> sans rien ecrire (comme le vrai). 2 des 3 cas SQL*Plus tombent avant ; le temoin est `HOST commande`.
 *
 * Discrimine par `git stash` sur src : 3 des 5 cas RMAN tombent avant. TEMOIN : `HOST 'commande'` continue de marcher. « Quitter RMAN ramene au shell » passe avant pour une mauvaise
 * raison (la forme nue etait refusee, donc `exit` quittait RMAN directement) ; sa valeur est de prouver que le dépilage ne laisse pas la session coincee dans RMAN.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SELECT 1 FROM dual;');
});

const key = (k: string) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

async function terminal() {
  lab.prod.powerOn();
  const session = new LinuxTerminalSession('t', lab.prod);
  await session.init();
  const type = async (line: string): Promise<string[]> => {
    const before = session.lines.length;
    (session as unknown as { setInputBuf(v: string): void }).setInputBuf(line);
    session.handleKey(key('Enter'));
    await flush();
    return session.lines.slice(before).map((l) => l.text);
  };
  await type('rman target /');
  return { session, type };
}

describe('HOST with no command', () => {
  it('TEMOIN — HOST with a command still runs it', async () => {
    const { type } = await terminal();
    const out = (await type("host 'echo from-the-host';")).join('\n');
    expect(out).toContain('from-the-host');
    expect(out).toContain('host command complete');
  });

  it('opens a shell: the next line runs on the machine, not in RMAN', async () => {
    const { type } = await terminal();
    await type('host;');
    const out = (await type('echo inside-the-shell')).join('\n');
    expect(out).toContain('inside-the-shell');
    expect(out).not.toContain('RMAN-');
  });

  it('exit comes back to RMAN with host command complete', async () => {
    const { type } = await terminal();
    await type('host;');
    const out = (await type('exit')).join('\n');
    expect(out).toContain('host command complete');
  });

  it('after exit the session is still in RMAN, not at the shell prompt', async () => {
    const { type, session } = await terminal();
    await type('host;');
    await type('exit');
    expect(session.getPrompt()).toBe('RMAN> ');
    expect((await type('list backup summary;')).join('\n')).not.toMatch(/command not found/);
  });

  it('leaving RMAN afterwards returns to the shell of the session', async () => {
    const { type, session } = await terminal();
    await type('host;');
    await type('exit');
    await type('exit');
    expect(session.getPrompt()).not.toBe('RMAN> ');
    expect((await type('echo back-at-bash')).join('\n')).toContain('back-at-bash');
  });
});

describe('HOST with no command, in SQL*Plus', () => {
  async function sqlplus() {
    lab.prod.powerOn();
    const session = new LinuxTerminalSession('t', lab.prod);
    await session.init();
    const type = async (line: string): Promise<string[]> => {
      const before = session.lines.length;
      (session as unknown as { setInputBuf(v: string): void }).setInputBuf(line);
      session.handleKey(key('Enter'));
      await flush();
      return session.lines.slice(before).map((l) => l.text);
    };
    await type('sqlplus / as sysdba');
    return { session, type };
  }

  it('opens a shell, and exit comes back to SQL> in the same session', async () => {
    const { type, session } = await sqlplus();
    await type('host');
    expect((await type('echo inside-sqlplus-shell')).join('\n')).toContain('inside-sqlplus-shell');
    await type('exit');
    expect(session.getPrompt()).toBe('SQL> ');
  });

  it('! is the same escape', async () => {
    const { type, session } = await sqlplus();
    await type('!');
    expect((await type('echo via-bang')).join('\n')).toContain('via-bang');
    await type('exit');
    expect(session.getPrompt()).toBe('SQL> ');
  });

  it('WITNESS — HOST with a command still runs it and stays in SQL>', async () => {
    const { type, session } = await sqlplus();
    expect((await type('host echo one-shot')).join('\n')).toContain('one-shot');
    expect(session.getPrompt()).toBe('SQL> ');
  });
});
