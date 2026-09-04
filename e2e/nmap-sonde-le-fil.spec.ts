import { test, expect, type Page } from '@playwright/test';

/**
 * `nmap` dans le vrai terminal du navigateur, et `tcpdump` comme temoin.
 *
 * Le pendant e2e de `probe-nmap-traverse-la-pile.test.ts` et de
 * `nmap-un-seul-moteur-deux-plateformes.test.ts`. Ce qui est verifie ICI
 * et nulle part ailleurs : que l'operateur tape lui-meme le balayage,
 * qu'il ouvre une capture sur la CIBLE, et qu'il y retrouve les octets de
 * la salutation — donc que ce que `nmap` rapporte a bien traverse le fil
 * au lieu d'etre lu dans l'objet de la machine visee.
 */

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 },
  );
}

async function addDevice(page: Page, type: string, x: number, y: number): Promise<string> {
  return page.evaluate(({ t, px, py }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice(t, px, py).id;
  }, { t: type, px: x, py: y });
}

async function cable(page: Page, a: string, b: string): Promise<void> {
  await page.evaluate(({ from, to }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        addConnection(f: string, fi: string, t: string, ti: string): unknown;
        getDevices(): Array<{ id: string; interfaces: Array<{ name: string }> }>;
      };
    };
    const devices = store.getState().getDevices();
    const src = devices.find((d) => d.id === from)!;
    const dst = devices.find((d) => d.id === to)!;
    store.getState().addConnection(from, src.interfaces[0].name, to, dst.interfaces[0].name);
  }, { from: a, to: b });
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
  await input.waitFor({ state: 'attached', timeout: 15_000 });
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(350);
}

async function lastLines(page: Page, n = 14): Promise<string> {
  const text = await page.locator('[data-testid="terminal-modal"]').innerText();
  return text.split('\n').slice(-n).join('\n');
}

const CIBLE = '10.73.0.10';
const SCANNER = '10.73.0.20';

test.describe('nmap sonde le fil', () => {
  test('la version rapportee se retrouve dans la capture de la cible', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 250);
    const scannerId = await addDevice(page, 'linux-pc', 600, 250);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await typeCmd(page, 'sudo tcpdump -i eth0 -w /tmp/scan.pcap &');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, `nmap -Pn -sV -p 22 ${CIBLE}`);
    const rapport = await lastLines(page, 12);
    expect(rapport).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(rapport).toContain('OpenSSH');
    await closeTerminal(page);

    await openTerminal(page, cibleId);
    await typeCmd(page, 'sudo tcpdump -r /tmp/scan.pcap -A');
    const capture = await lastLines(page, 30);
    // Les octets de la salutation sont DANS la capture : le rapport ne
    // peut donc pas venir d'une lecture de l'objet de la cible.
    expect(capture).toContain('SSH-2.0-OpenSSH');
    expect(capture).toMatch(/Flags \[S\]/);
  });

  test('un port ferme est vu ferme, et la decouverte declare la cible vivante', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 300);
    const scannerId = await addDevice(page, 'linux-pc', 600, 300);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);

    await typeCmd(page, `nmap -sn ${CIBLE}`);
    expect(await lastLines(page, 8)).toContain('Host is up');

    await typeCmd(page, `nmap -Pn -p 8888 ${CIBLE}`);
    expect(await lastLines(page, 8)).toMatch(/8888\/tcp\s+closed/);

    // Personne ne porte cette adresse : aucune sonde ne revient, et la
    // decouverte attend son delai avant de conclure — d'ou l'attente ici.
    await typeCmd(page, 'nmap -sn 10.73.0.99');
    await page.waitForTimeout(2_500);
    expect(await lastLines(page, 6)).toContain('(0 hosts up)');
  });

  test('un voisin muet est trouve par ARP, et la capture le montre', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 400);
    const scannerId = await addDevice(page, 'linux-pc', 600, 400);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo iptables -A INPUT -p icmp -j DROP');
    await typeCmd(page, 'sudo iptables -A INPUT -p tcp -j DROP');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, 'sudo tcpdump -i eth0 -w /tmp/arp.pcap &');
    await typeCmd(page, `nmap -sn --reason ${CIBLE}`);

    const rapport = await lastLines(page, 10);
    expect(rapport).toContain('Host is up');
    expect(rapport).toContain('arp-response');
    expect(rapport).toContain('MAC Address:');

    await typeCmd(page, 'sudo tcpdump -r /tmp/arp.pcap -nn');
    const capture = await lastLines(page, 20);
    expect(capture).toContain(`ARP, Request who-has ${CIBLE} tell ${SCANNER}`);
    expect(capture).not.toContain('ICMP echo request');
  });

  test('nmap.exe existe aussi sur une machine Windows', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 350);
    const winId = await addDevice(page, 'windows-pc', 600, 350);
    await cable(page, cibleId, winId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await closeTerminal(page);

    await openTerminal(page, winId);
    await typeCmd(page, `netsh interface ip set address "Ethernet0" static ${SCANNER} 255.255.255.0`);
    await typeCmd(page, `nmap.exe -Pn -sV -p 22 ${CIBLE}`);
    const rapport = await lastLines(page, 12);
    expect(rapport).not.toContain('is not recognized');
    expect(rapport).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(rapport).toContain('OpenSSH');
  });
});
