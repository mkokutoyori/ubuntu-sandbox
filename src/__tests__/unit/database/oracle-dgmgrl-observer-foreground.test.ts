/*
 * Sonde — `START OBSERVER` tient le terminal. Source (reference de la CLI du broker 19c, page START OBSERVER, lue le jour du developpement) : en avant-plan la commande ne rend la main que lorsque
 * l'observateur s'arrete ; `IN BACKGROUND` rend la main tout de suite. Le simulateur lui-meme est synchrone, mais le terminal sait tenir un travail d'avant-plan (ping, journalctl -f, freeradius -X) :
 * le plan de flux `dgmgrl` execute la commande, puis garde le terminal jusqu'a Ctrl-C ou jusqu'a l'arret de l'observateur (STOP OBSERVER). Un `&` ou un tube laisse le shell gerer la tache.
 *
 * Releve AVANT : la commande rendait toujours la main. La page (19c, START OBSERVER) ajoute que dans un script les commandes qui suivent un START OBSERVER d'avant-plan sont ignorees, la session devenant l'observateur : un script ne peut pas bloquer le simulateur, mais il n'execute plus rien apres.
 *
 * Discrimine par `git stash push -- src/terminal src/database src/adapters` ; le temoin IN BACKGROUND (rend la main) passe avant et apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __resetBrokers } from '@/terminal/commands/DgmgrlCommands';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { addStandbyRedoLogs, buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;
let scheduler: VirtualTimeScheduler;

beforeEach(async () => {
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); BackupKey._reset(); DeviceCatalogRegistry._reset(); __resetBrokers();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.prod, 'STARTUP MOUNT;');
  lab.sql(lab.prod, 'ALTER DATABASE ARCHIVELOG;');
  lab.sql(lab.prod, 'ALTER DATABASE OPEN;');
  lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.dr, 'STARTUP NOMOUNT;');
  lab.sh(lab.prod, `rman target / <<'EOF'\nCONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;\nDUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;\nEOF`);
});

const dgmgrl = (device: Parameters<RmanLab['sh']>[0], ...commands: string[]): string =>
  lab.sh(device, `dgmgrl / <<'EOF'\n${commands.join('\n')}\nEOF`);

const configured = (sync = true): void => {
  addStandbyRedoLogs(lab);
  dgmgrl(lab.prod, "CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
  if (sync) dgmgrl(lab.prod, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';", 'EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;');
};

const roleOf = (device: Parameters<RmanLab['sql']>[0]): string => lab.sql(device, 'SELECT database_role FROM v$database;');

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 20)); };
const type = async (session: LinuxTerminalSession, line: string): Promise<void> => {
  session.setInput(line);
  session.handleKey(key('Enter'));
  await settle();
};

describe('START OBSERVER holds the terminal', () => {
  it('in the foreground the terminal stays busy until Ctrl-C, which stops the observer', async () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    const session = new LinuxTerminalSession('term-1', lab.prod);
    await type(session, 'dgmgrl / "START OBSERVER obs1"');
    expect(session.lines.map((line) => line.text).join('\n')).toContain('Observer started');
    expect(session.hasForegroundAsyncJob).toBe(true);
    session.handleKey(key('c', { ctrlKey: true }));
    await settle();
    expect(session.hasForegroundAsyncJob).toBe(false);
    scheduler.advance(6000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(60000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  it('STOP OBSERVER typed elsewhere gives the terminal back at the next ping', async () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    const session = new LinuxTerminalSession('term-1', lab.prod);
    await type(session, 'dgmgrl / "START OBSERVER obs1"');
    expect(session.hasForegroundAsyncJob).toBe(true);
    dgmgrl(lab.prod, 'STOP OBSERVER;');
    scheduler.advance(3000);
    await settle();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('TEMOIN — IN BACKGROUND gives the terminal back at once and the observer keeps working', async () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    const session = new LinuxTerminalSession('term-1', lab.prod);
    await type(session, 'dgmgrl / "START OBSERVER obs1 IN BACKGROUND"');
    expect(session.hasForegroundAsyncJob).toBe(false);
    scheduler.advance(6000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(45000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('in a script the commands after a foreground START OBSERVER are ignored, as the page says', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    const out = dgmgrl(lab.prod, 'START OBSERVER obs1;', 'SHOW OBSERVER;');
    expect(out).toContain('Observer started');
    expect(out).not.toContain('DGMGRL> SHOW OBSERVER');
  });

  it('TEMOIN — after IN BACKGROUND the next commands of the script do run', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    const out = dgmgrl(lab.prod, 'START OBSERVER obs1 IN BACKGROUND;', 'SHOW OBSERVER;');
    expect(out).toContain('Submitted command');
    expect(out).toContain('DGMGRL> SHOW OBSERVER');
  });
});
