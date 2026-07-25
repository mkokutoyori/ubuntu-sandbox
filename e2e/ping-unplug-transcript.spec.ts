import { test, expect, type Page } from '@playwright/test';
import { buildSshLab, waitForStore, openTerminal, typeCommand, termText, type SshLab } from './helpers/sshLab';

/**
 * A cable pulled while a ping is running must keep the ping running and
 * keep saying what happened to every probe. A silent gap between the
 * last reply and the summary is the bug this pins down.
 */

/** Unplug the cable attached to a device, from the store. */
async function unplug(page: Page, deviceId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        connections: Array<{ id: string; sourceDeviceId: string; targetDeviceId: string }>;
        removeConnection(id: string): void;
      };
    };
    const state = store.getState();
    for (const c of state.connections) {
      if (c.sourceDeviceId === id || c.targetDeviceId === id) state.removeConnection(c.id);
    }
  }, deviceId);
}

test.describe('ping keeps reporting when a cable is pulled', () => {
  let lab: SshLab;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitForStore(page);
    lab = await buildSshLab(page);
  });

  test('linux: every lost probe is named, then a summary counts them', async ({ page }) => {
    await openTerminal(page, lab.linux1);
    await typeCommand(page, 'ping 10.0.0.2');
    await page.waitForTimeout(2_500);
    expect(await termText(page), 'replies first').toMatch(/bytes from 10\.0\.0\.2/);

    await unplug(page, lab.linux2);
    await page.waitForTimeout(4_000);

    const out = await termText(page);
    expect(
      out,
      'the pulled cable must produce visible per-probe lines, not silence',
    ).toMatch(/Request timeout for icmp_seq|Destination Host Unreachable/);

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(1_200);
    const final = await termText(page);
    expect(final).toMatch(/packets transmitted/);
    expect(final, 'the summary must show real loss').toMatch(/[1-9]\d*% packet loss/);
  });

  test('windows: ping -t reports Request timed out. and keeps going', async ({ page }) => {
    await openTerminal(page, lab.win1);
    await typeCommand(page, 'ping 10.0.0.2 -t');
    await page.waitForTimeout(2_500);
    expect(await termText(page)).toMatch(/Reply from 10\.0\.0\.2/);

    await unplug(page, lab.linux2);
    await page.waitForTimeout(4_000);

    expect(
      await termText(page),
      'a pulled cable must show timed-out probes, not a frozen terminal',
    ).toMatch(/Request timed out\.|Destination host unreachable/);

    await page.keyboard.press('Control+c');
    await page.waitForTimeout(1_200);
    expect(await termText(page)).toMatch(/Packets: Sent = \d+, Received = \d+, Lost = \d+/);
  });
});
