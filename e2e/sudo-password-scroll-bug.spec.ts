import { test, expect, type Page } from '@playwright/test';

/**
 * Scénario (e2e) — `sudo su` (ou tout autre déclencheur d'un prompt de
 * mot de passe) dans un terminal Linux avec assez de scrollback casse le
 * rendu : la moitié de l'écran du terminal devient noire.
 *
 * Cause réelle : le champ mot de passe (et 2 autres inputs "cachés" —
 * pager, capture de flux `tail -f`) portait à la fois l'attribut JSX
 * natif `autoFocus` ET un `useEffect` qui refait le focus plus tard.
 * `autoFocus` tire en premier, SANS `preventScroll`, et le navigateur
 * fait défiler un ancêtre `overflow-hidden` (le wrapper autour de
 * TerminalView dans TerminalModal.tsx, qui n'a jamais eu vocation à
 * défiler) de plusieurs centaines de pixels pour "révéler" cet input
 * de 1×1px caché par `clip`. Le contenu réel se retrouve décalé hors
 * champ pendant qu'un fond `fixed` noir à 60% reste ancré au viewport,
 * exposant du noir.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}
async function addDevice(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(t, 400, 300).id;
  }, type);
}
async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}
async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

test.describe('Scénario (e2e) — sudo su avec scrollback ne doit pas casser le rendu du terminal', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('le fond du terminal reste correct sous le prompt de mot de passe (pas de noir)', async ({ page }) => {
    await typeCmd(page, 'seq 1 60');
    await typeCmd(page, 'sudo su');
    await expect(page.getByText('password for user')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);

    const bg = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="terminal-modal"]');
      if (!modal) return null;
      const rect = modal.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height * 0.7;
      // Walk up from the hit point to the first ancestor that actually
      // paints a background — text lines themselves are transparent
      // `<pre>`s sitting on their scrollable container's own bg, so the
      // direct hit is expected to be transparent; what matters is what's
      // BEHIND it (the terminal's purple, pre-bug) vs the black backdrop
      // dimmer that was showing through when the content had scrolled away.
      let el: Element | null = document.elementFromPoint(x, y);
      while (el) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)') return bg;
        el = el.parentElement;
      }
      return null;
    });
    // The Linux terminal's own background — not the black canvas-dimming backdrop.
    expect(bg).toBe('rgb(48, 10, 36)');
  });

  test('aucun ancêtre non prévu pour défiler n\'a de scrollTop après le prompt de mot de passe', async ({ page }) => {
    await typeCmd(page, 'seq 1 60');
    await typeCmd(page, 'sudo su');
    await expect(page.getByText('password for user')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);

    const stray = await page.evaluate(() => {
      const pwInput = document.querySelector('input[type="password"]');
      const results: Array<{ cls: string; scrollTop: number }> = [];
      let el: HTMLElement | null = pwInput as HTMLElement | null;
      let depth = 0;
      while (el && depth < 20) {
        // The terminal's own scrollable output area is EXPECTED to have
        // scrollTop > 0 (it auto-scrolls to the bottom) — only flag
        // OTHER ancestors that unexpectedly picked up a scroll offset.
        if (el.scrollTop > 0 && !el.className.toString().includes('overflow-auto')) {
          results.push({ cls: el.className.toString().slice(0, 80), scrollTop: el.scrollTop });
        }
        el = el.parentElement;
        depth++;
      }
      return results;
    });
    expect(stray).toEqual([]);
  });
});
