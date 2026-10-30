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

  test('iptables -L : owner, recent et MARK avec leurs libelles', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const id = await addDevice(page, 'linux-server', 300, 250);
    await openTerminal(page, id);

    await typeCmd(page, 'iptables -A INPUT -m owner --uid-owner 0 -j ACCEPT');
    await typeCmd(page, 'iptables -A INPUT -m recent --update --seconds 30 --hitcount 6 --name ssh -j DROP');
    await typeCmd(page, 'iptables -t mangle -A PREROUTING -j MARK --set-mark 5');
    await typeCmd(page, 'iptables -L INPUT');
    const listing = await lastLines(page, 6);
    expect(listing).toContain('owner UID match root');
    expect(listing).toContain('recent: UPDATE seconds: 30 hit_count: 6 name: ssh side: source mask: 255.255.255.255');
    await typeCmd(page, 'iptables -t mangle -L PREROUTING -n');
    expect(await lastLines(page, 4)).toContain('MARK set 0x5');
  });

  test('iptables : time, length, connlimit, dscp et tcpmss acceptes et listes', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const id = await addDevice(page, 'linux-server', 300, 250);
    await openTerminal(page, id);

    await typeCmd(page, 'iptables -A INPUT -m time --timestart 09:00 --timestop 17:00 --weekdays Mon,Tue -j DROP');
    await typeCmd(page, 'iptables -A INPUT -p tcp -m connlimit --connlimit-above 10 --connlimit-mask 24 -j DROP');
    await typeCmd(page, 'iptables -A INPUT -m length --length 100:200 -j DROP');
    await typeCmd(page, 'iptables -A INPUT -m dscp --dscp-class EF -j DROP');
    await typeCmd(page, 'iptables -A INPUT -p tcp -m tcpmss --mss 1400:1500 -j DROP');
    await typeCmd(page, 'iptables -L INPUT -n');
    const listing = await lastLines(page, 9);
    expect(listing).toContain('TIME from 09:00:00 to 17:00:00 on Mon,Tue UTC');
    expect(listing).toContain('#conn src/24 > 10');
    expect(listing).toContain('length 100:200');
    expect(listing).toContain('DSCP match 0x2e');
    expect(listing).toContain('tcpmss match 1400:1500');
    await typeCmd(page, 'iptables -m time --timestart 25:00 -A INPUT -j DROP');
    await typeCmd(page, 'iptables -A INPUT -m time --timestart 25:00 -j DROP');
    expect(await lastLines(page, 4)).toContain('invalid time "25:00" specified');
  });

  test('ipset et iptables -m set dans le terminal', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const id = await addDevice(page, 'linux-server', 300, 250);
    await openTerminal(page, id);

    await typeCmd(page, 'ipset create blocklist hash:ip timeout 300');
    await typeCmd(page, 'ipset add blocklist 203.0.113.7');
    await typeCmd(page, 'ipset test blocklist 203.0.113.7');
    expect(await lastLines(page, 3)).toContain('203.0.113.7 is in set blocklist.');
    await typeCmd(page, 'iptables -A INPUT -m set --match-set blocklist src -j DROP');
    await typeCmd(page, 'iptables -L INPUT -n');
    expect(await lastLines(page, 4)).toContain('match-set blocklist src');
    await typeCmd(page, 'ipset list blocklist');
    const listing = await lastLines(page, 12);
    expect(listing).toContain('Type: hash:ip');
    expect(listing).toContain('References: 1');
    expect(listing).toMatch(/203\.0\.113\.7 timeout (29\d|300)/);
    await typeCmd(page, 'ipset destroy blocklist');
    expect(await lastLines(page, 3)).toContain('Set cannot be destroyed: it is in use by a kernel component');
  });
});
