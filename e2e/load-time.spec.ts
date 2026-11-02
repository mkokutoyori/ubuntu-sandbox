/**
 * Load-time budget, measured in the browser.
 *
 * The first screen used to import the whole simulator (28 MB of source, 3 788
 * module requests in dev, one 16 MB chunk in production) and its stylesheet
 * went through a Tailwind scan of every source file (26 s on a cold dev
 * server). This spec drives the real UI with the platform-lazy mode switched
 * on (`ubuntu-sandbox.lazyPlatforms`) and proves three things:
 *
 *   - the first screen reaches the palette without requesting any simulation
 *     module (device platforms, Oracle, PowerShell, bash, terminal sessions);
 *   - each heavy piece arrives on demand, at the gesture that needs it:
 *     a device platform on hover or click, the terminal on double-click, the
 *     topology serializer on Save;
 *   - an automated browser that does NOT ask for lazy mode still gets every
 *     platform before the store handle appears, which is what the other
 *     specs rely on to call `addDevice` synchronously.
 *
 * The thresholds sit far above what was measured (158 requests, 1.5 s cold)
 * and far below what the monolithic entry cost (3 788 requests, 29 s), so
 * they catch a regression of the old shape without tracking machine noise.
 */
import { test, expect, type Page, type Request } from '@playwright/test';
import { DEVICE_CATEGORIES } from '../src/network/core/deviceCatalog';
import { LAZY_PLATFORMS_FLAG } from '../src/lazyPlatforms';

const SIMULATION_PREFIXES = [
  '/src/network/devices/platforms/',
  '/src/network/devices/Linux',
  '/src/network/devices/Windows',
  '/src/network/devices/Cisco',
  '/src/network/devices/Huawei',
  '/src/network/devices/EndHost',
  '/src/network/ospf/',
  '/src/network/bgp/',
  '/src/network/tcp/',
  '/src/database/',
  '/src/powershell/',
  '/src/bash/',
  '/src/terminal/sessions/',
  '/src/terminal/commands/',
  '/src/store/topologySerializer',
  '/src/components/network/TerminalModal',
];

interface DeviceSnapshot { type: string; x: number; y: number }

interface StoreHandle {
  getState(): {
    getDevices(): DeviceSnapshot[];
    addDevice(type: string, x: number, y: number): unknown;
  };
}

const MAX_SCRIPT_REQUESTS_FIRST_SCREEN = 400;
const MAX_FIRST_SCREEN_MS = 15_000;

interface RequestLog {
  readonly paths: string[];
  matching(fragment: string): string[];
}

function recordScriptRequests(page: Page): RequestLog {
  const paths: string[] = [];
  page.on('request', (request: Request) => {
    if (request.resourceType() !== 'script') return;
    paths.push(new URL(request.url()).pathname);
  });
  return {
    paths,
    matching: (fragment) => paths.filter((path) => path.includes(fragment)),
  };
}

async function enterLazyMode(page: Page, value: 'strict' | 'idle' = 'strict'): Promise<void> {
  await page.addInitScript(({ flag, stored }) => {
    try {
      window.localStorage.setItem(flag, stored);
    } catch {
      return;
    }
  }, { flag: LAZY_PLATFORMS_FLAG, stored: value === 'strict' ? '1' : 'idle' });
}

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>).__networkStore,
    { timeout: 20_000 },
  );
}

function addButton(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^Add ${name} to canvas`) });
}

function simulationRequests(log: RequestLog): string[] {
  return log.paths.filter((path) => SIMULATION_PREFIXES.some((prefix) => path.includes(prefix)));
}

test.describe('lazy mode', () => {
  test.beforeEach(async ({ page }) => {
    await enterLazyMode(page);
  });

  test('the first screen is usable without requesting any simulation module', async ({ page }) => {
    test.setTimeout(60_000);
    const log = recordScriptRequests(page);
    const startedAt = Date.now();

    await page.goto('/');
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);
    const elapsed = Date.now() - startedAt;

    expect(simulationRequests(log)).toEqual([]);
    expect(log.paths.length).toBeGreaterThan(20);
    expect(log.paths.length).toBeLessThan(MAX_SCRIPT_REQUESTS_FIRST_SCREEN);
    expect(elapsed).toBeLessThan(MAX_FIRST_SCREEN_MS);

    const devices = await page.evaluate(
      () => (window as unknown as { __networkStore: StoreHandle }).__networkStore.getState().getDevices().length,
    );
    expect(devices).toBe(0);
  });

  test('hovering a palette entry starts loading its platform, and only its platform', async ({ page }) => {
    test.setTimeout(60_000);
    const log = recordScriptRequests(page);
    await page.goto('/');
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);
    expect(log.matching('/platforms/')).toEqual([]);

    const waitForPlatform = page.waitForRequest((request) => request.url().includes('/platforms/linuxPlatform'));
    await addButton(page, 'Linux PC').hover();
    await waitForPlatform;

    expect(log.matching('/platforms/linuxPlatform').length).toBeGreaterThan(0);
    expect(log.matching('/platforms/windowsPlatform')).toEqual([]);
    expect(log.matching('/platforms/ciscoPlatform')).toEqual([]);
    expect(log.matching('/platforms/huaweiPlatform')).toEqual([]);
  });

  test('clicking a palette entry whose platform is not loaded still adds the device', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await expect(addButton(page, 'Windows PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);

    await addButton(page, 'Windows PC').click();
    await expect(page.locator('[data-device-id]')).toHaveCount(1, { timeout: 60_000 });

    const added = await page.evaluate(() => {
      const store = (window as unknown as { __networkStore: StoreHandle }).__networkStore;
      return store.getState().getDevices().map((device) => device.type);
    });
    expect(added).toEqual(['windows-pc']);
  });

  test('adding through an unloaded platform is announced as an addition, not only as a selection', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await expect(addButton(page, 'Windows PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);

    await addButton(page, 'Windows PC').click();
    await expect(page.getByRole('status')).toContainText('added to canvas', { timeout: 60_000 });
  });

  test('two quick clicks on an unloaded platform give two devices on distinct positions', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);

    const button = addButton(page, 'Linux PC');
    await button.click();
    await button.click();
    await expect(page.locator('[data-device-id]')).toHaveCount(2, { timeout: 60_000 });

    const positions = await page.evaluate(() =>
      (window as unknown as { __networkStore: StoreHandle }).__networkStore.getState().getDevices()
        .map((device) => ({ x: device.x, y: device.y })),
    );
    expect(positions).toHaveLength(2);
    expect(positions[0]).not.toEqual(positions[1]);
  });

  test('the terminal arrives at the double-click, not before', async ({ page }) => {
    test.setTimeout(90_000);
    const log = recordScriptRequests(page);
    await page.goto('/');
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);

    await addButton(page, 'Linux PC').click();
    const device = page.locator('[data-device-id]').first();
    await expect(device).toBeVisible({ timeout: 60_000 });
    expect(log.matching('/components/network/TerminalModal')).toEqual([]);
    expect(log.matching('/terminal/sessions/TerminalManager')).toEqual([]);

    await device.dblclick();
    await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 60_000 });
    expect(log.matching('/components/network/TerminalModal').length).toBeGreaterThan(0);
    expect(log.matching('/terminal/sessions/TerminalManager').length).toBeGreaterThan(0);

    const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
    await input.waitFor({ state: 'attached', timeout: 15_000 });
    await input.focus();
    await input.fill('echo load-time-ok');
    await input.press('Enter');
    await expect(page.locator('[data-testid="terminal-modal"]')).toContainText('load-time-ok', { timeout: 10_000 });
  });

  test('Save loads the topology serializer on demand and persists the device', async ({ page }) => {
    test.setTimeout(90_000);
    const log = recordScriptRequests(page);
    await page.goto('/');
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);

    await addButton(page, 'Linux PC').click();
    await expect(page.locator('[data-device-id]')).toHaveCount(1, { timeout: 60_000 });
    expect(log.matching('/store/topologySerializer')).toEqual([]);

    const topologyName = `e2e-load-time-${Date.now()}`;
    await page.locator('button[title="Save"]').click();
    const saveDialog = page.getByRole('dialog');
    await expect(saveDialog).toBeVisible();
    await saveDialog.getByPlaceholder('Topology name').fill(topologyName);
    await saveDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(saveDialog).toBeHidden({ timeout: 20_000 });

    expect(log.matching('/store/topologySerializer').length).toBeGreaterThan(0);
    const saved = await page.evaluate(
      (name) => JSON.parse(localStorage.getItem(`ubuntu-sandbox:topology:${name}`) ?? 'null'),
      topologyName,
    );
    expect(saved).not.toBeNull();
    expect(saved.devices).toHaveLength(1);
  });

  test('a saved topology reopens in a fresh page whose platforms are not loaded yet', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);
    await addButton(page, 'Linux PC').click();
    await addButton(page, 'Linux PC').click();
    await expect(page.locator('[data-device-id]')).toHaveCount(2, { timeout: 60_000 });

    const topologyName = `e2e-reopen-${Date.now()}`;
    await page.locator('button[title="Save"]').click();
    const saveDialog = page.getByRole('dialog');
    await saveDialog.getByPlaceholder('Topology name').fill(topologyName);
    await saveDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(saveDialog).toBeHidden({ timeout: 20_000 });

    await page.reload();
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);
    await expect(page.locator('[data-device-id]')).toHaveCount(0);

    await page.locator('button[title="Open"]').click();
    const openDialog = page.getByRole('dialog', { name: 'Open topology' });
    await expect(openDialog).toBeVisible();
    await openDialog.getByText(topologyName).click();
    await expect(page.locator('[data-device-id]')).toHaveCount(2, { timeout: 60_000 });
  });
});

test.describe('lazy mode with idle preload', () => {
  test('once the first screen is up, only the Linux platform is fetched in the background', async ({ page }) => {
    test.setTimeout(90_000);
    await enterLazyMode(page, 'idle');
    const log = recordScriptRequests(page);
    await page.goto('/');
    await expect(addButton(page, 'Linux PC')).toBeVisible({ timeout: MAX_FIRST_SCREEN_MS });
    await waitForStore(page);

    await expect.poll(() => log.matching('/platforms/linuxPlatform').length, { timeout: 30_000 }).toBeGreaterThan(0);
    for (const other of ['windows', 'cisco', 'huawei', 'generic', 'asa', 'fortigate']) {
      expect(log.matching(`/platforms/${other}Platform`)).toEqual([]);
    }
    expect(log.matching('/components/network/TerminalModal')).toEqual([]);

    await addButton(page, 'Linux PC').click();
    await expect(page.locator('[data-device-id]')).toHaveCount(1, { timeout: 60_000 });
  });
});

test.describe('automated browser without lazy mode', () => {
  test('every palette device can be added synchronously as soon as the store handle exists', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);

    const types = DEVICE_CATEGORIES.flatMap((category) => category.devices.map((device) => device.type));
    expect(types.length).toBeGreaterThan(10);

    const created = await page.evaluate((deviceTypes) => {
      const store = (window as unknown as { __networkStore: StoreHandle }).__networkStore;
      return deviceTypes.map((type, index) => {
        store.getState().addDevice(type, 100 + index * 10, 100);
        return store.getState().getDevices().length;
      });
    }, types);
    expect(created).toEqual(types.map((_, index) => index + 1));
  });
});
