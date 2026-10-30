import { test, expect } from '@playwright/test';
import { addDevice, lastLines, openTerminal, typeCmd, waitForStore } from './helpers/terminalLab';

/**
 * `iptables -L` et `ufw status` dans le vrai terminal : colonnes alignées
 * comme iptables 1.8.7 et ufw 0.36.1 (voir les sondes
 * `probe-iptables-list-colonnes-alignees` et `probe-ufw-status-colonnes-alignees`).
 */

test.describe('pare-feu : listages alignés dans le terminal', () => {
  test('iptables -L et ufw status', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const id = await addDevice(page, 'linux-server', 300, 250);
    await openTerminal(page, id);

    await typeCmd(page, 'iptables -A INPUT -p tcp -s 10.0.0.0/24 -j DROP');
    await typeCmd(page, 'iptables -L INPUT');
    const plain = await lastLines(page, 6);
    expect(plain).toContain('target     prot opt source               destination');
    expect(plain).toMatch(/DROP +tcp +-- +10\.0\.0\.0\/24 +anywhere/);

    await typeCmd(page, 'iptables -L INPUT -vn');
    const verbose = await lastLines(page, 6);
    expect(verbose).toContain('pkts bytes target     prot opt in     out     source               destination');
    expect(verbose).toMatch(/DROP +tcp +-- +\* +\* +10\.0\.0\.0\/24 +0\.0\.0\.0\/0/);

    await typeCmd(page, 'ufw enable');
    await typeCmd(page, 'ufw allow in on eth0 to any port 22 proto tcp comment ssh');
    await typeCmd(page, 'ufw status');
    const status = await lastLines(page, 8);
    expect(status).toContain('To                         Action      From');
    expect(status).toContain('--                         ------      ----');
    expect(status).toMatch(/22\/tcp on eth0 +ALLOW +Anywhere +# ssh/);

    await typeCmd(page, 'ufw status numbered');
    expect(await lastLines(page, 8)).toMatch(/\[ 1\] 22\/tcp on eth0 +ALLOW IN +Anywhere/);
  });

  test('iptables -S, port source et journalisation ufw', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const id = await addDevice(page, 'linux-server', 300, 250);
    await openTerminal(page, id);

    await typeCmd(page, 'iptables -N WEB');
    await typeCmd(page, 'iptables -A INPUT ! -s 10.0.0.1 -p tcp --dport 80 -j WEB');
    await typeCmd(page, 'iptables -S');
    const saved = await lastLines(page, 8);
    expect(saved).toContain('-N WEB');
    expect(saved).toContain('-A INPUT ! -s 10.0.0.1/32 -p tcp -m tcp --dport 80 -j WEB');

    await typeCmd(page, 'ufw enable');
    await typeCmd(page, 'ufw allow log from 10.0.0.1 port 1024 to any port 22 proto tcp');
    await typeCmd(page, 'ufw status');
    expect(await lastLines(page, 8)).toMatch(/22\/tcp +ALLOW +10\.0\.0\.1 1024\/tcp +\(log\)/);

    await typeCmd(page, 'iptables -S ufw-user-logging-input');
    expect(await lastLines(page, 6)).toContain('-j LOG --log-prefix "[UFW ALLOW] "');
  });
});
