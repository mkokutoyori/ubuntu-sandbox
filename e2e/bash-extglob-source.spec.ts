import { test } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, waitForText } from './helpers/ciscoBangLab';

test.describe('bash extglob in the terminal of the UI', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('an extglob set by a sourced file applies to the following lines of a script', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);

    await typeCmd(page, 'mkdir -p /tmp/d && cd /tmp/d && touch a b c');
    await typeCmd(page, "echo 'shopt -s extglob' > /tmp/lib.sh");
    await typeCmd(page, "echo 'source /tmp/lib.sh' > /tmp/t.sh");
    await typeCmd(page, "echo 'cd /tmp/d' >> /tmp/t.sh");
    await typeCmd(page, "echo 'echo +(a|b) !(a)' >> /tmp/t.sh");

    await typeCmd(page, 'bash /tmp/t.sh', 500);
    await waitForText(page, 'a b b c');
  });
});
