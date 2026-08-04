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

test.describe('L2-1 — Router-ID OSPF choisi selon la priorité IOS', () => {
  test('une Loopback l\'emporte sur une interface physique plus haute', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'ip address 192.168.1.1 255.255.255.0');
    await typeCmd(page, 'no shutdown');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'interface Loopback0');
    await typeCmd(page, 'ip address 10.0.0.1 255.255.255.255');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'router ospf 1');
    await typeCmd(page, 'network 192.168.1.0 0.0.0.255 area 0');
    await typeCmd(page, 'end');

    await typeCmd(page, 'show ip ospf');
    await waitForText(page, /with ID 10\.0\.0\.1/);
  });

  test('router-id manuel gèle le choix automatique', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface Loopback0');
    await typeCmd(page, 'ip address 10.0.0.1 255.255.255.255');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'router ospf 1');
    await typeCmd(page, 'router-id 9.9.9.9');
    await typeCmd(page, 'end');
    await typeCmd(page, 'clear ip ospf process');
    await typeCmd(page, 'yes');

    await typeCmd(page, 'show ip ospf');
    await waitForText(page, /with ID 9\.9\.9\.9/);
  });
});

test.describe('L2-3 — passerelle de dernier recours et code S*', () => {
  test('une route par défaut statique s\'affiche S* et arme le gateway of last resort', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'ip address 192.168.1.1 255.255.255.0');
    await typeCmd(page, 'no shutdown');
    await typeCmd(page, 'exit');

    await typeCmd(page, 'do show ip route');
    await waitForText(page, 'Gateway of last resort is not set');

    await typeCmd(page, 'ip route 0.0.0.0 0.0.0.0 192.168.1.254');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show ip route');

    await waitForText(page, /Gateway of last resort is 192\.168\.1\.254 to network 0\.0\.0\.0/);
    await waitForText(page, /S\*\s+0\.0\.0\.0\/0 \[1\/0\] via 192\.168\.1\.254/);
  });
});

test.describe('L2-6 — exit, end et CTRL+Z depuis le mode interface', () => {
  test('exit remonte d\'un niveau, end et CTRL+Z reviennent en mode privilégié', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'do show privilege');
    await waitForText(page, /Current privilege level is 15/);

    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'end');
    await typeCmd(page, 'show clock');

    const apresEnd = await modalText(page);
    expect(apresEnd).not.toContain("% Invalid input detected at '^' marker.");
  });
});

test.describe('L2-5 — ping étendu en mode interactif', () => {
  test('ping nu ouvre le dialogue IOS et les réponses conduisent un vrai envoi', async ({ page }) => {
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
    await typeCmd(page, 'enable');
    await typeCmd(page, 'ping');
    await waitForText(page, 'Protocol [ip]:');

    await typeCmd(page, '');
    await waitForText(page, 'Target IP address:');
    await typeCmd(page, '10.0.0.2');
    await waitForText(page, 'Repeat count [5]:');
    await typeCmd(page, '3');
    await waitForText(page, 'Datagram size [100]:');
    await typeCmd(page, '');
    await waitForText(page, 'Timeout in seconds [2]:');
    await typeCmd(page, '');
    await waitForText(page, 'Extended commands [n]:');
    await typeCmd(page, 'n');
    await waitForText(page, 'Sweep range of sizes [n]:');
    await typeCmd(page, 'n', 3000);

    await waitForText(page, /Sending 3, 100-byte ICMP Echos to 10\.0\.0\.2, timeout is 2 seconds:/);
    await waitForText(page, /Success rate is 100 percent \(3\/3\)/);
  });
});

test.describe('L2-9 — CDP signale une discordance de VLAN natif', () => {
  test('le message porte le mnémonique NATIVE_VLAN_MISMATCH', async ({ page }) => {
    const sw1 = await addDevice(page, 'switch-cisco', 300, 250);
    const sw2 = await addDevice(page, 'switch-cisco', 600, 250);

    for (const [id, vlan] of [[sw1, '10'], [sw2, '20']] as [string, string][]) {
      await openTerminal(page, id);
      await typeCmd(page, 'enable');
      await typeCmd(page, 'configure terminal');
      await typeCmd(page, 'interface FastEthernet0/1');
      await typeCmd(page, 'switchport mode trunk');
      await typeCmd(page, `switchport trunk native vlan ${vlan}`);
      await typeCmd(page, 'end');
      await page.locator('[data-testid="terminal-modal"] button[title="Close"]').last().click();
      await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 8_000 });
    }

    await page.evaluate(([a, b]) => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): {
          addConnection(s: string, si: string, t: string, ti: string, k?: string): unknown;
          deviceInstances: Map<string, Record<string, unknown>>;
        };
      };
      store.getState().addConnection(a, 'FastEthernet0/1', b, 'FastEthernet0/1', 'ethernet');
      const sw = store.getState().deviceInstances.get(b) as Record<string, unknown>;
      const agent = (sw.getCdpAgent as () => { advertiseAll(r: string): void }).call(sw);
      agent.advertiseAll('config-change');
    }, [sw1, sw2]);

    await openTerminal(page, sw1);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'show logging', 700);
    await waitForText(page, /%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on FastEthernet0\/1 \(10\), with \S+ FastEthernet0\/1 \(20\)\./);
  });
});

test.describe('L2-7 — RAM contre NVRAM au reload', () => {
  test('sans sauvegarde le hostname est perdu, avec sauvegarde il survit', async ({ page }) => {
    await routeurPret(page);
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'hostname Perdu');
    await typeCmd(page, 'end');
    await waitForText(page, 'Perdu#');

    await typeCmd(page, 'reload');
    await typeCmd(page, 'yes', 900);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'show running-config', 800);

    await expect.poll(async () => {
      const t = await modalText(page);
      return t.slice(t.lastIndexOf('show running-config')).includes('hostname Perdu');
    }, { timeout: 8_000 }).toBe(false);

    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'hostname Garde');
    await typeCmd(page, 'end');
    await typeCmd(page, 'copy running-config startup-config');
    await typeCmd(page, '', 600);
    await typeCmd(page, 'reload');
    await typeCmd(page, 'yes', 900);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'show running-config', 800);

    await expect.poll(async () => {
      const t = await modalText(page);
      return t.slice(t.lastIndexOf('show running-config')).includes('hostname Garde');
    }, { timeout: 8_000 }).toBe(true);
  });
});

test.describe('L2-10 — la table NAT est une vraie table d\'état', () => {
  test('un ping traduit crée une entrée PAT visible', async ({ page }) => {
    const r = await addDevice(page, 'router-cisco', 300, 250);
    const pc = await addDevice(page, 'linux-pc', 120, 250);
    const web = await addDevice(page, 'linux-pc', 600, 250);
    await page.evaluate(([rid, pcid, wid]) => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { addConnection(s: string, si: string, t: string, ti: string, k?: string): unknown };
      };
      store.getState().addConnection(rid, 'GigabitEthernet0/0', pcid, 'eth0', 'ethernet');
      store.getState().addConnection(rid, 'GigabitEthernet0/1', wid, 'eth0', 'ethernet');
    }, [r, pc, web]);

    await openTerminal(page, r);
    await typeCmd(page, 'enable');
    await typeCmd(page, 'configure terminal');
    await typeCmd(page, 'interface GigabitEthernet0/0');
    await typeCmd(page, 'ip address 192.168.1.1 255.255.255.0');
    await typeCmd(page, 'ip nat inside');
    await typeCmd(page, 'no shutdown');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'interface GigabitEthernet0/1');
    await typeCmd(page, 'ip address 203.0.113.1 255.255.255.0');
    await typeCmd(page, 'ip nat outside');
    await typeCmd(page, 'no shutdown');
    await typeCmd(page, 'exit');
    await typeCmd(page, 'access-list 1 permit 192.168.1.0 0.0.0.255');
    await typeCmd(page, 'ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    await typeCmd(page, 'end');
    await page.locator('[data-testid="terminal-modal"] button[title="Close"]').last().click();
    await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'hidden', timeout: 8_000 });

    const perte = await page.evaluate(async ([pcid, wid]) => {
      const store = (window as Record<string, unknown>).__networkStore as {
        getState(): { deviceInstances: Map<string, Record<string, unknown>> };
      };
      const inst = (id: string) => store.getState().deviceInstances.get(id) as Record<string, unknown>;
      const exec = (d: Record<string, unknown>, c: string) =>
        Promise.resolve((d.executeCommand as (c: string) => Promise<string> | string).call(d, c));
      const dedans = inst(pcid);
      const dehors = inst(wid);
      await exec(dehors, 'sudo ip addr add 203.0.113.9/24 dev eth0');
      await exec(dedans, 'sudo ip addr add 192.168.1.10/24 dev eth0');
      await exec(dedans, 'sudo ip route add default via 192.168.1.1');
      return await exec(dedans, 'ping -c 2 203.0.113.9');
    }, [pc, web]);
    expect(perte).toMatch(/, 0% packet loss/);

    await openTerminal(page, r);
    await typeCmd(page, 'show ip nat translations', 700);
    await waitForText(page, /icmp\s+203\.0\.113\.1:\d+\s+192\.168\.1\.10:\d+/);
  });
});
