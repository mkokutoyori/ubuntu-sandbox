/*
 * Sonde — `su oracle` puis `sqlplus / as sysdba` dans un terminal : la session SQL*Plus interactive herite de l'identite du SHELL qui la lance (le bash du terminal lui passait l'utilisateur d'ouverture, pas celui d'apres `su`).
 *
 * Releve AVANT : `su` empile un cadre sur le shell de CE terminal et laisse l'utilisateur global de la machine inchange ; SqlPlusSubShell lisait l'utilisateur global (root)
 * pour decider de l'appartenance au groupe dba. Depuis que root n'est plus OSDBA, `oracle` (du groupe dba) se voyait refuser `/ as sysdba` par ORA-01031 dans le terminal,
 * alors que le meme `su oracle` suivi de la meme commande passait par executeCommand.
 *
 * Discrimine par `git stash push -- src/shell src/terminal` : 1 des 3 cas tombe avant (oracle admis). TEMOINS : root refuse et stagiaire refuse passent des deux cotes (ils gardent
 * le laboratoire : sans eux, un correctif qui admettrait tout le monde passerait aussi).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __setSuperuserIsOsdba } from '@/network/devices/linux/OracleOsAuthentication';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

const key = (k: string) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

async function terminal() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances();
  __setSuperuserIsOsdba(false);
  const server = new LinuxServer('linux-server', 'ORA-1', 0, 0);
  await server.executeCommand("sqlplus -s / as sysdba <<'E'\nSELECT 1 FROM dual;\nE");
  await server.executeCommand('useradd -m stagiaire');
  const session = new LinuxTerminalSession('t', server);
  await session.init();
  const type = async (line: string): Promise<string> => {
    const before = session.lines.length;
    (session as unknown as { setInputBuf(v: string): void }).setInputBuf(line);
    session.handleKey(key('Enter'));
    await flush();
    return session.lines.slice(before).map((l) => l.text).join('\n');
  };
  return { type };
}

describe('sqlplus / as sysdba in a terminal', () => {
  it('after su oracle, the session is admitted', async () => {
    const { type } = await terminal();
    await type('su oracle');
    const out = await type('sqlplus / as sysdba');
    expect(out).toMatch(/^Connected\.$/m);
    expect(out).not.toContain('ORA-01031');
  });

  it('TEMOIN — root is refused', async () => {
    const { type } = await terminal();
    expect(await type('sqlplus / as sysdba')).toContain('ORA-01031');
  });

  it('TEMOIN — an account outside dba is refused after su', async () => {
    const { type } = await terminal();
    await type('su stagiaire');
    expect(await type('sqlplus / as sysdba')).toContain('ORA-01031');
  });
});
