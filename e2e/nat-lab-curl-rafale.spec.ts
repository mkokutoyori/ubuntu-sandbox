/**
 * Laboratoire « nat-lab » (R-AKWA, ISP, SRV-WEB, EXT : même topologie que `tutoNatLab`), rejoué dans le vrai navigateur : NAT statique sur R-AKWA,
 * `debug ip nat` actif, `tcpdump` lancé dans le terminal du serveur web, puis 200 curl en arrière-plan depuis un hôte.
 *
 * Signalé : la commande `for i in $(seq 1 200); do curl -s -o /dev/null --max-time 5 http://… & done; wait` fait planter l'outil dans le navigateur.
 * Les bancs Node ne le reproduisaient pas (la rafale se termine en 3 s) ; ce spec mesure dans Chromium : plantage de l'onglet, gel de la page
 * (retard d'un battement de 100 ms), erreurs de console, durée jusqu'au marqueur de fin.
 *
 * Mesuré : avec trois terminaux tuilés (R-AKWA en `debug ip nat`, SRV-WEB en `tcpdump`, l'hôte qui lance la rafale), l'ancien `notify()` réveillait
 * TerminalView une fois par ligne (~7 000 rendus d'un défilement de 5 000 lignes) : la page ne répond plus, `press('Enter')` expire après 10 s.
 * Avec `notify()` limité à un réveil par intervalle de 16 ms, la rafale se termine en 4 s et la page reste réactive (retard de battement < 100 ms).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '/tmp/nat-lab';
mkdirSync(OUT, { recursive: true });
const journal = join(OUT, 'journal.log');
writeFileSync(journal, '');
const note = (line: string): void => { appendFileSync(journal, `${new Date().toISOString()} ${line}\n`); console.log(line); };

const COUNT = Number(process.env.NAT_LAB_COUNT ?? 200);
const MODE = process.env.NAT_LAB_MODE ?? 'static';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 30_000 });
}

interface Ids { r: string; isp: string; win: string; lin: string; srv: string; ext: string }

async function buildLab(page: Page): Promise<Ids> {
  return page.evaluate(async () => {
    type Device = Record<string, unknown>;
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Device>;
      addConnection(srcId: string, srcIf: string, dstId: string, dstIf: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const add = (type: string, x: number, y: number): { id: string; device: Device } => {
      const dto = store.getState().addDevice(type, x, y);
      return { id: dto.id, device: store.getState().deviceInstances.get(dto.id) as Device };
    };
    const ports = (d: Device): string[] => (d.getPortNames as () => string[])();
    const run = async (d: Device, lines: string[]): Promise<void> => {
      for (const line of lines) await Promise.resolve((d.executeCommand as (c: string) => Promise<string>).call(d, line));
    };
    const lanSw = add('switch-generic', 400, 300);
    const ispSw = add('switch-generic', 900, 300);
    const r = add('router-cisco', 650, 300);
    const isp = add('router-cisco', 1100, 300);
    const win = add('windows-pc', 200, 100);
    const lin = add('linux-pc', 200, 300);
    const srv = add('linux-server', 200, 500);
    const ext = add('linux-server', 1100, 500);
    const link = (a: { id: string; device: Device }, ai: string, b: { id: string; device: Device }, bi: string): void => {
      store.getState().addConnection(a.id, ai, b.id, bi, 'ethernet');
    };
    const sw = (d: Device, i: number): string => ports(d)[i];
    link(win, ports(win.device)[0], lanSw, sw(lanSw.device, 0));
    link(lin, ports(lin.device)[0], lanSw, sw(lanSw.device, 1));
    link(srv, ports(srv.device)[0], lanSw, sw(lanSw.device, 2));
    link(r, 'GigabitEthernet0/0', lanSw, sw(lanSw.device, 7));
    link(r, 'GigabitEthernet0/1', ispSw, sw(ispSw.device, 0));
    link(isp, 'GigabitEthernet0/0', ispSw, sw(ispSw.device, 1));
    link(ext, ports(ext.device)[0], ispSw, sw(ispSw.device, 2));
    const eth = (d: Device): string => ports(d)[0];
    await run(lin.device, [`sudo ip addr add 192.168.10.22/24 dev ${eth(lin.device)}`, `sudo ip route add default via 192.168.10.1`]);
    await run(srv.device, [`sudo ip addr add 192.168.10.10/24 dev ${eth(srv.device)}`, `sudo ip route add default via 192.168.10.1`, 'systemctl start nginx']);
    await run(ext.device, [`sudo ip addr add 203.0.113.9/28 dev ${eth(ext.device)}`, `sudo ip route add default via 203.0.113.2`, 'systemctl start nginx']);
    await run(r.device, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 203.0.113.2 255.255.255.240', 'no shutdown', 'exit',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end',
      'configure terminal', 'interface GigabitEthernet0/0', 'ip nat inside', 'exit', 'interface GigabitEthernet0/1', 'ip nat outside', 'exit',
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload', 'ip nat inside source static 192.168.10.10 203.0.113.3', 'end',
    ]);
    await run(isp.device, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 203.0.113.1 255.255.255.240', 'no shutdown', 'exit', 'end',
    ]);
    return { r: r.id, isp: isp.id, win: win.id, lin: lin.id, srv: srv.id, ext: ext.id };
  });
}

async function openTerminal(page: Page, deviceId: string): Promise<void> {
  const peek = page.locator('button[title="Show topology (terminals stay open)"]');
  if (await peek.isVisible().catch(() => false)) await peek.click();
  await page.locator(`[data-device-id="${deviceId}"]`).first().dblclick({ timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function typeIn(page: Page, deviceId: string, command: string): Promise<void> {
  const modal = page.locator(`[data-testid="terminal-modal"][data-device-id="${deviceId}"]`);
  const input = modal.locator('input[type="text"]').last();
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
}

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
  const target = MODE === 'static' ? '203.0.113.3' : '203.0.113.9';
  await openTerminal(page, clientId);
  await page.waitForTimeout(1500);
  note(`modals open: ${await page.locator('[data-testid="terminal-modal"]').count()}`);
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
  await page.screenshot({ path: join(OUT, 'end.png') }).catch(() => undefined);
  expect(crashed).toBe(false);
  expect(finished).toBe(true);
  expect(maxLag).toBeLessThan(1500);
});
