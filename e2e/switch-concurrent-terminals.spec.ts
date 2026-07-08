import { test, expect, type Page, type Locator } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function typeCmdIn(modal: Locator, command: string): Promise<void> {
  const input = modal.locator('input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await modal.page().waitForTimeout(200);
}

async function modalText(modal: Locator): Promise<string> {
  return (await modal.innerText()).trim();
}

async function buildSingleSwitch(page: Page): Promise<string> {
  return page.evaluate(async () => {
    type S = { addDevice(t: string, x: number, y: number): { id: string } };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const sw = store.getState().addDevice('switch-cisco', 400, 300);
    return sw.id;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Two concurrent terminals on the same Cisco switch do not share live CLI state', () => {
  test('changing mode in terminal A does not affect terminal B, even on Enter with an empty line', async ({ page }) => {
    const swId = await buildSingleSwitch(page);
    const deviceIcon = page.locator(`[data-device-id="${swId}"]`).first();

    // Open terminal A
    await deviceIcon.dblclick({ timeout: 8_000 });
    await page.waitForTimeout(800);
    // Peek at the topology (terminal A stays open, just not on top) so the
    // device icon becomes clickable again, then open terminal B — a second,
    // independent terminal to the same switch. Opening B auto-clears the
    // peek, so both end up tiled together, neither minimized.
    await page.locator('button[title="Show topology (terminals stay open)"]').click();
    await page.waitForTimeout(300);
    await deviceIcon.dblclick({ timeout: 8_000 });
    await page.waitForTimeout(800);

    const modals = page.locator('[data-testid="terminal-modal"]');
    await expect(modals).toHaveCount(2, { timeout: 10_000 });
    const modalA = modals.nth(0);
    const modalB = modals.nth(1);

    // Terminal A escalates all the way into config-if mode.
    await typeCmdIn(modalA, 'enable');
    await typeCmdIn(modalA, 'configure terminal');
    await typeCmdIn(modalA, 'interface FastEthernet0/1');
    await expect.poll(() => modalText(modalA)).toMatch(/\(config-if\)#\s*$/);

    // Terminal B must still be sitting at the unauthenticated user prompt —
    // it never ran any command of its own yet.
    let textB = await modalText(modalB);
    expect(textB).not.toContain('(config-if)#');
    expect(textB).not.toContain('(config)#');
    expect(textB).toMatch(/>\s*$/);

    // Pressing Enter on an empty line in B must simply redraw B's own
    // (unchanged) prompt — not adopt A's config-if mode.
    const inputB = modalB.locator('input[type="text"]').last();
    await inputB.click();
    await inputB.press('Enter');
    await page.waitForTimeout(300);
    textB = await modalText(modalB);
    expect(textB).not.toContain('(config-if)#');
    expect(textB).not.toContain('(config)#');
    expect(textB).toMatch(/>\s*$/);
  });
});
