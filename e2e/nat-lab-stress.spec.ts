/**
 * Épreuves de charge du laboratoire « nat-lab » (R-AKWA, ISP, SRV-WEB, EXT, switch Cisco et serveur DHCP 170.20.0.2 derrière l'ISP), jouées dans Chromium avec
 * `debug ip nat` sur R-AKWA et `tcpdump` dans le serveur. Chaque épreuve mesure : durée jusqu'au marqueur de fin, retard de la page (battement de 100 ms), tâches
 * longues, tas JS, noeuds DOM, plantage de l'onglet, erreurs de page ; le journal est dans /tmp/nat-lab-stress/journal.log.
 */
import { test, expect, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLab, lineCount, lineCountContaining, openTerminal, typeIn, waitForStore, type Ids } from './helpers/natLab';

const OUT = '/tmp/nat-lab-stress';
mkdirSync(OUT, { recursive: true });
const journal = join(OUT, 'journal.log');
writeFileSync(journal, '');
const note = (line: string): void => { appendFileSync(journal, `${new Date().toISOString()} ${line}\n`); console.log(line); };

interface Scenario {
  name: string;
  client: keyof Ids;
  commands: (target: string) => string[];
  target?: string;
  budgetMs?: number;
  maxLagMs?: number;
  markerContains?: string;
  before?: string[];
  mustNotContain?: string[];
}

const oracle = (name: string, lines: string[], extra: Partial<Scenario> = {}): Scenario => ({
  name, client: 'srv', before: ['sqlplus / as sysdba', 'SET SERVEROUTPUT ON', ...lines], commands: () => ["SELECT 'FINISHED' FROM dual;"], ...extra,
});
const BIG_TABLE = 'CREATE TABLE big (id NUMBER PRIMARY KEY, grp NUMBER, name VARCHAR2(40), amount NUMBER(10,2), created DATE);';
const fill = (rows: number): string => `INSERT INTO big SELECT level, MOD(level,100), 'name_' || level, level * 1.5, SYSDATE FROM dual CONNECT BY level <= ${rows};`;
const viaSqlplus = (sql: string, count: number, parallel: boolean, target: string): string =>
  `for i in $(seq 1 ${count}); do echo "${sql}" | sqlplus -S system/oracle@${target}:1521/ORCL${parallel ? ' &' : ';'} done; ${parallel ? 'wait; ' : ''}echo FINISHED`;

const SCENARIOS: Scenario[] = (process.env.STRESS_ONLY ? [] : []).concat([
  { name: 'curl-500', client: 'lin', commands: (t) => [`for i in $(seq 1 500); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`] },
  { name: 'curl-1000', client: 'lin', commands: (t) => [`for i in $(seq 1 1000); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`] },
  { name: 'curl-200-x3', client: 'lin', commands: (t) => [1, 2, 3].map((n) => `for i in $(seq 1 200); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED${n}`) },
  { name: 'curl-200-x10', client: 'lin', commands: (t) => Array.from({ length: 10 }, (_, n) => `for i in $(seq 1 200); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED${n + 1}`) },
  { name: 'curl-5000', client: 'lin', commands: (t) => [`for i in $(seq 1 5000); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`] },
  { name: 'curl-20000', client: 'lin', commands: (t) => [`for i in $(seq 1 20000); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`] },
  { name: 'ping-f-5000', client: 'lin', commands: (t) => [`ping -f -c 5000 ${t}; echo FINISHED`] },
  { name: 'nmap-all-ports', client: 'lin', commands: (t) => [`nmap -p- ${t}; echo FINISHED`] },
  { name: 'seq-500000', client: 'lin', commands: () => [`seq 1 500000; echo FINISHED`] },
  { name: 'yes-head-200000', client: 'lin', commands: () => [`yes spam | head -200000; echo FINISHED`] },
  { name: 'nat-table-flood', client: 'lin', commands: (t) => [`for i in $(seq 1 3000); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`] },
  { name: 'logger-100000', client: 'lin', commands: () => [`for i in $(seq 1 100000); do logger -t stress "message number $i with a bit of text to be realistic"; done; echo FINISHED`] },
  { name: 'win-cmd-for-50000', client: 'win', commands: () => ['(for /L %i in (1,1,50000) do @echo %i) & echo FINISHED'] },
  { name: 'win-ps-range-100000', client: 'win', commands: () => [`powershell -Command "1..100000 | ForEach-Object { $_ }; 'FINISHED'"`] },
  { name: 'win-curl-300', client: 'win', commands: (t) => [`(for /L %i in (1,1,300) do @curl.exe -s -o NUL --max-time 5 http://${t}/) & echo FINISHED`] },
  { name: 'while-true', client: 'lin', commands: () => [`while true; do :; done`] },
  { name: 'lin-big-pipeline', client: 'lin', commands: () => [`seq 1 300000 | sort -rn | uniq | wc -l; echo FINISHED`] },
  { name: 'cisco-ping-repeat-3000', client: 'r', commands: () => ['ping 203.0.113.1 repeat 3000'], markerContains: 'Success rate is' },
  { name: 'cisco-debug-packet-ping-2000', client: 'r', before: ['debug ip packet'], commands: () => ['ping 203.0.113.9 repeat 2000'], markerContains: 'Success rate is' },
  { name: 'cisco-show-run-x500', client: 'r', commands: () => ['show running-config | include interface'], markerContains: 'interface GigabitEthernet0/1' },
  { name: 'one-huge-line', client: 'lin', commands: () => [`head -c 5000000 /dev/zero | tr '\\0' a; echo; echo FINISHED`] },
  { name: 'many-long-lines', client: 'lin', commands: () => [`for i in $(seq 1 200); do head -c 20000 /dev/zero | tr '\\0' x; echo; done; echo FINISHED`] },
  { name: 'base64-urandom', client: 'lin', commands: () => [`head -c 3000000 /dev/urandom | base64 | head -c 2000000; echo; echo FINISHED`] },
  { name: 'ext-nmap-router', client: 'ext', commands: () => [`nmap -p- 203.0.113.2; echo FINISHED`] },
  { name: 'srv-ping-f-router', client: 'srv', commands: () => [`ping -f -c 3000 192.168.10.1; echo FINISHED`] },
  { name: 'win-ping-300', client: 'win', commands: () => [`ping -n 300 203.0.113.9 > NUL & echo FINISHED`] },
  { name: 'win-nmap-all-ports', client: 'win', commands: () => ['nmap -p- 203.0.113.2 & echo FINISHED'] },
  oracle('ora-insert-100k', [BIG_TABLE, fill(100000), 'COMMIT;']),
  oracle('ora-aggregates-50k', [BIG_TABLE, fill(50000), 'SELECT grp, COUNT(*), SUM(amount) FROM big GROUP BY grp ORDER BY grp;', 'SELECT id FROM big ORDER BY amount DESC FETCH FIRST 10 ROWS ONLY;']),
  oracle('ora-join-20k', [BIG_TABLE, fill(20000), 'SELECT COUNT(*) FROM big a JOIN big b ON a.id = b.id WHERE a.grp = 7;']),
  oracle('ora-update-all-50k', [BIG_TABLE, fill(50000), 'UPDATE big SET amount = amount + 1;', 'ROLLBACK;']),
  oracle('ora-select-all-20k', [BIG_TABLE, fill(20000), 'SELECT * FROM big;']),
  oracle('ora-window-100k', [BIG_TABLE, fill(100000), 'SELECT MAX(r) FROM (SELECT SUM(amount) OVER (ORDER BY id) r FROM big);']),
  oracle('ora-select-all-150k', [BIG_TABLE, fill(150000), 'SELECT * FROM big;']),
  oracle('ora-rollback-mixed-40k', [BIG_TABLE, fill(40000), 'COMMIT;', 'UPDATE big SET amount = amount + 1;', 'DELETE FROM big WHERE MOD(id, 3) = 0;', 'UPDATE big SET amount = amount + 1;', 'ROLLBACK;', 'SELECT COUNT(*) FROM big;']),
  oracle('ora-plsql-inserts-20k', ['CREATE TABLE t2 (id NUMBER, v VARCHAR2(20));', "BEGIN FOR i IN 1..20000 LOOP INSERT INTO t2 VALUES (i, 'v'||i); END LOOP; COMMIT; END;", '/']),
  oracle('ora-plsql-updates-3k', [BIG_TABLE, fill(20000), 'BEGIN FOR i IN 1..3000 LOOP UPDATE big SET amount = amount + 1 WHERE id = i; END LOOP; COMMIT; END;', '/']),
  oracle('ora-put-line-20k', ["BEGIN FOR i IN 1..20000 LOOP DBMS_OUTPUT.PUT_LINE('line ' || i); END LOOP; END;", '/']),
  oracle('ora-ddl-300', ["BEGIN FOR i IN 1..300 LOOP EXECUTE IMMEDIATE 'CREATE TABLE tbl_' || i || ' (id NUMBER, v VARCHAR2(10))'; END LOOP; END;", '/', "SELECT COUNT(*) FROM user_tables;"]),
  oracle('ora-users-200', ["BEGIN FOR i IN 1..200 LOOP EXECUTE IMMEDIATE 'CREATE USER u' || i || ' IDENTIFIED BY \"Pw#' || i || '\"'; END LOOP; END;", '/', "SELECT COUNT(*) FROM dba_users;"]),
  oracle('ora-dictionary-views', ['SELECT * FROM dba_objects;', 'SELECT * FROM dba_tables;', 'SELECT * FROM v$parameter;', 'SELECT * FROM dba_users;']),
  { name: 'ora-remote-sessions-100', client: 'lin', target: '203.0.113.9', commands: (t) => [viaSqlplus('SELECT 1 FROM DUAL;', 100, false, t)] },
  { name: 'ora-remote-parallel-100', client: 'lin', target: '203.0.113.9', commands: (t) => [viaSqlplus('SELECT 1 FROM DUAL;', 100, true, t)] },
  { name: 'ora-remote-parallel-3', client: 'lin', target: '203.0.113.9', commands: (t) => [viaSqlplus('SELECT 1 FROM DUAL;', 3, true, t)] },
  { name: 'ora-remote-sessions-3', client: 'lin', target: '203.0.113.9', commands: (t) => [viaSqlplus('SELECT 1 FROM DUAL;', 3, false, t)] },
  { name: 'ora-local-parallel-100', client: 'srv', commands: () => ['for i in $(seq 1 100); do echo "SELECT 1 FROM dual;" | sqlplus -S / as sysdba & done; wait; echo FINISHED'] },
  { name: 'rman-bash-loop-30', client: 'srv', commands: () => ['for i in $(seq 1 30); do echo "BACKUP DATABASE;" | rman target / | grep -E "RMAN-[0-9]+|ORA-[0-9]+" | head -2; done; echo FINISHED'], mustNotContain: ['RMAN-0', 'RMAN-1', 'ORA-19'] },
  { name: 'rman-interactive-30', client: 'srv', before: ['rman target /', ...Array.from({ length: 30 }, () => 'BACKUP DATABASE;'), 'LIST BACKUP;', 'CROSSCHECK BACKUP;', 'REPORT OBSOLETE;', 'VALIDATE DATABASE;', 'RESTORE DATABASE VALIDATE;'], commands: () => ['REPORT SCHEMA;'], markerContains: 'Report of database schema' },
  { name: 'rman-script-300', client: 'srv', commands: () => ['(for i in $(seq 1 300); do echo "BACKUP DATABASE;"; echo "LIST BACKUP SUMMARY;"; done; echo "EXIT;") | rman target / | grep -E "RMAN-[0-9]+|ORA-[0-9]+" | head -3; echo FINISHED'], mustNotContain: ['RMAN-0', 'RMAN-1', 'ORA-19'] },
  { name: 'rman-probe', client: 'srv', commands: () => ['df -h / /u01 | cat; ls -ld /u01/app/oracle/fast_recovery_area /u01/app/oracle/fast_recovery_area/ORCL; echo FINISHED'] },
  { name: 'rman-delete-cycle-100', client: 'srv', commands: () => ['(for i in $(seq 1 100); do echo "BACKUP DATABASE;"; echo "DELETE NOPROMPT BACKUP;"; done; echo "EXIT;") | rman target / | grep -E "RMAN-[0-9]+|ORA-[0-9]+" | head -3; echo FINISHED'], mustNotContain: ['RMAN-0', 'RMAN-1', 'ORA-19'] },
  { name: 'rman-clock-jump', client: 'srv', commands: () => ['sudo date -s "2027-03-01 10:00:00" > /dev/null; echo "BACKUP DATABASE;" | rman target / | grep -E "Finished backup|RMAN-[0-9]+|ORA-[0-9]+"; echo FINISHED'], mustNotContain: ['RMAN-0', 'ORA-19'] },
  { name: 'ping-flood-500', client: 'lin', commands: (t) => [`ping -c 500 -i 0.002 ${t}; echo FINISHED`] },
  { name: 'nmap-1024', client: 'lin', commands: (t) => [`nmap -p 1-1024 ${t}; echo FINISHED`] },
  { name: 'nc-zv-300', client: 'lin', commands: (t) => [`for i in $(seq 1 300); do nc -zv -w 1 ${t} 80 & done; wait; echo FINISHED`] },
  { name: 'curl-ext-500', client: 'lin', target: '203.0.113.9', commands: (t) => [`for i in $(seq 1 500); do curl -s -o /dev/null --max-time 5 http://${t}/ & done; wait; echo FINISHED`] },
]).filter((scenario) => !process.env.STRESS_ONLY || scenario.name === process.env.STRESS_ONLY);

async function measure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Record<string, unknown>;
    w.__long = { count: 0, total: 0, max: 0 };
    new PerformanceObserver((list) => {
      const stats = w.__long as { count: number; total: number; max: number };
      for (const entry of list.getEntries()) { stats.count++; stats.total += entry.duration; stats.max = Math.max(stats.max, entry.duration); }
    }).observe({ entryTypes: ['longtask'] });
    w.__beat = Date.now();
    setInterval(() => { w.__beat = Date.now(); }, 100);
  });
}

for (const scenario of SCENARIOS) {
  test(`stress ${scenario.name}`, async ({ page }) => {
    test.setTimeout(900_000);
    let crashed = false;
    const errors: string[] = [];
    page.on('crash', () => { crashed = true; note(`[${scenario.name}] PAGE CRASH`); });
    page.on('pageerror', (error) => { errors.push(error.message.slice(0, 200)); note(`[${scenario.name}] pageerror ${error.message.slice(0, 300)}`); });
    await page.goto('/');
    await waitForStore(page);
    const ids = await buildLab(page);
    await openTerminal(page, ids.r);
    await typeIn(page, ids.r, 'enable');
    await typeIn(page, ids.r, 'debug ip nat');
    await openTerminal(page, ids.web2);
    await typeIn(page, ids.web2, 'sudo tcpdump -i eth0 -n');
    await openTerminal(page, ids[scenario.client]);
    await page.waitForTimeout(1500);
    await measure(page);
    const target = scenario.target ?? '170.20.0.2';
    const started = Date.now();
    let maxLag = 0;
    let finished = false;
    for (const line of scenario.before ?? []) await typeIn(page, ids[scenario.client], line);
    const commands = scenario.commands(target);
    for (const [index, command] of commands.entries()) {
      const marker = commands.length > 1 ? `FINISHED${index + 1}` : 'FINISHED';
      await typeIn(page, ids[scenario.client], command).catch((error: Error) => note(`[${scenario.name}] typeIn failed: ${error.message.slice(0, 120)}`));
      finished = false;
      for (let tick = 0; tick < Number(process.env.STRESS_TICKS ?? 560) && !crashed; tick++) {
        await page.waitForTimeout(1000).catch(() => undefined);
        const lag = await Promise.race([
          page.evaluate(() => Date.now() - ((window as Record<string, unknown>).__beat as number)).catch(() => -1),
          new Promise<number>((resolve) => setTimeout(() => resolve(-2), 15_000)),
        ]);
        if (lag < 0) { note(`[${scenario.name}] page unresponsive (${lag})`); break; }
        maxLag = Math.max(maxLag, lag);
        if ((scenario.markerContains !== undefined ? await lineCountContaining(page, ids[scenario.client], scenario.markerContains) : await lineCount(page, ids[scenario.client], marker)) > 0) { finished = true; break; }
      }
      if (!finished) break;
    }
    const stats = await page.evaluate(() => ({
      long: (window as Record<string, unknown>).__long,
      heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6),
      nodes: document.getElementsByTagName('*').length,
    })).catch(() => null);
    if (!finished || process.env.STRESS_DUMP) {
      const text = await page.locator(`[data-testid="terminal-modal"][data-device-id="${ids[scenario.client]}"]`).innerText().catch(() => '');
      writeFileSync(join(OUT, `${scenario.name}.terminal.txt`), text.slice(-6000));
    }
    note(`[${scenario.name}] finished=${finished} crashed=${crashed} elapsed=${Date.now() - started}ms maxLag=${maxLag}ms errors=${errors.length} stats=${JSON.stringify(stats)}`);
    const terminalText = await page.locator(`[data-testid="terminal-modal"][data-device-id="${ids[scenario.client]}"]`).innerText().catch(() => '');
    for (const forbidden of scenario.mustNotContain ?? []) expect(terminalText).not.toContain(forbidden);
    expect(crashed).toBe(false);
    expect(finished).toBe(true);
    expect(errors).toEqual([]);
    expect(maxLag).toBeLessThan(scenario.maxLagMs ?? 3000);
  });
}
