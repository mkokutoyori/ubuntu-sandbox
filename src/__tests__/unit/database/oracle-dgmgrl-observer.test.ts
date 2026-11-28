/*
 * Sonde — l'observateur et le fast-start failover du broker. Les textes sont ceux de la documentation Oracle Data Guard Broker (26ai, lue le jour du developpement, docs.oracle.com) :
 * ENABLE FAST_START FAILOVER -> `Enabled in Zero Data Loss Mode.` (page ENABLE FAST_START FAILOVER, exemple 1) ; DISABLE FAST_START FAILOVER -> `Disabled.` ; START OBSERVER -> `Observer started`
 * et, en arriere-plan, `Submitted command "START OBSERVER" using connect identifier "..."` ; STOP OBSERVER -> la page ne montre pas de sortie, le simulateur dit `Done.` (texte de la page de depannage) ;
 * SHOW FAST_START FAILOVER et SHOW OBSERVER suivent les dispositions des pages du meme nom ; sans observateur, `Warning: ORA-16819: fast-start failover observer not started` sous chaque membre et
 * `WARNING` comme etat ; `ORA-16693: requirements not met for enabling fast-start failover` quand le mode de protection est MaxAvailability mais que la cible n'est pas en SYNC (page d'erreur ORA-16693) ;
 * `ORA-16844` sans cible valide ; `ORA-16647` au-dela du nombre maximal d'observateurs (3 de la 12.2 a la 19c).
 * L'observateur est un acteur planifie (IScheduler) sur la machine ou tourne dgmgrl : toutes les 3000 ms (Ping Interval) il joint la primaire par une session Oracle Net, et quand elle se tait
 * depuis FastStartFailoverThreshold secondes (30 par defaut) et que la cible repond, il lance le FAILOVER sur la cible puis l'ouvre. START OBSERVER rend la main au lieu de bloquer (limite connue) ;
 * le mode Potential Data Loss (MaxPerformance, FastStartFailoverLagLimit) n'est pas implemente : son texte de sortie n'est pas dans la documentation lue.
 *
 * Discrimine par `git stash push -- src/terminal src/database src/adapters` : les 9 cas tombent, le temoin aussi puisque la ligne `Fast-Start Failover:` valait `Disabled` (de memoire) et vaut maintenant `DISABLED`
 * comme la page SHOW CONFIGURATION de la documentation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __resetBrokers } from '@/terminal/commands/DgmgrlCommands';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

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
  dgmgrl(lab.prod, "CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
  if (sync) dgmgrl(lab.prod, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';", 'EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;');
};

const roleOf = (device: Parameters<RmanLab['sql']>[0]): string => lab.sql(device, 'SELECT database_role FROM v$database;');

describe('observer and fast-start failover', () => {
  it('ENABLE FAST_START FAILOVER in MaxAvailability with a SYNC target says Zero Data Loss Mode', () => {
    configured();
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;')).toContain('Enabled in Zero Data Loss Mode.');
  });

  it('without an observer the members carry ORA-16819 and the configuration is in WARNING', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    const out = dgmgrl(lab.prod, 'SHOW CONFIGURATION;');
    expect(out).toContain('Fast-Start Failover: Enabled in Zero Data Loss Mode');
    expect(out).toContain('Warning: ORA-16819: fast-start failover observer not started');
    expect(out).toMatch(/Configuration Status:\s+WARNING/);
  });

  it('TEMOIN — a configuration without fast-start failover shows it DISABLED and SUCCESS', () => {
    configured();
    const out = dgmgrl(lab.prod, 'SHOW CONFIGURATION;');
    expect(out).toContain('Fast-Start Failover: DISABLED');
    expect(out).toContain('SUCCESS');
  });

  it('a standby that is not SYNC refuses it with ORA-16693', () => {
    configured(false);
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;')).toContain('ORA-16693: requirements not met for enabling fast-start failover');
  });

  it('START OBSERVER, SHOW FAST_START FAILOVER and SHOW OBSERVER describe the observer', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    expect(dgmgrl(lab.prod, 'START OBSERVER obs1;')).toContain('Observer started');
    scheduler.advance(9000);
    const fsfo = dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;');
    expect(fsfo).toContain('Fast-Start Failover: Enabled in Zero Data Loss Mode');
    expect(fsfo).toContain('Threshold:          30 seconds');
    expect(fsfo).toContain('Active Target:      ORCL_STB');
    expect(fsfo).toMatch(/Observer:\s+\S+/);
    expect(fsfo).not.toContain('Observer:           (none)');
    const observer = dgmgrl(lab.prod, 'SHOW OBSERVER;');
    expect(observer).toContain('Observer "obs1" - Master');
    expect(observer).toMatch(/Last Ping to Primary:\s+\d+ seconds? ago/);
    expect(observer).toMatch(/Last Ping to Target:\s+\d+ seconds? ago/);
  });

  it('when the primary goes silent for the threshold the observer fails over to the standby', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    dgmgrl(lab.prod, 'START OBSERVER obs1;');
    scheduler.advance(6000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(15000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
    scheduler.advance(30000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('after STOP OBSERVER nothing fails over and the warning is back', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    dgmgrl(lab.prod, 'START OBSERVER obs1;');
    expect(dgmgrl(lab.prod, 'STOP OBSERVER;')).toContain('Done.');
    scheduler.advance(6000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(60000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toContain('ORA-16819');
  });

  it('DISABLE FAST_START FAILOVER keeps the observer from acting', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    dgmgrl(lab.prod, 'START OBSERVER obs1;');
    expect(dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER;')).toContain('Disabled.');
    scheduler.advance(6000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(60000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  it('a fourth observer is refused with ORA-16647', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    for (const name of ['o1', 'o2', 'o3']) dgmgrl(lab.prod, `START OBSERVER ${name};`);
    expect(dgmgrl(lab.prod, 'START OBSERVER o4;')).toContain('ORA-16647');
  });
});
