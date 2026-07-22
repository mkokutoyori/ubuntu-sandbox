import { test } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, waitForText } from './helpers/ciscoBangLab';

/**
 * Scénario 8 (e2e) — Heredoc Linux pour les fichiers de configuration
 * système, depuis le terminal de l'UI : # préservés (pas des
 * commentaires bash), sudo tee pour un fichier protégé, crontab chargé
 * depuis un heredoc.
 */

test.describe('Scénario 8 (e2e) — heredoc Linux et fichiers système', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('un script heredoc + sudo tee écrit /etc/resolv.conf avec ses # de commentaire', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);

    await typeCmd(page, "echo 'cat << \"EOF\" | sudo tee /etc/resolv.conf > /dev/null' > /tmp/dns.sh");
    await typeCmd(page, "echo '# Généré automatiquement - NE PAS MODIFIER' >> /tmp/dns.sh");
    await typeCmd(page, "echo 'domain mandeng.lan' >> /tmp/dns.sh");
    await typeCmd(page, "echo 'nameserver 192.168.10.1' >> /tmp/dns.sh");
    await typeCmd(page, "echo 'EOF' >> /tmp/dns.sh");

    await typeCmd(page, 'bash /tmp/dns.sh', 500);
    await typeCmd(page, 'cat /etc/resolv.conf', 500);

    await waitForText(page, '# Généré automatiquement - NE PAS MODIFIER');
    await waitForText(page, 'domain mandeng.lan');
    await waitForText(page, 'nameserver 192.168.10.1');
  });

  test('crontab chargé par heredoc : les # et le ! de la commande sont préservés dans crontab -l', async ({ page }) => {
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);

    await typeCmd(page, "echo 'crontab - << \"CRON\"' > /tmp/cron.sh");
    await typeCmd(page, "echo '# Surveillance réseau' >> /tmp/cron.sh");
    await typeCmd(page, "echo '*/5 * * * * /usr/local/bin/monitor.sh >> /var/log/mon.log 2>&1' >> /tmp/cron.sh");
    await typeCmd(page, "echo 'CRON' >> /tmp/cron.sh");

    await typeCmd(page, 'bash /tmp/cron.sh', 500);
    await typeCmd(page, 'crontab -l', 500);

    await waitForText(page, '# Surveillance réseau');
    await waitForText(page, '*/5 * * * * /usr/local/bin/monitor.sh >> /var/log/mon.log 2>&1');
  });
});
