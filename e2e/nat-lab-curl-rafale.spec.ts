/**
 * Laboratoire « nat-lab » (R-AKWA, ISP, SRV-WEB, EXT : même topologie que `tutoNatLab`), rejoué dans le vrai navigateur : NAT statique sur R-AKWA,
 * `debug ip nat` actif, `tcpdump` lancé dans le terminal du serveur web, puis 200 curl en arrière-plan depuis un hôte.
 *
 * Signalé : la commande `for i in $(seq 1 200); do curl -s -o /dev/null --max-time 5 http://… & done; wait` fait planter l'outil dans le navigateur.
 * Les bancs Node ne le reproduisaient pas (la rafale se termine en 3 s) ; ce spec mesure dans Chromium : plantage de l'onglet, gel de la page
 * (retard d'un battement de 100 ms), erreurs de console, durée jusqu'au marqueur de fin.
 *
 * Topologie complétée selon le signalement : 170.20.0.0/24 est branché sur Gi0/1 de l'ISP par un switch Cisco, et le serveur Linux qui y répond (170.20.0.2) a
 * pris son adresse par DHCP (le bail ne porte pas de passerelle). Modes : `dhcp` (défaut : l'hôte du LAN curl 170.20.0.2 à travers le PAT, tcpdump dans ce
 * serveur), `static` (hôte extérieur vers l'adresse du NAT statique), `pat` (hôte du LAN vers l'hôte EXT).
 *
 * Mesuré (mode dhcp, quatre terminaux tuilés : R-AKWA en `debug ip nat`, le serveur en `tcpdump`, SRV-WEB et l'hôte qui lance la rafale) :
 *   - ancien `notify()` : tâches longues de 13,3 s au total (la plus longue 4,2 s), tas JS 703 Mo, 8 579 noeuds DOM, la page ne répond plus (retard de battement 4,2 s) ;
 *   - `notify()` limité à un réveil par 16 ms : 2,0 s au total (la plus longue 1,3 s, le travail synchrone de la simulation), tas 435 Mo, 4 567 noeuds.
 * Le spec échoue sur l'ancien code (retard de battement > 1,5 s ou `press` expiré) et passe sur le nouveau.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLab, openTerminal, typeIn, waitForStore } from './helpers/natLab';

const OUT = '/tmp/nat-lab';
mkdirSync(OUT, { recursive: true });
const journal = join(OUT, 'journal.log');
writeFileSync(journal, '');
const note = (line: string): void => { appendFileSync(journal, `${new Date().toISOString()} ${line}\n`); console.log(line); };

const COUNT = Number(process.env.NAT_LAB_COUNT ?? 200);
const MODE = process.env.NAT_LAB_MODE ?? 'dhcp';

test('200 curl en arrière-plan, tcpdump et debug ip nat actifs', async ({ page }) => {
  test.setTimeout(240_000);
  let crashed = false;
  page.on('crash', () => { crashed = true; note('PAGE CRASH'); });
  page.on('pageerror', (error) => note(`pageerror ${error.message.slice(0, 300)}`));
  page.on('console', (message) => { if (message.type() === 'error') note(`console.error ${message.text().slice(0, 300)}`); });
  await page.goto('/');
  await waitForStore(page);
  const ids = await buildLab(page);
  note(`lab built ${JSON.stringify(ids)}`);

  await openTerminal(page, ids.r);
  await typeIn(page, ids.r, 'enable');
  await typeIn(page, ids.r, 'debug ip nat');
  await openTerminal(page, ids.srv);
  await typeIn(page, ids.srv, 'sudo tcpdump -i eth0 -n');
  const clientId = MODE === 'static' ? ids.ext : ids.lin;
  const leased = await page.evaluate(async (id) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, Record<string, unknown>> } };
    const device = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    return String(await (device.executeCommand as (c: string) => Promise<string>).call(device, 'ip -4 addr show eth0; ip route'));
  }, ids.web2);
  note(`web2 lease: ${leased.replace(/\n/g, ' | ')}`);
  const target = MODE === 'static' ? '203.0.113.3' : MODE === 'dhcp' ? '170.20.0.2' : '203.0.113.9';
  if (MODE === 'dhcp') { await openTerminal(page, ids.web2); await typeIn(page, ids.web2, 'sudo tcpdump -i eth0 -n'); }
  await openTerminal(page, clientId);
  await page.waitForTimeout(1500);
  note(`modals open: ${await page.locator('[data-testid="terminal-modal"]').count()}`);
  await page.evaluate(() => {
    const w = window as Record<string, unknown>;
    w.__long = { count: 0, total: 0, max: 0 };
    new PerformanceObserver((list) => {
      const stats = w.__long as { count: number; total: number; max: number };
      for (const entry of list.getEntries()) { stats.count++; stats.total += entry.duration; stats.max = Math.max(stats.max, entry.duration); }
    }).observe({ entryTypes: ['longtask'] });
  });
  await page.evaluate(() => { (window as Record<string, unknown>).__beat = Date.now(); setInterval(() => { (window as Record<string, unknown>).__beat = Date.now(); }, 100); });
  const started = Date.now();
  await typeIn(page, clientId, `for i in $(seq 1 ${COUNT}); do curl -s -o /dev/null --max-time 5 http://${target}/ & done; wait; echo FINISHED`);
  let finished = false;
  let maxLag = 0;
  for (let tick = 0; tick < 150 && !crashed; tick++) {
    await page.waitForTimeout(1000).catch(() => undefined);
    const lag = await Promise.race([
      page.evaluate(() => Date.now() - ((window as Record<string, unknown>).__beat as number)).catch(() => -1),
      new Promise<number>((resolve) => setTimeout(() => resolve(-2), 8000)),
    ]);
    const done = await page.locator(`[data-testid="terminal-modal"][data-device-id="${clientId}"]`).getByText('FINISHED', { exact: true }).count().catch(() => 0);
    note(`t+${Date.now() - started}ms beatLag=${lag} finishedMarker=${done}`);
    if (lag < 0) break;
    maxLag = Math.max(maxLag, lag);
    if (done > 0) { finished = true; break; }
  }
  const stats = await page.evaluate(() => ({
    long: (window as Record<string, unknown>).__long,
    heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6),
    nodes: document.getElementsByTagName('*').length,
  })).catch(() => null);
  note(`stats ${JSON.stringify(stats)}`);
  await page.screenshot({ path: join(OUT, 'end.png') }).catch(() => undefined);
  expect(crashed).toBe(false);
  expect(finished).toBe(true);
  expect(maxLag).toBeLessThan(1500);
});
