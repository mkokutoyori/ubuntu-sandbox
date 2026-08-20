import { test } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 5 (e2e) — Heredoc bash pour préparer une configuration Cisco
 * depuis le terminal Linux de l'UI. Le terminal exécute un script réel
 * (construit ligne à ligne, protégé par quotes simples) dont le heredoc
 * quoté préserve !, #, $ ; le fichier généré est vérifié par cat.
 */

test.describe('Scénario 5 (e2e) — heredoc bash → configuration Cisco', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test("un heredoc quoté dans un script préserve !, # et $ du contenu Cisco", async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);

    // Construction du script (une ligne par echo, quotes simples).
    await typeCmd(page, "echo 'cat << \"CISCO\" > /tmp/cisco.txt' > /tmp/gen.sh");
    await typeCmd(page, "echo 'configure terminal' >> /tmp/gen.sh");
    await typeCmd(page, "echo '!' >> /tmp/gen.sh");
    await typeCmd(page, "echo 'banner motd #' >> /tmp/gen.sh");
    await typeCmd(page, "echo 'Attention! Acces restreint $1$' >> /tmp/gen.sh");
    await typeCmd(page, "echo '#' >> /tmp/gen.sh");
    await typeCmd(page, "echo 'end' >> /tmp/gen.sh");
    await typeCmd(page, "echo 'CISCO' >> /tmp/gen.sh");

    await typeCmd(page, 'bash /tmp/gen.sh', 500);
    await typeCmd(page, 'cat /tmp/cisco.txt', 500);

    await waitForText(page, 'configure terminal');
    await waitForText(page, 'banner motd #');
    await waitForText(page, 'Attention! Acces restreint $1$');
  });

  test('heredoc non quoté : les variables bash sont expandées dans la config générée', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);

    await typeCmd(page, "echo 'HOSTNAME_X=SW-MANDENG-01' > /tmp/gen2.sh");
    await typeCmd(page, "echo 'cat << EOF > /tmp/cisco2.txt' >> /tmp/gen2.sh");
    await typeCmd(page, "echo 'hostname $HOSTNAME_X' >> /tmp/gen2.sh");
    await typeCmd(page, "echo 'EOF' >> /tmp/gen2.sh");

    await typeCmd(page, 'bash /tmp/gen2.sh', 500);
    await typeCmd(page, 'cat /tmp/cisco2.txt', 500);
    await waitForText(page, 'hostname SW-MANDENG-01');
  });
});
