/**
 * Quatre defauts du SQL Oracle vus en testant les horloges.
 *
 * 1. `INSERT INTO t VALUES (2, DEFAULT)` stockait NULL (le mot-cle DEFAULT se lisait comme un
 *    identifiant inconnu) : la colonne gardait son defaut seulement si elle etait omise. `UPDATE t SET
 *    c = DEFAULT` ne faisait rien non plus.
 * 2. `DBMS_SCHEDULER.CREATE_JOB(job_name=>'J1', …)` lisait ses arguments nommes comme des valeurs
 *    POSITIONNELLES : le travail s'appelait `JOB_NAME=>'J1'`. Les routines des paquets declarent
 *    maintenant leurs parametres et le dispatcheur lie les arguments nommes.
 * 3. `repeat_interval` etait stocke et IGNORE : `FREQ=DAILY;BYHOUR=3` rejouait toutes les 24 h a
 *    l'heure du dernier passage. Le calendrier (FREQ, INTERVAL, BYMONTH, BYMONTHDAY, BYDAY, BYHOUR,
 *    BYMINUTE, BYSECOND) est evalue sur l'heure MURALE du serveur, dans son fuseau ; une expression
 *    illisible ou sans prochaine date repond ORA-27419 (le texte d'Oracle pour « impossible de
 *    determiner une date d'execution valide » : la formulation exacte d'une erreur de syntaxe n'est pas
 *    atteignable ici).
 * 4. `CAST(x AS DATE|TIMESTAMP|…)` rendait vide sans rien evaluer ; `TO_TIMESTAMP`, `FROM_TZ` et
 *    `SYS_EXTRACT_UTC` etaient inconnus ; comparer une colonne de catalogue (un instant) a `SYSDATE - 1`
 *    (une heure murale) etait decale du decalage du serveur hors UTC.
 *
 * Discriminee contre l'etat d'avant (sources de `HEAD`, meme sonde) : 9 cas, tous tombent avant — le
 * dernier (comparaison instant / heure murale) inclus, qui passait quand la machine etait en UTC.
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

const ORIGIN_MS = Date.UTC(2026, 9, 6, 18, 25, 0);

async function lab(zone?: string) {
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); resetAllOracleInstances();
  const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: ORIGIN_MS }));
  const server = new LinuxServer('linux-server', 'S1');
  if (zone !== undefined) await server.executeCommand(`timedatectl set-timezone ${zone}`);
  const shell = SqlPlusSubShell.create(server, ['/', 'as', 'sysdba']).subShell;
  shell.processLine("ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS';");
  const sql = (query: string): string => shell.processLine(query).output.join('\n');
  return { sql, clock };
}

const job = (name: string, interval: string, extra = '') =>
  `BEGIN DBMS_SCHEDULER.CREATE_JOB(job_name=>'${name}', job_type=>'PLSQL_BLOCK', job_action=>'BEGIN NULL; END;', `
  + `repeat_interval=>'${interval}', enabled=>TRUE${extra}); END;`;
const nextRun = (sql: (q: string) => string, name: string): string =>
  sql(`SELECT next_run_date FROM dba_scheduler_jobs WHERE job_name='${name}';`);

afterEach(() => __resetSimulationClock());

describe('the DEFAULT keyword', () => {
  it('INSERT ... VALUES (…, DEFAULT) stores the column default and UPDATE ... SET c = DEFAULT restores it', async () => {
    const { sql } = await lab();
    sql('CREATE TABLE t (id NUMBER, n NUMBER DEFAULT 7, d DATE DEFAULT SYSDATE);');
    sql('INSERT INTO t VALUES (1, DEFAULT, DEFAULT);');
    sql('INSERT INTO t (id, n) VALUES (2, 5);');
    sql('UPDATE t SET n = DEFAULT WHERE id = 2;');
    const rows = sql('SELECT id, n, d FROM t ORDER BY id;');
    expect(rows).toMatch(/1\s+7\s+2026-10-06 18:25:00/);
    expect(rows).toMatch(/2\s+7\s+2026-10-06 18:25:00/);
  });
});

describe('DBMS_SCHEDULER named arguments and the calendar', () => {
  it('binds named arguments by parameter name', async () => {
    const { sql } = await lab('Asia/Tokyo');
    sql(job('J1', 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0;BYSECOND=0'));
    expect(sql('SELECT job_name FROM dba_scheduler_jobs;')).toMatch(/\bJ1\b/);
  });

  it('evaluates BYHOUR in the zone of the server', async () => {
    const { sql } = await lab('Asia/Tokyo');
    sql(job('J1', 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0;BYSECOND=0'));
    expect(nextRun(sql, 'J1')).toContain('2026-10-08 03:00:00');
    const utc = await lab();
    utc.sql(job('J1', 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0;BYSECOND=0'));
    expect(nextRun(utc.sql, 'J1')).toContain('2026-10-07 03:00:00');
  });

  it('evaluates BYDAY, BYMONTHDAY and INTERVAL', async () => {
    const { sql } = await lab('Asia/Tokyo');
    sql(job('W', 'FREQ=WEEKLY;BYDAY=MON,FRI;BYHOUR=9;BYMINUTE=30;BYSECOND=0'));
    sql(job('M', 'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=23;BYMINUTE=0;BYSECOND=0'));
    sql(job('H', 'FREQ=HOURLY;INTERVAL=2'));
    expect(nextRun(sql, 'W')).toContain('2026-10-09 09:30:00');
    expect(nextRun(sql, 'M')).toContain('2026-10-31 23:00:00');
    expect(nextRun(sql, 'H')).toContain('2026-10-07 05:25:00');
  });

  it('runs a due job and reschedules it on the calendar', async () => {
    const { sql, clock } = await lab('Asia/Tokyo');
    sql(job('H', 'FREQ=HOURLY;INTERVAL=2'));
    await clock.advance(3 * 3_600_000);
    expect(sql("SELECT run_count FROM dba_scheduler_jobs WHERE job_name='H';")).toMatch(/\b1\b/);
    expect(nextRun(sql, 'H')).toContain('2026-10-07 07:25:00');
  });

  it('refuses an expression that cannot give a date (ORA-27419)', async () => {
    const { sql } = await lab();
    expect(sql(job('B', 'FREQ=BOGUS'))).toContain('ORA-27419');
  });
});

describe('time zone functions and CAST', () => {
  it('CAST and TO_TIMESTAMP evaluate', async () => {
    const { sql } = await lab();
    expect(sql("SELECT CAST('2026-07-01 12:34:56' AS DATE) FROM DUAL;")).toContain('2026-07-01 12:34:56');
    expect(sql("SELECT CAST('42' AS NUMBER) + 1 FROM DUAL;")).toMatch(/\b43\b/);
    expect(sql("SELECT TO_TIMESTAMP('2026-07-01 12:00:00','YYYY-MM-DD HH24:MI:SS') FROM DUAL;")).toContain('2026-07-01 12:00:00');
  });

  it('FROM_TZ attaches the offset the region has at that wall time, SYS_EXTRACT_UTC removes it', async () => {
    const { sql } = await lab();
    expect(sql("SELECT FROM_TZ(TIMESTAMP '2026-07-01 12:00:00', 'Europe/Paris') FROM DUAL;")).toContain('2026-07-01 12:00:00.000 +02:00');
    expect(sql("SELECT FROM_TZ(TIMESTAMP '2026-01-01 12:00:00', 'Europe/Paris') FROM DUAL;")).toContain('2026-01-01 12:00:00.000 +01:00');
    expect(sql("SELECT SYS_EXTRACT_UTC(FROM_TZ(TIMESTAMP '2026-07-01 12:00:00', 'Europe/Paris')) FROM DUAL;")).toContain('2026-07-01 10:00:00');
  });

  it('a catalog instant compares with a wall-clock expression on a machine east of UTC', async () => {
    const { sql } = await lab('Asia/Tokyo');
    expect(sql('SELECT COUNT(*) FROM dba_objects WHERE created > SYSDATE - 1/24;')).not.toMatch(/\b0\s*$/m);
    expect(sql('SELECT COUNT(*) FROM dba_objects WHERE created < SYSDATE - 1/24;')).toMatch(/\b0\s*$/m);
  });
});
