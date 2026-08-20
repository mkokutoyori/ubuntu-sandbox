import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

async function routeurPret(page: import('@playwright/test').Page): Promise<string> {
  const id = await addDevice(page, 'router-cisco', 420, 260);
  await openTerminal(page, id);
  await typeCmd(page, 'enable');
  return id;
}

test.describe('Exigence 2 — undebug all / show debugging dans le terminal', () => {
  test('sans drapeau, puis avec, puis après undebug all', async ({ page }) => {
    await routeurPret(page);

    await typeCmd(page, 'show debugging');
    await waitForText(page, 'No debug flags are enabled');

    await typeCmd(page, 'debug ip ospf events');
    await typeCmd(page, 'show debugging');
    await waitForText(page, /OSPF events debugging is on/i);

    await typeCmd(page, 'undebug all');
    await waitForText(page, 'All possible debugging has been turned off');

    await typeCmd(page, 'show debugging');
    await waitForText(page, 'No debug flags are enabled');
  });
});

test.describe('Exigence 3 — horodatage IOS visible dans le terminal', () => {
  test('service timestamps log datetime msec préfixe les messages', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'service timestamps log datetime msec');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'ip address 10.0.0.1 255.255.255.0');
    await typeCmd(page, 'no shutdown');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show logging');

    await expect.poll(async () => /\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3}: %/.test(await modalText(page)),
      { timeout: 8_000 }).toBe(true);
  });
});

test.describe('Exigence 5/6 — symboles ICMP du ping', () => {
  test('. quand aucune route, ! quand la cible repond', async ({ page }) => {
    const r1 = await addDevice(page, 'router-cisco', 300, 250);
    const r2 = await addDevice(page, 'router-cisco', 600, 250);
    await page.evaluate(([a, b]) => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addConnection(s: string, si: string, t: string, ti: string, k?: string): unknown };
      };
      store.getState().addConnection(a, 'GigabitEthernet0/0', b, 'GigabitEthernet0/0', 'ethernet');
    }, [r1, r2]);

    for (const [id, ip] of [[r1, '10.0.0.1'], [r2, '10.0.0.2']] as [string, string][]) {
      await openTerminal(page, id);
      await typeCmd(page, 'enable');
      await typeCmd(page, 'configure terminal');
      await typeCmd(page, 'interface GigabitEthernet0/0');
      await typeCmd(page, `ip address ${ip} 255.255.255.0`);
      await typeCmd(page, 'no shutdown');
      await typeCmd(page, 'end');
      await page.locator('[data-testid="terminal-modal"] button[title="Close"]').last().click();
      await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 8_000 });
    }

    await openTerminal(page, r1);
    await typeCmd(page, 'ping 203.0.113.9', 1500);
    await waitForText(page, /\.{5}/);
    await waitForText(page, /Success rate is 0 percent/);

    await typeCmd(page, 'ping 10.0.0.2', 2500);
    await waitForText(page, /!!!!/);
    await waitForText(page, /Success rate is 100 percent \(5\/5\)/);
  });
});

test.describe('Exigence 9 — cascade L1 → L2 → L3 vue depuis le terminal', () => {
  test('shutdown de la parente fait tomber les sous-interfaces et retire leurs routes', async ({ page }) => {
    const r1 = await addDevice(page, 'router-cisco', 300, 250);
    const sw = await addDevice(page, 'switch-cisco', 600, 250);
    await page.evaluate(([a, b]) => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addConnection(s: string, si: string, t: string, ti: string, k?: string): unknown };
      };
      store.getState().addConnection(a, 'GigabitEthernet0/0', b, 'FastEthernet0/24', 'ethernet');
    }, [r1, sw]);

    await openTerminal(page, r1);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'no shutdown');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'interface GigabitEthernet0/0.10');
    await typeCmd(page, 'encapsulation dot1q 10');
    await typeCmd(page, 'ip address 192.168.10.1 255.255.255.0');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show ip interface brief');
    await waitForText(page, /GigabitEthernet0\/0\.10\s+192\.168\.10\.1\s+YES manual up\s+up/);
    await typeCmd(page, 'show ip route');
    await waitForText(page, '192.168.10.0/24');

    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'shutdown');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show ip interface brief');
    await expect.poll(async () => {
      const lignes = (await modalText(page)).split('\n');
      const sous = lignes.filter(l => l.startsWith('GigabitEthernet0/0.10')).at(-1) ?? '';
      return /down\s+down/.test(sous);
    }, { timeout: 8_000 }).toBe(true);

    await typeCmd(page, 'show ip route');
    await expect.poll(async () => {
      const t = await modalText(page);
      const dernier = t.slice(t.lastIndexOf('show ip route'));
      return dernier.includes('192.168.10.0/24');
    }, { timeout: 8_000 }).toBe(false);
  });
});

test.describe('Exigences 3.a/3.b — refus CLI et canonisation', () => {
  test('le curseur ^ précède le message et la commande n\'est pas réécrite', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'ens');

    const texte = await modalText(page);
    const bloc = texte.slice(texte.lastIndexOf('ens'));
    const lignes = bloc.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    const idxCurseur = lignes.findIndex(l => l.trim() === '^');
    const idxMessage = lignes.findIndex(l => l.includes("% Invalid input detected at '^' marker."));
    expect(idxCurseur).toBeGreaterThanOrEqual(0);
    expect(idxMessage).toBeGreaterThan(idxCurseur);
  });

  test('show running-config rend la forme canonique d\'une saisie abrégée', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'int gi 0/0');
    await typeCmd(page, 'ip addr 10.0.0.1 255.255.255.0');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'router ospf 1');
    await typeCmd(page, 'network 192.168.1.1 0.0.0.255 area 0');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show running-config', 800);

    await waitForText(page, 'interface GigabitEthernet0/0');
    await waitForText(page, 'ip address 10.0.0.1 255.255.255.0');
    await waitForText(page, 'network 192.168.1.0 0.0.0.255 area 0');
  });
});
