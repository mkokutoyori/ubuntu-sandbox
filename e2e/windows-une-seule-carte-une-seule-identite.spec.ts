import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 45_000 });
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ type, x, y }) => {
    const store = (window as Record<string, unknown>).__networkStore as { getState(): { addDevice(t: string, x: number, y: number): { id: string } } };
    return store.getState().addDevice(type, x, y).id;
  }, { type, x, y });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function closeTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="terminal-modal"] button[title="Close"]').click();
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

const MODELE = 'Intel(R) 82540EM Gigabit Ethernet Controller';

async function posteCable(page: Page): Promise<string> {
  return page.evaluate(() => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const win = store.getState().addDevice('windows-pc', 300, 260);
    const pair = store.getState().addDevice('linux-pc', 620, 260);
    store.getState().addConnection(win.id, 'eth0', pair.id, 'eth0', 'ethernet');
    return win.id;
  });
}

test.describe('une carte Windows porte une seule identite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 60_000 });
    await waitForStore(page);
  });

  test('les cinq vues nomment la meme carte', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'windows-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'powershell Get-NetAdapter');
    expect(await modalText(page)).toContain(MODELE);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'ipconfig /all');
    expect(await modalText(page)).toContain(`Description . . . . . . . . . . . : ${MODELE}`);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'route print');
    expect(await modalText(page)).toContain(`......${MODELE}`);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'getmac /v');
    expect(await modalText(page)).toContain(MODELE);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'systeminfo');
    expect(await modalText(page)).toContain(`[01]: ${MODELE}`);

    await closeTerminal(page);
  });

  test('getmac transporte le GUID que Get-NetAdapter publie', async ({ page }) => {
    test.slow();
    const pc = await posteCable(page);
    await openTerminal(page, pc);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'getmac');
    const transport = await modalText(page);
    const guid = /\\Device\\Tcpip_(\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\})/
      .exec(transport)?.[1];
    expect(guid).toBeTruthy();

    await typeCmd(page, 'cls');
    await typeCmd(page, 'powershell Get-NetAdapter -Name "Ethernet 0" | Format-List InterfaceGuid');
    expect(await modalText(page)).toContain(guid!);

    await closeTerminal(page);
  });

  test('arp -a numerote l interface comme route print', async ({ page }) => {
    test.slow();
    const pc = await addDevice(page, 'windows-pc', 340, 260);
    await openTerminal(page, pc);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'netsh interface ip set address "Ethernet 0" static 10.0.0.1 255.255.255.0');
    await typeCmd(page, 'cls');
    await typeCmd(page, 'arp -s 10.0.0.9 aa-bb-cc-dd-ee-ff');
    await typeCmd(page, 'cls');
    await typeCmd(page, 'arp -a');
    expect(await modalText(page)).toMatch(/Interface: 10\.0\.0\.1 --- 0x2\b/);

    await typeCmd(page, 'cls');
    await typeCmd(page, 'powershell Get-NetNeighbor');
    const voisins = await modalText(page);
    expect(voisins).toMatch(/ifIndex\s+IPAddress\s+LinkLayerAddress\s+State\s+PolicyStore/);
    expect(voisins).toMatch(/2\s+10\.0\.0\.9\s+AA-BB-CC-DD-EE-FF\s+Permanent/);

    await closeTerminal(page);
  });
});
