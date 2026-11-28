/*
 * Sonde — root n'est pas OSDBA : `sqlplus / as sysdba` et `rman target /` lances par root sont refuses (ORA-01031).
 *
 * Releve AVANT : la machine Oracle etait provisionnee « comme si ses administrateurs etaient DBA » : root, alice, bob, carl et dave etaient ajoutes au groupe `dba`.
 * Un `sqlplus / as sysdba` tape en root passait, alors qu'Oracle (Database Installation Guide for Linux, OSDBA group) n'admet par authentification systeme que les
 * membres du groupe OSDBA, et que le paquet de preinstallation n'y met que `oracle`. Un tutoriel qui enseigne « on sauvegarde en oracle, jamais en root » ne peut
 * pas reposer sur un simulateur qui laisse root tout faire.
 *
 * Le comportement fidele est celui de la production ; les suites ecrites avant lui le retrouvent par `__setSuperuserIsOsdba(true)` (setupGlobalState).
 *
 * Discrimine par `git stash push -- src/network src/terminal` : 3 des 4 cas tombent. Le TEMOIN (oracle est admis) passe des deux cotes ; il garde le laboratoire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __setSuperuserIsOsdba } from '@/network/devices/linux/OracleOsAuthentication';

let server: LinuxServer;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  __setSuperuserIsOsdba(false);
  server = new LinuxServer('linux-server', 'ORA-1', 0, 0);
});

const asSysdba = (shell: string) => server.executeCommand(`${shell}sqlplus -s / as sysdba <<'E'\nSELECT 7 AS n FROM dual;\nE${shell === '' ? '' : '"'}`);

describe('qui est OSDBA', () => {
  it('TEMOIN — oracle, du groupe dba, se connecte', async () => {
    await asSysdba('');
    expect(await server.executeCommand("su - oracle -c \"sqlplus -s / as sysdba <<'E'\nSELECT 7 AS n FROM dual;\nE\"")).toContain('1 row selected');
  });

  it('root est refuse : ORA-01031', async () => {
    expect(await asSysdba('')).toContain('ORA-01031');
  });

  it('rman target / lance par root est refuse', async () => {
    expect(await server.executeCommand("printf 'SHOW ALL;\\n' | rman target /")).toMatch(/ORA-01031|RMAN-04005/);
  });

  it('root n est pas membre du groupe dba', async () => {
    await server.executeCommand("sqlplus -s / as sysdba <<'E'\nSELECT 1 FROM dual;\nE");
    expect(await server.executeCommand('id -Gn root')).not.toContain('dba');
  });
});
