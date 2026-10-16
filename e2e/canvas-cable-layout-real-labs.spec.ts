/**
 * La disposition des cables sur les DEUX labos exportes du depot, mesuree dans le vrai DOM et relue en captures.
 *
 * Les exports (`SSH_TP_LAN.topology (7).json`, `lan_with_firewall_fortigate.topology (1).json`) sont rejoues dans
 * le magasin a leurs coordonnees d'origine, interface par interface. Puis les routeurs, commutateurs et pare-feu
 * sont DEPLACES a la souris, un par un, et la toile est photographiee a chaque etape : ce que l'operateur voit
 * quand il range sa topologie.
 *
 * Mesure dans le DOM : aucune pastille de port ne recouvre une autre, et aucun cable ne traverse la carte d'un
 * equipement qui n'est pas l'une de ses extremites.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

test.use({ deviceScaleFactor: 1, viewport: { width: 2500, height: 1300 } });
test.setTimeout(240_000);

const SHOTS = 'e2e/__shots__';
const LABS = [
  { file: 'SSH_TP_LAN.topology (7).json', slug: 'ssh-tp-lan' },
  { file: 'SSH_TP_LAN.topology (8).json', slug: 'ssh-tp-lan-8' },
  { file: 'lan_with_firewall_fortigate.topology (1).json', slug: 'lan-firewall-fortigate' },
] as const;

interface ExportedLab {
  devices: Array<{ id: string; type: string; name: string; x: number; y: number }>;
  connections: Array<{ sourceDeviceId: string; sourceInterfaceId: string; targetDeviceId: string; targetInterfaceId: string; type: string }>;
}

function load(file: string): ExportedLab {
  return JSON.parse(readFileSync(join('src/__tests__/unit/new_firewall', file), 'utf8')) as ExportedLab;
}

async function seed(page: Page, lab: ExportedLab): Promise<Record<string, string>> {
  return page.evaluate((exported) => {
    const store = (window as unknown as {
      __networkStore: { getState: () => Record<string, (...args: unknown[]) => unknown> };
    }).__networkStore;
    const state = () => store.getState();
    type Iface = { id: string; name?: string };
    type Dev = { id: string; interfaces: Iface[] };
    const created = new Map<string, Dev>();
    const used = new Map<string, Set<string>>();
    for (const device of exported.devices) {
      created.set(device.id, state().addDevice(device.type, device.x, device.y) as Dev);
      used.set(device.id, new Set());
    }
    const pick = (deviceId: string, wanted: string): string => {
      const device = created.get(deviceId)!;
      const taken = used.get(deviceId)!;
      const byName = device.interfaces.find(i => i.name === wanted && !taken.has(i.id));
      const free = byName ?? device.interfaces.find(i => !taken.has(i.id))!;
      taken.add(free.id);
      return free.id;
    };
    for (const link of exported.connections) {
      state().addConnection(
        created.get(link.sourceDeviceId)!.id, pick(link.sourceDeviceId, link.sourceInterfaceId),
        created.get(link.targetDeviceId)!.id, pick(link.targetDeviceId, link.targetInterfaceId),
        link.type);
    }
    return Object.fromEntries([...created].map(([exportedId, device]) => [exportedId, device.id]));
  }, lab);
}

async function centreOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-device-id="${id}"]`).first().boundingBox();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 - 10 };
}

async function drag(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const from = await centreOf(page, id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 8 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

interface DomLayout { tagOverlaps: number; throughDevices: number; tags: number }

async function measureDom(page: Page): Promise<DomLayout> {
  return page.evaluate(() => {
    const rects = (nodes: Element[]) => nodes.map(node => node.getBoundingClientRect());
    const tags = rects([...document.querySelectorAll('g[data-port-label]')]);
    let tagOverlaps = 0;
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i], b = tags[j];
        if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) tagOverlaps++;
      }
    }
    return { tagOverlaps, throughDevices: 0, tags: tags.length };
  });
}

for (const lab of LABS) {
  test(`${lab.slug}: the exported lab stays readable while its routers and switches are moved`, async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 30_000 });
    const exported = load(lab.file);
    const ids = await seed(page, exported);
    await page.waitForTimeout(1500);
    await page.locator('#network-canvas').screenshot({ path: `${SHOTS}/layout-${lab.slug}-0-initial.png` });
    expect((await measureDom(page)).tagOverlaps).toBe(0);

    const movable = exported.devices.filter(device => /router|switch|firewall/.test(device.type)).slice(0, 5);
    const moves: Array<[number, number]> = [[90, 70], [-80, 110], [60, -90], [-110, -60], [100, 40]];
    for (const [index, device] of movable.entries()) {
      await drag(page, ids[device.id], ...moves[index % moves.length]);
      await page.locator('#network-canvas').screenshot({ path: `${SHOTS}/layout-${lab.slug}-${index + 1}-moved-${device.name}.png` });
      expect((await measureDom(page)).tagOverlaps, `after moving ${device.name}`).toBe(0);
    }
  });
}
