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
}

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
    test.setTimeout(600_000);
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
      for (let tick = 0; tick < 300 && !crashed; tick++) {
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
    note(`[${scenario.name}] finished=${finished} crashed=${crashed} elapsed=${Date.now() - started}ms maxLag=${maxLag}ms errors=${errors.length} stats=${JSON.stringify(stats)}`);
    expect(crashed).toBe(false);
    expect(finished).toBe(true);
    expect(errors).toEqual([]);
    expect(maxLag).toBeLessThan(scenario.maxLagMs ?? 3000);
  });
}
