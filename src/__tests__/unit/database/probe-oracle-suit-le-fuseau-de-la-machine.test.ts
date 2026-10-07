/**
 * Une base Oracle tourne SUR une machine : SYSDATE et SYSTIMESTAMP sont l'heure de l'OS de CE
 * serveur, DBTIMEZONE le fuseau de la base (par defaut celui de l'OS a la creation),
 * SESSIONTIMEZONE celui du client (ici le meme OS), CURRENT_DATE / CURRENT_TIMESTAMP /
 * LOCALTIMESTAMP suivent la session (`ALTER SESSION SET TIME_ZONE`). Or le moteur lisait les
 * accesseurs LOCAUX d'un `Date` JavaScript — le fuseau du PROCESSUS, en production celui du
 * NAVIGATEUR — melait parse local et `toISOString()` UTC, et fixait la base a UTC quelle que soit
 * la machine.
 *
 * MESURE : la meme batterie de 21 requetes, une machine en UTC, jouee sous `TZ=UTC` puis
 * `TZ=Pacific/Auckland` pour le processus : 6 sorties differaient (`TO_CHAR(SYSTIMESTAMP)`,
 * l'aller-retour `TO_DATE`/`TO_CHAR`, `TO_CHAR(SYSDATE-1/24)`, `V$INSTANCE.STARTUP_TIME`,
 * `V$SESSION.LOGON_TIME`, `DBA_OBJECTS.CREATED`) ; sur une machine a Tokyo `SYSDATE` rendait
 * l'heure UTC et `DBTIMEZONE` `+00:00`. Hors requetes : la banniere SQL*Plus, `tnsping`,
 * `expdp`/`impdp` et `lsnrctl` prenaient la date du navigateur, `lsnrctl status` rendait un
 * `Start Date` ISO en UTC, `isOffHours` jugeait l'heure ouvrable sur le navigateur,
 * `sqlplus -V` inventait une date, `LOCALTIMESTAMP` rendait vide, `NEW_TIME` n'existait pas,
 * `ALTER DATABASE SET TIME_ZONE` repondait « Database altered. » sans rien changer.
 * `ADD_MONTHS('28-FEB')` ne rendait pas le dernier jour du mois, `LAST_DAY` perdait l'heure et
 * `MONTHS_BETWEEN` l'ignorait : les deux fonctions de date existaient en double (evaluateur SQL
 * et registre PL/SQL) ; elles partagent maintenant `dateArithmetic`.
 *
 * Cause : un `Date` du moteur est une heure MURALE sans fuseau encodee en UTC (`WallDate`) ; un
 * `Date` ordinaire est un instant, et une chaine `…Z` / `…+hh:mm` aussi. Les instants passent
 * par la SEULE conversion `coerceDateValue(valeur, fuseauDuServeur)` ; le fuseau vient d'un port
 * (`OracleHostClock`) que l'adaptateur branche sur l'horloge et le fuseau de la machine.
 *
 * Discriminee contre l'etat d'avant (sources de `mandeng-fuseaux-bash`, meme sonde) : 12 des 13
 * cas tombent. Le seul qui passe des deux cotes est NOMME : le temoin « la suite d'une machine UTC
 * est stable sous un processus UTC et porte l'heure », qui prouve que le laboratoire est sain.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ORIGINAL_TZ = process.env.TZ;
const ORIGIN_MS = Date.UTC(2026, 9, 6, 18, 25, 0);

const BATTERY = [
  'SELECT SYSDATE FROM DUAL;', 'SELECT TO_CHAR(SYSTIMESTAMP) FROM DUAL;', 'SELECT CURRENT_DATE FROM DUAL;',
  'SELECT DBTIMEZONE, SESSIONTIMEZONE FROM DUAL;', "SELECT TO_CHAR(SYSDATE,'HH24:MI') FROM DUAL;",
  'SELECT EXTRACT(HOUR FROM SYSDATE) FROM DUAL;', 'SELECT TRUNC(SYSDATE) FROM DUAL;', 'SELECT LAST_DAY(SYSDATE) FROM DUAL;',
  'SELECT ADD_MONTHS(SYSDATE,1) FROM DUAL;',
  "SELECT TO_CHAR(TO_DATE('2026-03-29 02:30:00','YYYY-MM-DD HH24:MI:SS'),'HH24:MI') FROM DUAL;",
  'SELECT startup_time FROM v$instance;', 'SELECT logon_time FROM v$session WHERE rownum=1;',
  'SELECT created FROM dba_objects WHERE rownum=1;', "SELECT TO_CHAR(SYSDATE-1/24,'HH24:MI') FROM DUAL;",
  'SELECT LOCALTIMESTAMP FROM DUAL;', "SELECT NEW_TIME(SYSDATE,'GMT','EST') FROM DUAL;",
  "ALTER SESSION SET TIME_ZONE='Asia/Tokyo';", 'SELECT SESSIONTIMEZONE, CURRENT_DATE FROM DUAL;',
];

async function lab(processZone: string, machineZone?: string) {
  process.env.TZ = processZone;
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); resetAllOracleInstances();
  const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: ORIGIN_MS }));
  const server = new LinuxServer('linux-server', 'S1');
  if (machineZone !== undefined) await server.executeCommand(`timedatectl set-timezone ${machineZone}`);
  const created = SqlPlusSubShell.create(server, ['/', 'as', 'sysdba']);
  const shell = created.subShell;
  shell.processLine("ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS';");
  await clock.advance(3 * 3600_000 + 17 * 60_000);
  const sql = (query: string): string => shell.processLine(query).output.join('\n');
  return { server, sql, banner: created.banner.join('\n'), clock };
}

async function transcript(processZone: string): Promise<string[]> {
  const { server, sql, banner } = await lab(processZone);
  return [
    banner, ...BATTERY.map(sql),
    await server.executeCommand('lsnrctl status | grep -i "start date"'),
    await server.executeCommand('tnsping localhost | head -2'),
  ];
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  __resetSimulationClock();
});

describe('an Oracle database prints the time of its machine, not the one of the process', () => {
  it('witness: the transcript of a UTC machine is stable under a UTC process and carries the time', async () => {
    const first = await transcript('UTC');
    const second = await transcript('UTC');
    expect(second).toEqual(first);
    expect(first[1]).toContain('2026-10-06 21:42:00');
  });

  it('the transcript of a UTC machine does not depend on the zone of the process', async () => {
    const utc = await transcript('UTC');
    const auckland = await transcript('Pacific/Auckland');
    const names = ['banner', ...BATTERY, 'lsnrctl', 'tnsping'];
    expect(names.filter((_, i) => utc[i] !== auckland[i])).toEqual([]);
  });

  describe('a machine set to Tokyo', () => {
    it('SYSDATE, CURRENT_DATE and the instance times are the Tokyo wall clock', async () => {
      const { sql } = await lab('UTC', 'Asia/Tokyo');
      expect(sql('SELECT SYSDATE FROM DUAL;')).toContain('2026-10-07 06:42:00');
      expect(sql('SELECT CURRENT_DATE FROM DUAL;')).toContain('2026-10-07 06:42:00');
      expect(sql('SELECT startup_time FROM v$instance;')).toContain('2026-10-07 03:25:00');
      expect(sql('SELECT logon_time FROM v$session WHERE rownum=1;')).toContain('2026-10-07 06:42:00');
      expect(sql("SELECT TO_CHAR(SYSDATE-1/24,'HH24:MI') FROM DUAL;")).toContain('05:42');
    });

    it('DBTIMEZONE and SESSIONTIMEZONE default to the offset of the machine', async () => {
      const { sql } = await lab('UTC', 'Asia/Tokyo');
      expect(sql('SELECT DBTIMEZONE, SESSIONTIMEZONE FROM DUAL;')).toMatch(/\+09:00\s+\+09:00/);
    });

    it('SYSTIMESTAMP carries the offset of the machine, CURRENT_TIMESTAMP the one of the session', async () => {
      const { sql } = await lab('UTC', 'Asia/Tokyo');
      sql('ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT=\'YYYY-MM-DD HH24:MI:SS TZH:TZM\';');
      expect(sql('SELECT SYSTIMESTAMP FROM DUAL;')).toContain('+09:00');
      sql("ALTER SESSION SET TIME_ZONE='-05:00';");
      expect(sql('SELECT CURRENT_TIMESTAMP FROM DUAL;')).toContain('-05:00');
      expect(sql('SELECT SYSTIMESTAMP FROM DUAL;')).toContain('+09:00');
    });

    it('ALTER SESSION SET TIME_ZONE moves CURRENT_DATE and not SYSDATE', async () => {
      const { sql } = await lab('UTC', 'Asia/Tokyo');
      sql("ALTER SESSION SET TIME_ZONE='Europe/Paris';");
      expect(sql('SELECT CURRENT_DATE FROM DUAL;')).toContain('2026-10-06 23:42:00');
      expect(sql('SELECT SYSDATE FROM DUAL;')).toContain('2026-10-07 06:42:00');
    });

    it('banners and the listener use the date of the machine', async () => {
      const { server, banner } = await lab('UTC', 'Asia/Tokyo');
      expect(banner).toContain('Wed Oct 07 2026');
      expect(await server.executeCommand('lsnrctl status | grep -i "start date"')).toContain('07-OCT-2026 03:25:00');
      expect(await server.executeCommand('tnsping localhost | head -2')).toContain('Wed Oct 07 2026');
    });

    it('ALTER DATABASE SET TIME_ZONE is pending until the database restarts', async () => {
      const { sql } = await lab('UTC', 'Asia/Tokyo');
      expect(sql("ALTER DATABASE SET TIME_ZONE = '-05:00';")).toContain('Database altered.');
      expect(sql('SELECT DBTIMEZONE FROM DUAL;')).toContain('+09:00');
      sql('SHUTDOWN IMMEDIATE');
      sql('STARTUP');
      expect(sql('SELECT DBTIMEZONE FROM DUAL;')).toContain('-05:00');
      expect(sql("ALTER DATABASE SET TIME_ZONE = 'Not/AZone';")).toContain('ORA-01882');
    });
  });

  describe('date functions work on wall-clock fields, whatever the zone', () => {
    it('ADD_MONTHS from the last day of a month returns the last day of the result month', async () => {
      const { sql } = await lab('Pacific/Auckland');
      expect(sql("SELECT ADD_MONTHS(DATE '2026-02-28', 1), ADD_MONTHS(DATE '2026-03-31', 1) FROM DUAL;"))
        .toMatch(/2026-03-31 00:00:00\s+2026-04-30 00:00:00/);
    });

    it('LAST_DAY keeps the time of day and MONTHS_BETWEEN counts it', async () => {
      const { sql } = await lab('Pacific/Auckland');
      expect(sql("SELECT LAST_DAY(TO_DATE('2026-02-10 14:30:00','YYYY-MM-DD HH24:MI:SS')) FROM DUAL;")).toContain('2026-02-28 14:30:00');
      expect(sql("SELECT MONTHS_BETWEEN(DATE '2026-03-31', DATE '2026-02-28') FROM DUAL;")).toMatch(/\s1\s*$/m);
    });

    it('NEW_TIME shifts between the fixed Oracle zones and refuses an unknown one', async () => {
      const { sql } = await lab('Pacific/Auckland');
      expect(sql("SELECT NEW_TIME(DATE '2026-10-06', 'GMT', 'EST') FROM DUAL;")).toContain('2026-10-05 19:00:00');
      expect(sql("SELECT NEW_TIME(DATE '2026-10-06', 'GMT', 'XXX') FROM DUAL;")).toContain('ORA-01857');
    });

    it('LOCALTIMESTAMP is the session wall clock', async () => {
      const { sql } = await lab('UTC', 'Asia/Tokyo');
      expect(sql('SELECT LOCALTIMESTAMP FROM DUAL;')).toContain('2026-10-07 06:42:00');
    });

    it('witness: a date stored in a column does not move on a machine west of UTC', async () => {
      const { sql } = await lab('America/New_York', 'America/New_York');
      sql('CREATE TABLE hr.t (id NUMBER, d DATE);');
      sql("INSERT INTO hr.t VALUES (1, DATE '2003-06-17');");
      sql("ALTER SESSION SET NLS_DATE_FORMAT='DD-MON-RR HH24:MI';");
      expect(sql('SELECT d FROM hr.t;')).toContain('17-JUN-03 00:00');
      expect(sql("SELECT COUNT(*) FROM hr.t WHERE d = '17-JUN-2003';")).toMatch(/\s1\s*$/m);
    });
  });
});
