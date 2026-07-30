/**
 * E2E — un lien mort se voit sur le canvas (docs/PRD-Link-State.md §6).
 *
 * `cable-unplug.spec.ts` couvre déjà ce qu'un débranchement fait au
 * *trafic* : le ping échoue, la session SSH casse. Ce fichier-ci couvre
 * ce que l'opérateur en *voit*, et les deux autres causes de perte de
 * porteuse qui n'existaient pas encore : le port d'en face désactivé, et
 * l'équipement d'en face éteint.
 *
 * Le canvas ne savait rien dire de tout cela : la ligne prenait la
 * couleur du type de câble, et le panneau affichait « Connected » dès
 * qu'un câble était dessiné — c'est-à-dire qu'il répondait « est-ce
 * câblé ? » à la question « est-ce que ça passe ? ».
 */

import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

interface Lab { pcId: string; swId: string; swPort: string }

/** Un poste Linux raccordé au Fa0/1 d'un switch Cisco. */
async function setupPcOnSwitch(page: Page): Promise<Lab> {
  return page.evaluate(async () => {
    type StoreState = {
      addDevice(type: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(srcId: string, srcIf: string, dstId: string, dstIf: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };

    const pcDto = store.getState().addDevice('linux-pc', 300, 300);
    const swDto = store.getState().addDevice('switch-cisco', 600, 300);
    const pc = store.getState().deviceInstances.get(pcDto.id) as Record<string, unknown>;
    const sw = store.getState().deviceInstances.get(swDto.id) as Record<string, unknown>;

    const pcPort = (pc.getPortNames as () => string[])().find(n => n.startsWith('eth'))!;
    const swPort = (sw.getPortNames as () => string[])().find(n => n.startsWith('FastEthernet'))!;

    const exec = pc.executeCommand as (cmd: string) => Promise<string> | string;
    await Promise.resolve(exec.call(pc, `sudo ip addr add 192.168.10.101/24 dev ${pcPort}`));

    store.getState().addConnection(pcDto.id, pcPort, swDto.id, swPort, 'ethernet');
    return { pcId: pcDto.id, swId: swDto.id, swPort };
  });
}

/** Le `shutdown` de l'opérateur, tapé dans la CLI du switch. */
async function shutdownSwitchPort(page: Page, swId: string, iface: string, on: boolean): Promise<void> {
  await page.evaluate(async ({ swId, iface, on }) => {
    type StoreState = { deviceInstances: Map<string, Record<string, unknown>> };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const sw = store.getState().deviceInstances.get(swId) as Record<string, unknown>;
    const exec = sw.executeCommand as (cmd: string) => Promise<string> | string;
    for (const line of ['enable', 'configure terminal', `interface ${iface}`,
      on ? 'no shutdown' : 'shutdown', 'end']) {
      await Promise.resolve(exec.call(sw, line));
    }
  }, { swId, iface, on });
}

async function setPower(page: Page, deviceId: string, on: boolean): Promise<void> {
  await page.evaluate(({ deviceId, on }) => {
    type StoreState = { deviceInstances: Map<string, Record<string, unknown>> };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    const dev = store.getState().deviceInstances.get(deviceId) as Record<string, unknown>;
    (dev[on ? 'powerOn' : 'powerOff'] as () => void).call(dev);
  }, { deviceId, on });
}

async function unplugEverything(page: Page): Promise<void> {
  await page.evaluate(() => {
    type StoreState = { connections: Array<{ id: string }>; removeConnection(id: string): void };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
    for (const c of [...store.getState().connections]) store.getState().removeConnection(c.id);
  });
}

/** La ligne du canvas, interrogée par son état déclaré. */
const link = (page: Page) => page.locator('[data-link-state]').first();

/** Ouvre le panneau de propriétés sur un équipement. */
async function selectDevice(page: Page, deviceId: string): Promise<void> {
  await page.locator(`[data-device-id="${deviceId}"]`).first().click();
}

test.describe('canvas — les trois causes de perte de porteuse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('un lien sain se déclare `up`', async ({ page }) => {
    await setupPcOnSwitch(page);
    await expect(link(page)).toHaveAttribute('data-link-state', 'up');
    await expect(link(page)).toHaveAttribute('aria-label', /link up/);
  });

  test('le câble débranché fait disparaître la ligne', async ({ page }) => {
    await setupPcOnSwitch(page);
    await expect(link(page)).toHaveAttribute('data-link-state', 'up');

    await unplugEverything(page);
    // Il n'y a plus de câble : la ligne n'a plus lieu d'être dessinée.
    await expect(page.locator('[data-link-state]')).toHaveCount(0);
  });

  test('le port du switch désactivé passe la ligne à `down`, sans la retirer', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await expect(link(page)).toHaveAttribute('data-link-state', 'up');

    await shutdownSwitchPort(page, lab.swId, lab.swPort, false);

    // Le câble est toujours là — c'est bien ce qui distingue ce cas du
    // précédent, et ce que l'opérateur doit pouvoir voir.
    await expect(link(page)).toHaveAttribute('data-link-state', 'down');
    await expect(link(page)).toHaveAttribute('aria-label', /link down/);
  });

  test('le switch éteint passe la ligne à `down`', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await expect(link(page)).toHaveAttribute('data-link-state', 'up');

    await setPower(page, lab.swId, false);

    await expect(link(page)).toHaveAttribute('data-link-state', 'down');
  });

  test('la ligne redevient `up` quand l\'émetteur d\'en face se rallume', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await shutdownSwitchPort(page, lab.swId, lab.swPort, false);
    await expect(link(page)).toHaveAttribute('data-link-state', 'down');

    await shutdownSwitchPort(page, lab.swId, lab.swPort, true);
    await expect(link(page)).toHaveAttribute('data-link-state', 'up');
  });

  test('la remise sous tension du switch rétablit la ligne', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await setPower(page, lab.swId, false);
    await expect(link(page)).toHaveAttribute('data-link-state', 'down');

    await setPower(page, lab.swId, true);
    await expect(link(page)).toHaveAttribute('data-link-state', 'up');
  });
});

test.describe('panneau de propriétés — « câblé » n\'est pas « ça passe »', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForStore(page);
  });

  test('l\'interface d\'un lien sain est annoncée `Connected`', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await selectDevice(page, lab.pcId);
    await expect(page.getByTestId('iface-status-eth0')).toHaveText('Connected');
  });

  test('le port du pair désactivé fait dire `No carrier`, pas `Connected`', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await selectDevice(page, lab.pcId);
    await expect(page.getByTestId('iface-status-eth0')).toHaveText('Connected');

    await shutdownSwitchPort(page, lab.swId, lab.swPort, false);

    // Le câble n'a pas bougé ; c'est l'ancienne réponse « Connected »
    // qui était fausse.
    await expect(page.getByTestId('iface-status-eth0')).toHaveText('No carrier');
  });

  test('le pair éteint fait dire `No carrier`', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await selectDevice(page, lab.pcId);
    await setPower(page, lab.swId, false);
    await expect(page.getByTestId('iface-status-eth0')).toHaveText('No carrier');
  });

  test('une interface descendue localement est annoncée `Admin down`', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await selectDevice(page, lab.pcId);
    await page.evaluate(async ({ pcId }) => {
      type StoreState = { deviceInstances: Map<string, Record<string, unknown>> };
      const store = (window as Record<string, unknown>).__networkStore as { getState(): StoreState };
      const pc = store.getState().deviceInstances.get(pcId) as Record<string, unknown>;
      const exec = pc.executeCommand as (cmd: string) => Promise<string> | string;
      await Promise.resolve(exec.call(pc, 'sudo ip link set eth0 down'));
    }, { pcId: lab.pcId });

    // Deux pannes distinctes ne se disent pas de la même façon.
    await expect(page.getByTestId('iface-status-eth0')).toHaveText('Admin down');
  });

  test('le panneau revient à `Connected` après la reprise', async ({ page }) => {
    const lab = await setupPcOnSwitch(page);
    await selectDevice(page, lab.pcId);
    await setPower(page, lab.swId, false);
    await expect(page.getByTestId('iface-status-eth0')).toHaveText('No carrier');

    await setPower(page, lab.swId, true);
    await expect(page.getByTestId('iface-status-eth0')).toHaveText('Connected');
  });
});
