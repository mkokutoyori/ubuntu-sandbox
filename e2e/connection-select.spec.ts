/**
 * Cable selection — clicking a connection on the canvas.
 *
 * Regression coverage for a crash where selecting a cable made the
 * whole app unmount ("Rendered more hooks than during the previous
 * render"): PropertiesPanel called useConnectionPerf inside the
 * `if (selectedConnection)` branch. Also covers the midpoint type
 * indicator swallowing clicks and the Status field reading a
 * non-existent `connection.isActive` (it always showed Inactive).
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

async function buildTwoPcLab(page: Page): Promise<void> {
  await page.evaluate(() => {
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, b: string, c: string, d: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const s = store.getState();
    const a = s.addDevice('linux-pc', 200, 200).id;
    const b = s.addDevice('linux-pc', 500, 200).id;
    const port = (id: string) =>
      (store.getState().deviceInstances.get(id)!.getPortNames as () => string[])()[0];
    store.getState().addConnection(a, port(a), b, port(b), 'ethernet');
  });
}

/** Screen coordinates of a point at `t` (0..1) along the cable's wide hitbox path. */
function cablePointAt(page: Page, t: number): Promise<{ x: number; y: number }> {
  return page.evaluate((frac) => {
    const wide = [...document.querySelectorAll<SVGPathElement>('svg path')].find(
      p => p.getAttribute('stroke') === 'transparent' && p.getAttribute('stroke-width') === '20',
    )!;
    const pt = wide.getPointAtLength(wide.getTotalLength() * frac);
    const m = wide.closest('svg')!.getScreenCTM()!;
    return { x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f };
  }, t);
}

test.describe('Connection selection', () => {
  const pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0;
    page.on('pageerror', err => pageErrors.push(err.message));
    await page.goto('/');
    await waitForStore(page);
    await buildTwoPcLab(page);
  });

  test('clicking the cable opens the connection panel without crashing', async ({ page }) => {
    const pt = await cablePointAt(page, 0.25);
    await page.mouse.click(pt.x, pt.y);

    await expect(page.getByRole('heading', { name: 'Connection' })).toBeVisible();
    await expect(page.getByText('Bandwidth')).toBeVisible();
    await expect(page.getByText('Latency')).toBeVisible();
    // Both PCs are powered on and the link is up.
    await expect(page.getByText('Active', { exact: true })).toBeVisible();

    expect(pageErrors).toEqual([]);
    // The app did not white-screen.
    await expect(page.locator('#network-canvas')).toBeVisible();
  });

  test('clicking the midpoint type indicator also selects the cable', async ({ page }) => {
    const pt = await cablePointAt(page, 0.5);
    await page.mouse.click(pt.x, pt.y);

    await expect(page.getByRole('heading', { name: 'Connection' })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
