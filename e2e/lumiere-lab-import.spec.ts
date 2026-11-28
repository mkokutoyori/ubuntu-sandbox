import { test, expect } from '@playwright/test';
import { join } from 'path';
import { readFileSync } from 'fs';

test.use({ deviceScaleFactor: 1, viewport: { width: 2000, height: 1100 } });
test.setTimeout(240_000);

const LAB = join(process.cwd(), 'labs/ecommerce-lumiere/topology.json');

type StoreHandle = { getState: () => { deviceInstances: Map<string, { getName(): string; executeCommand(command: string): Promise<string> }>; connections: unknown[] } };

test('the Lumiere lab is opened through the Import button, with no warning, and answers like the lab that was exported', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as Record<string, unknown>).__networkStore, undefined, { timeout: 15_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /import/i }).first().click();
  (await chooser).setFiles(LAB);
  await page.waitForFunction(() => (window as unknown as { __networkStore: StoreHandle }).__networkStore.getState().deviceInstances.size === 35, undefined, { timeout: 120_000 });
  await expect(page.getByText(/warning|avertissement|import failed|échec/i)).toHaveCount(0);
  await page.waitForTimeout(3000);
  const counts = await page.evaluate(() => {
    const state = (window as unknown as { __networkStore: StoreHandle }).__networkStore.getState();
    return { devices: state.deviceInstances.size, connections: state.connections.length };
  });
  const present = await page.evaluate(() => {
    const state = (window as unknown as { __networkStore: StoreHandle }).__networkStore.getState();
    const names = new Map([...state.deviceInstances.entries()].map(([id, device]) => [id, device.getName()]));
    return (state.connections as Array<{ sourceDeviceId: string; sourceInterfaceId: string; targetDeviceId: string; targetInterfaceId: string }>).map((link) => `${names.get(link.sourceDeviceId)}:${link.sourceInterfaceId}-${names.get(link.targetDeviceId)}:${link.targetInterfaceId}`);
  });
  const exported = JSON.parse(readFileSync(LAB, 'utf8')) as { devices: Array<{ id: string; name: string }>; connections: Array<{ sourceDeviceId: string; sourceInterfaceId: string; targetDeviceId: string; targetInterfaceId: string }> };
  const exportedNames = new Map(exported.devices.map((device) => [device.id, device.name]));
  const wanted = exported.connections.map((link) => `${exportedNames.get(link.sourceDeviceId)}:${link.sourceInterfaceId}-${exportedNames.get(link.targetDeviceId)}:${link.targetInterfaceId}`);
  expect(wanted.filter((link) => !present.includes(link))).toEqual([]);
  expect(counts).toEqual({ devices: 35, connections: 34 });
  const answers = await page.evaluate(async () => {
    const state = (window as unknown as { __networkStore: StoreHandle }).__networkStore.getState();
    const byName = new Map([...state.deviceInstances.values()].map((device) => [device.getName(), device]));
    const sql = await byName.get('ORA-PRD')!.executeCommand("sqlplus -s / as sysdba <<'E'\nSELECT COUNT(*) AS n FROM shop.orders;\nE");
    const ping = await byName.get('PC-CLIENT')!.executeCommand('curl -s http://www.lumiere-boutique.com/');
    return { sql, ping };
  });
  expect(answers.sql).toMatch(/\d+/);
  expect(answers.ping).toMatch(/lumi|shop|boutique/i);
  await page.screenshot({ path: 'e2e/__shots__/lumiere-lab-imported.png' });
});
