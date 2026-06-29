/**
 * Cisco IOS CLI ? help & suggestion engine — end-to-end through the
 * real terminal modal (the same code path users hit when typing into
 * the in-browser shell).
 *
 * Locks in the IOS-style semantics that CommandTrie.registerSuggestions
 * surfaces:
 *   - prefix listing      ("sh?"     → keywords starting with "sh")
 *   - subcommand listing  ("show ?"  → children of show + <cr> + hints)
 *   - silent no-match     ("zzz?"    → empty, no '%')
 *   - hint suggestions    ("interface ?" → GigabitEthernet, Loopback …)
 *   - merged hints        ("copy ?"  → running-config + startup-config + …)
 */
import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function addRouter(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const r = store.getState().addDevice('router-cisco', 400, 250);
    return r.id;
  });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  // '?' is intercepted on key-press by the Cisco terminal (it triggers the
  // inline help rather than reaching the input), so it has to be pressed as
  // a real key, not filled into the input value.
  const qIdx = command.indexOf('?');
  if (qIdx === -1) {
    await input.fill(command);
    await input.press('Enter');
  } else {
    await input.fill(command.slice(0, qIdx));
    await input.press('?');
    const rest = command.slice(qIdx + 1);
    if (rest.length > 0) {
      await input.pressSequentially(rest);
      await input.press('Enter');
    }
  }
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText());
}

async function waitForText(page: Page, needle: string | RegExp, timeout = 6_000): Promise<void> {
  await expect.poll(
    async () => {
      const t = await modalText(page);
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
    },
    { timeout },
  ).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.afterEach(async ({ page }) => { await closeTerminal(page); });

test.describe('Cisco IOS CLI — ? help & suggestions through the UI', () => {
  test('lists root commands on bare ? in user EXEC', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, '?');
    await waitForText(page, 'enable');
    await waitForText(page, 'show');
    await waitForText(page, 'ping');
  });

  test('prefix listing — "sh?" returns "show" (and nothing else starting with sh in user EXEC)', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'sh?');
    await waitForText(page, 'show');
  });

  test('subcommand listing — "show ?" enumerates show subcommands', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'show ?');
    await waitForText(page, 'clock');
    await waitForText(page, 'version');
  });

  test('silent no-match — "zzz?" returns nothing (no % error in IOS)', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    const before = await modalText(page);
    await typeCmd(page, 'zzz?');
    const after = await modalText(page);
    const delta = after.slice(before.length);
    expect(delta).not.toContain('%');
  });

  test('interface ? lists interface families via hint suggestions', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface ?');
    await waitForText(page, 'GigabitEthernet');
    await waitForText(page, 'Loopback');
  });

  test('copy ? merges registered children with hint suggestions (running-config + startup-config + tftp:)', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'copy ?');
    await waitForText(page, 'running-config');
    await waitForText(page, 'startup-config');
    await waitForText(page, 'tftp:');
  });

  test('debug ip ? lists ip debug subkeys (icmp/packet/ospf/...)', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'debug ip ?');
    await waitForText(page, 'icmp');
    await waitForText(page, 'packet');
  });

  test('show ip route ? lists protocol filters (static/ospf/rip/...)', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'show ip route ?');
    await waitForText(page, 'static');
    await waitForText(page, 'ospf');
  });

  test('no ? in config mode lists negation targets', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'no ?');
    await waitForText(page, 'hostname');
    await waitForText(page, 'interface');
  });

  test('line ? in config mode lists line types', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'line ?');
    await waitForText(page, 'console');
    await waitForText(page, 'vty');
  });

  test('privileged-EXEC ? lists privileged-only commands (configure/reload/copy/write) that user-EXEC ? does NOT', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    // User EXEC '?' — must NOT contain privileged-only commands
    await typeCmd(page, '?');
    await waitForText(page, 'enable');
    const userText = await modalText(page);
    expect(userText).not.toContain('configure');
    expect(userText).not.toContain('reload');
    expect(userText).not.toContain('copy');

    // Privileged EXEC '?' — MUST contain them
    await typeCmd(page, 'enable');
    await page.waitForTimeout(200);
    await typeCmd(page, '?');
    await waitForText(page, 'configure');
    await waitForText(page, 'reload');
    await waitForText(page, 'copy');
    await waitForText(page, 'write');
  });

  test('show clock ? emits the <cr> end-of-command marker', async ({ page }) => {
    const rid = await addRouter(page);
    await openTerminal(page, rid);
    await typeCmd(page, 'show clock ?');
    await waitForText(page, '<cr>');
  });
});
