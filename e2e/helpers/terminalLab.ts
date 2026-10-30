import type { Page } from '@playwright/test';

export async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}

export async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ t, px, py }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, px, py).id;
  }, { t: type, px: x, py: y });
}

export async function cable(page: Page, a: string, b: string): Promise<void> {
  await page.evaluate(({ from, to }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        addConnection(f: string, fi: string, t: string, ti: string): unknown;
        getDevices(): Array<{ id: string; interfaces: Array<{ name: string }> }>;
      };
    };
    const devices = store.getState().getDevices();
    const src = devices.find((d) => d.id === from)!;
    const dst = devices.find((d) => d.id === to)!;
    store.getState().addConnection(from, src.interfaces[0].name, to, dst.interfaces[0].name);
  }, { from: a, to: b });
}

export async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

export async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(200);
}

export async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.waitFor({ state: 'attached', timeout: 15_000 });
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(350);
}

export async function lastLines(page: Page, n = 14): Promise<string> {
  const text = await page.locator('[data-testid="terminal-modal"]').innerText();
  return text.split('\n').slice(-n).join('\n');
}

export async function writeSite(page: Page, config: string): Promise<void> {
  const escaped = config.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n');
  await typeCmd(page, `sh -c 'printf "${escaped}" > /etc/nginx/sites-available/default'`);
}
