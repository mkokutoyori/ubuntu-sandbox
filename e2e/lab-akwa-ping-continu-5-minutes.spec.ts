/**
 * Lab « SSH_TP_LAN » de l'utilisateur, joué dans le vrai navigateur : la sauvegarde est posée
 * dans le stockage local, rouverte par la vraie boîte Ouvrir, `no shutdown` sur chaque
 * interface de chaque routeur, puis `ping 192.168.10.3 -t` tapé dans le terminal de PC11 (Akwa)
 * et laissé tourner cinq minutes.
 *
 * Signalé par l'utilisateur dans l'application : une dizaine de réponses, puis « Request timed
 * out » et « Reply from 192.168.50.1: Destination net unreachable » en boucle — la route OSPF
 * d'Akwa disparaît. Les bancs Node (horloge de simulation jouée à 1× et 10×, quatre-vingts
 * secondes de ping) ne le reproduisaient pas ; ce spec mesure donc dans le navigateur, avec
 * l'horloge de simulation de l'application.
 *
 * Toutes les cinq secondes le spec lit l'état OSPF des quatre routeurs par le magasin et le
 * journal du terminal ; au premier échec il consigne `show logging`, les voisins et les routes
 * de MAIN_RT_AKWA et de MAIN_RT01 dans /tmp/lab-akwa, puis fait échouer le cas.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPORT = join(process.cwd(), 'src', '__tests__', 'unit', 'new_firewall', 'SSH_TP_LAN.topology (7).json');
const OUT = '/tmp/lab-akwa';
const ROUTERS = ['MAIN_RT01', 'MAIN_RT02', 'MAIN_RT_HO', 'MAIN_RT_AKWA'];
const DURATION_MS = Number(process.env.LAB_AKWA_MS ?? 300_000);
const SAVED_NAME = 'SSH_TP_LAN_e2e';

mkdirSync(OUT, { recursive: true });
const journalPath = join(OUT, 'journal.log');
writeFileSync(journalPath, '');
const note = (line: string): void => { appendFileSync(journalPath, `${line}\n`); };

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 30_000 });
}

async function openSavedTopology(page: Page): Promise<void> {
  const topology = readFileSync(EXPORT, 'utf8');
  await page.evaluate(({ name, topology }) => {
    localStorage.setItem(`ubuntu-sandbox:topology:${name}`, topology);
  }, { name: SAVED_NAME, topology });
  await page.locator('button[title="Open"]').click();
  const openDialog = page.getByRole('dialog', { name: 'Open topology' });
  await expect(openDialog).toBeVisible();
  await openDialog.getByText(SAVED_NAME).click();
  const replaceConfirm = page.getByRole('alertdialog');
  if (await replaceConfirm.isVisible().catch(() => false)) {
    await replaceConfirm.getByRole('button', { name: 'Replace' }).click();
  }
  await expect(openDialog).toBeHidden({ timeout: 60_000 });
  await page.waitForFunction(
    () => ((window as Record<string, unknown>).__networkStore as { getState(): { deviceInstances: Map<string, unknown> } })
      .getState().deviceInstances.size >= 22,
    { timeout: 60_000 });
}

async function idOf(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, { getName(): string; getId(): string }> };
    };
    for (const device of store.getState().deviceInstances.values()) {
      if (device.getName() === name) return device.getId();
    }
    return '';
  }, name);
}

async function runOnDevice(page: Page, name: string, commands: string[]): Promise<string[]> {
  return page.evaluate(async ({ name, commands }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Record<string, unknown>> };
    };
    let target: Record<string, unknown> | undefined;
    for (const device of store.getState().deviceInstances.values()) {
      if ((device.getName as () => string)() === name) target = device;
    }
    if (!target) return ['no such device'];
    const outputs: string[] = [];
    for (const command of commands) {
      outputs.push(String(await (target.executeCommand as (c: string) => Promise<string>)(command)));
    }
    return outputs;
  }, { name, commands });
}

async function startAllInterfaces(page: Page, router: string): Promise<void> {
  const ports = await page.evaluate((router) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Record<string, unknown>> };
    };
    for (const device of store.getState().deviceInstances.values()) {
      if ((device.getName as () => string)() === router) {
        return (device.getPorts as () => Array<{ getName(): string }>)().map((p) => p.getName());
      }
    }
    return [];
  }, router);
  const script = ['enable', 'configure terminal'];
  for (const port of ports) script.push(`interface ${port}`, 'no shutdown', 'exit');
  script.push('end');
  await runOnDevice(page, router, script);
}

async function traceOspf(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Record<string, unknown>> };
    };
    const log: string[] = [];
    (window as Record<string, unknown>).__ospfTrace = log;
    const patched = new Set<unknown>();
    for (const device of store.getState().deviceInstances.values()) {
      const integration = device.ospfIntegration as Record<string, unknown> | undefined;
      if (!integration) continue;
      const proto = Object.getPrototypeOf(integration) as Record<string, (...a: unknown[]) => unknown>;
      if (patched.has(proto)) continue;
      patched.add(proto);
      const send = proto.sendPacket;
      const receive = proto.receivePacket;
      const nameOf = (self: Record<string, unknown>): string => String((self.ctx as { name: string }).name);
      const stamp = (): string => new Date().toISOString().slice(14, 23);
      proto.sendPacket = function (this: Record<string, unknown>, iface: unknown, packet: unknown, dest: unknown) {
        log.push(`${stamp()} ${nameOf(this)} TX ${iface} type=${(packet as { packetType?: number }).packetType} -> ${dest}`);
        return send.call(this, iface, packet, dest);
      };
      proto.receivePacket = function (this: Record<string, unknown>, iface: unknown, src: unknown, packet: unknown) {
        log.push(`${stamp()} ${nameOf(this)} RX ${iface} type=${(packet as { packetType?: number }).packetType} <- ${src}`);
        return receive.call(this, iface, src, packet);
      };
    }
  });
}

async function helloTimers(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Record<string, unknown>> };
    };
    const parts: string[] = [];
    for (const device of store.getState().deviceInstances.values()) {
      const integration = device.ospfIntegration as { ospfEngine?: { getInterfaces(): Map<string, Record<string, unknown>> } } | undefined;
      const engine = integration?.ospfEngine;
      if (!engine) continue;
      const interfaces = [...engine.getInterfaces()].map(([name, iface]) =>
        `${name.replace('GigabitEthernet', 'Gi')}:${String(iface.state)}${iface.helloTimer ? '+T' : '-T'}${iface.passive ? 'P' : ''}`);
      parts.push(`${(device.getName as () => string)().replace('MAIN_', '')}{${interfaces.join(' ')}}`);
    }
    return parts.join(' ');
  });
}

async function ospfSnapshot(page: Page): Promise<string> {
  const lines: string[] = [];
  for (const router of ROUTERS) {
    const [neighbors, routes] = await runOnDevice(page, router, ['show ip ospf neighbor', 'show ip route']);
    const states = neighbors.split('\n').slice(1).filter((l) => l.trim()).map((l) => l.trim().split(/\s+/)[2]).join(',');
    const ospfRoutes = routes.split('\n').filter((l) => /^O/.test(l)).length;
    lines.push(`${router.replace('MAIN_', '')}[${states}|O=${ospfRoutes}]`);
  }
  return lines.join(' ');
}

async function dumpFailure(page: Page, reason: string): Promise<void> {
  const report: string[] = [`FAILURE: ${reason}`];
  for (const router of ['MAIN_RT_AKWA', 'MAIN_RT01', 'MAIN_RT02', 'MAIN_RT_HO']) {
    const outputs = await runOnDevice(page, router, [
      'show logging', 'show ip ospf neighbor', 'show ip route', 'show ip ospf database',
    ]);
    report.push(`===== ${router}`, ...outputs);
  }
  const trace = await page.evaluate(() => ((window as Record<string, unknown>).__ospfTrace as string[] | undefined) ?? []);
  writeFileSync(join(OUT, 'ospf-trace.txt'), trace.join('\n'));
  writeFileSync(join(OUT, 'failure.txt'), report.join('\n'));
  await page.screenshot({ path: join(OUT, 'failure.png') });
}

test.describe('Lab SSH_TP_LAN : ping continu Akwa -> Head Office', () => {
  test('PC11 joint PC6 pendant toute la durée, sans perdre la route OSPF', async ({ page }) => {
    test.setTimeout(DURATION_MS + 240_000);
    page.on('pageerror', (error) => note(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') note(`console.error: ${message.text()}`); });

    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
    await openSavedTopology(page);

    await traceOspf(page);
    note(`timers after open: ${await helloTimers(page)}`);
    for (const router of ROUTERS) {
      await startAllInterfaces(page, router);
      note(`timers after ${router} no shutdown: ${await helloTimers(page)}`);
    }
    note(`after no shutdown: ${await ospfSnapshot(page)}`);

    const pc11 = await idOf(page, 'PC11');
    expect(pc11).not.toBe('');
    await page.locator(`[data-device-id="${pc11}"]`).first().dblclick({ timeout: 15_000 });
    const terminal = page.locator('[data-testid="terminal-modal"]');
    await terminal.waitFor({ state: 'visible', timeout: 15_000 });
    const input = terminal.locator('input[type="text"]').last();
    await input.waitFor({ state: 'attached', timeout: 20_000 });
    await input.focus();
    await input.fill('ping 192.168.10.3 -t');
    await input.press('Enter');

    const started = Date.now();
    let lastReport = 0;
    while (Date.now() - started < DURATION_MS) {
      await page.waitForTimeout(5_000);
      const text = await terminal.innerText();
      const replies = (text.match(/Reply from 192\.168\.10\.3/g) ?? []).length;
      const unreachable = (text.match(/Destination net unreachable/g) ?? []).length;
      const timedOut = (text.match(/Request timed out/g) ?? []).length;
      const elapsed = Math.round((Date.now() - started) / 1000);
      const snapshot = await ospfSnapshot(page);
      if (elapsed % 10 < 5) note(`timers t=${elapsed}s: ${await helloTimers(page)}`);
      note(`t=${elapsed}s replies=${replies} unreachable=${unreachable} timeouts=${timedOut} ${snapshot}`);
      if (unreachable > 0 || timedOut > 0) {
        await dumpFailure(page, `t=${elapsed}s replies=${replies} unreachable=${unreachable} timeouts=${timedOut}`);
        writeFileSync(join(OUT, 'terminal.txt'), text);
        expect(unreachable + timedOut, `route perdue à t=${elapsed}s, voir ${OUT}/failure.txt`).toBe(0);
      }
      if (elapsed - lastReport >= 60) {
        lastReport = elapsed;
        await page.screenshot({ path: join(OUT, `t${elapsed}.png`) });
      }
    }

    const finalText = await terminal.innerText();
    writeFileSync(join(OUT, 'terminal.txt'), finalText);
    const lastLine = finalText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).at(-1) ?? '';
    expect(lastLine).toMatch(/^Reply from 192\.168\.10\.3/);
  });
});
