/**
 * Ce qu'un cable dit de lui-meme sur la toile, mesure dans le vrai DOM.
 *
 * LE DEFAUT QUI A OUVERT CE FICHIER, releve sur capture d'ecran : un
 * routeur, trois machines posees cote a cote dessous, chacune cablee au
 * routeur. Les trois cables quittaient le routeur par le MEME point de
 * sa carte et se superposaient sur toute la descente ; les trois
 * etiquettes de port tombaient au meme pixel, la derniere rendue
 * masquait les deux autres, et l'operateur lisait UN cable etiquete
 * `Gi0/2`. La toile ne se contentait pas d'etre chargee, elle mentait.
 *
 * Ce fichier verifie ce que la geometrie pure ne peut pas attester : que
 * le DOM rendu porte bien DEUX etiquettes par cable -- une par
 * interface --, qu'elles sont toutes VISIBLES, qu'aucune n'en recouvre
 * une autre, et que chacune nomme le port qu'elle touche. Les captures
 * deposees dans `__shots__` servent a la relecture humaine.
 *
 * Le labo est seme par le store, comme les autres specs de la toile ;
 * ce qui est mesure ici est le rendu, pas le geste de cablage, que
 * `canvas-cable-save-flow.spec.ts` couvre deja.
 *
 * Les pastilles vivent dans une COUCHE SVG posee APRES les equipements :
 * un cable passe derriere une carte, jamais son etiquette. C'est pour
 * cela qu'elles s'ancrent sur `data-label-for` et non sur le groupe du
 * cable, qui reste dans la couche du dessous. L'equipement SELECTIONNE
 * repasse devant, parce que sa barre d'actions porte des commandes et
 * qu'une etiquette n'en porte pas.
 *
 * Le zoom se mesure ici et nulle part ailleurs : une pastille garde sa
 * taille A L'ECRAN, donc sa boite englobante ne bouge pas quand on
 * zoome, alors que l'ecart entre deux equipements, lui, suit le zoom.
 *
 * Le GLISSER aussi : la geometrie pure peut rejouer un deplacement pas
 * a pas, mais seul le vrai DOM dit ce que la souris produit reellement
 * -- la carte est deplacee par un transform pendant que le magasin, lui,
 * suit a son rythme.
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ deviceScaleFactor: 2 });

const SHOTS = 'e2e/__shots__';

interface SeededLab {
  routerId: string;
  connectionIds: string[];
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(6000);
}

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 20_000 },
  );
}

async function seedStar(page: Page): Promise<SeededLab> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __networkStore: { getState: () => Record<string, (...args: unknown[]) => unknown> };
    }).__networkStore;
    const state = () => store.getState();
    const router = state().addDevice('router-cisco', 340, 140) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    const machines = [220, 400, 580].map(x => state().addDevice('linux-pc', x, 440) as {
      id: string; interfaces: Array<{ id: string }>;
    });
    const connectionIds = machines.map((machine, index) => {
      const link = state().addConnection(
        router.id, router.interfaces[index].id,
        machine.id, machine.interfaces[0].id, 'ethernet',
      ) as { id: string };
      return link.id;
    });
    return { routerId: router.id, connectionIds };
  });
}

async function seedParallelPair(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __networkStore: { getState: () => Record<string, (...args: unknown[]) => unknown> };
    }).__networkStore;
    const state = () => store.getState();
    const router = state().addDevice('router-cisco', 200, 260) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    const target = state().addDevice('switch-cisco', 560, 260) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    return [0, 1].map(index => (state().addConnection(
      router.id, router.interfaces[index].id,
      target.id, target.interfaces[index].id, 'ethernet',
    ) as { id: string }).id);
  });
}

function labelsOf(page: Page, connectionId: string) {
  return page.locator(`g[data-label-for="${connectionId}"] g[data-port-label]`);
}

function labelOf(page: Page, connectionId: string, end: 0 | 1 = 0) {
  return labelsOf(page, connectionId).nth(end);
}

async function exitPointOf(page: Page, connectionId: string): Promise<string> {
  const d = await page
    .locator(`g[data-connection-id="${connectionId}"] path[stroke-linejoin]`)
    .first()
    .getAttribute('d');
  return d!.slice(0, d!.indexOf('L')).trim();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.setTimeout(60_000);

test('three machines side by side under one router each get their own port and their own label', async ({ page }) => {
  const { connectionIds } = await seedStar(page);
  expect(connectionIds).toHaveLength(3);

  const exits = await Promise.all(connectionIds.map(id => exitPointOf(page, id)));
  expect(new Set(exits).size).toBe(3);

  const boxes = [];
  for (const id of connectionIds) {
    const labels = labelsOf(page, id);
    await expect(labels).toHaveCount(2);
    for (const end of [0, 1] as const) {
      await expect(labelOf(page, id, end)).toBeVisible();
      boxes.push((await labelOf(page, id, end).boundingBox())!);
    }
  }

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart, `labels ${i} and ${j} overlap`).toBe(true);
    }
  }

  await settle(page);
  await page.screenshot({
    path: `${SHOTS}/30-cables-etoile.png`,
    clip: { x: 520, y: 150, width: 520, height: 400 },
  });
});

test('each end carries the name of its own interface', async ({ page }) => {
  const { connectionIds } = await seedStar(page);

  const pairs = await Promise.all(connectionIds.map(async id => [
    await labelOf(page, id, 0).textContent(),
    await labelOf(page, id, 1).textContent(),
  ]));

  expect(pairs).toHaveLength(3);
  expect(new Set(pairs.map(pair => pair[0])).size).toBe(3);
  for (const [atRouter, atMachine] of pairs) {
    expect(atRouter).toMatch(/^Gi0\/\d$/);
    expect(atMachine).toBe('eth0');
  }
});

test('two cables between the same pair stay apart at both ends and label each lane', async ({ page }) => {
  const connectionIds = await seedParallelPair(page);
  expect(connectionIds).toHaveLength(2);

  const exits = await Promise.all(connectionIds.map(id => exitPointOf(page, id)));
  expect(new Set(exits).size).toBe(2);

  const boxes = [];
  for (const id of connectionIds) {
    for (const end of [0, 1] as const) {
      boxes.push((await labelOf(page, id, end).boundingBox())!);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart, `labels ${i} and ${j} overlap`).toBe(true);
    }
  }

  await settle(page);
  await page.screenshot({
    path: `${SHOTS}/31-cables-faisceau.png`,
    clip: { x: 400, y: 230, width: 520, height: 200 },
  });
});

test('selecting a cable reveals its delete affordance beside its own label', async ({ page }) => {
  const { connectionIds } = await seedStar(page);
  const label = labelOf(page, connectionIds[1]);
  const before = (await label.boundingBox())!;

  await label.click();

  const cable = page.locator(`g[data-connection-id="${connectionIds[1]}"]`);
  await expect(cable).toHaveAttribute('aria-pressed', 'true');

  const after = (await label.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);

  await settle(page);
  await page.screenshot({
    path: `${SHOTS}/32-cable-selectionne.png`,
    clip: { x: 520, y: 150, width: 520, height: 400 },
  });
});

test('a label a device card overlaps is still the thing on top', async ({ page }) => {
  const connectionId = await page.evaluate(() => {
    const store = (window as unknown as {
      __networkStore: { getState: () => Record<string, (...args: unknown[]) => unknown> };
    }).__networkStore;
    const state = () => store.getState();
    const router = state().addDevice('router-cisco', 300, 220) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    const pc = state().addDevice('linux-pc', 300, 335) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    return (state().addConnection(
      router.id, router.interfaces[0].id,
      pc.id, pc.interfaces[0].id, 'ethernet',
    ) as { id: string }).id;
  });

  const label = labelOf(page, connectionId);
  await expect(label).toBeVisible();
  const box = (await label.boundingBox())!;

  const onTop = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit?.closest('[data-port-label]');
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  expect(onTop).toBe(true);

  await settle(page);
  await page.screenshot({
    path: `${SHOTS}/33-pastille-au-dessus.png`,
    clip: { x: 520, y: 180, width: 380, height: 300 },
  });
});

test('a label lies along its cable, never across it', async ({ page }) => {
  const ids = await page.evaluate(() => {
    const store = (window as unknown as {
      __networkStore: { getState: () => Record<string, (...args: unknown[]) => unknown> };
    }).__networkStore;
    const state = () => store.getState();
    const router = state().addDevice('router-cisco', 220, 250) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    const near = state().addDevice('linux-pc', 315, 250) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    const below = state().addDevice('linux-pc', 220, 420) as {
      id: string; interfaces: Array<{ id: string }>;
    };
    return {
      flat: (state().addConnection(
        router.id, router.interfaces[0].id,
        near.id, near.interfaces[0].id, 'ethernet') as { id: string }).id,
      upright: (state().addConnection(
        router.id, router.interfaces[1].id,
        below.id, below.interfaces[0].id, 'ethernet') as { id: string }).id,
    };
  });

  for (const end of [0, 1] as const) {
    const flat = (await labelOf(page, ids.flat, end).boundingBox())!;
    expect(flat.width).toBeGreaterThan(flat.height);
    const upright = (await labelOf(page, ids.upright, end).boundingBox())!;
    expect(upright.height).toBeGreaterThan(upright.width);
  }

  await settle(page);
  await page.screenshot({
    path: `${SHOTS}/34-pastille-dans-l-axe.png`,
    clip: { x: 520, y: 200, width: 420, height: 340 },
  });
});

test('a port label keeps its size on screen when the canvas is zoomed', async ({ page }) => {
  const { connectionIds } = await seedStar(page);
  const label = labelOf(page, connectionIds[0], 1);

  const sizeAt = async (zoom: number) => {
    await page.evaluate(z => (window as unknown as {
      __networkStore: { getState: () => { setZoom: (z: number) => void } };
    }).__networkStore.getState().setZoom(z), zoom);
    await page.waitForTimeout(250);
    const box = (await label.boundingBox())!;
    return { width: box.width, height: box.height };
  };

  const atOne = await sizeAt(1);
  const atTwo = await sizeAt(2);
  const atThreeQuarters = await sizeAt(0.75);

  expect(atTwo.width).toBeCloseTo(atOne.width, 0);
  expect(atTwo.height).toBeCloseTo(atOne.height, 0);
  expect(atThreeQuarters.width).toBeCloseTo(atOne.width, 0);

  await page.evaluate(() => (window as unknown as {
    __networkStore: { getState: () => { setZoom: (z: number) => void } };
  }).__networkStore.getState().setZoom(0.75));
  await settle(page);
  await page.screenshot({
    path: `${SHOTS}/35-pastilles-au-zoom.png`,
    clip: { x: 500, y: 180, width: 480, height: 330 },
  });
});

test('below the floor the canvas shows the shape and stays silent on port names', async ({ page }) => {
  const { connectionIds } = await seedStar(page);
  await expect(labelsOf(page, connectionIds[0])).toHaveCount(2);

  await page.evaluate(() => (window as unknown as {
    __networkStore: { getState: () => { setZoom: (z: number) => void } };
  }).__networkStore.getState().setZoom(0.5));

  await expect(labelsOf(page, connectionIds[0])).toHaveCount(0);
  await expect(page.locator(`g[data-connection-id="${connectionIds[0]}"]`)).toBeVisible();
});

test('a selected device keeps its action bar above the labels', async ({ page }) => {
  const { routerId, connectionIds } = await seedStar(page);
  await page.locator(`[data-device-id="${routerId}"]`).click();

  const remove = page.getByRole('button', { name: /^Delete / });
  await expect(remove).toBeVisible();
  const box = (await remove.boundingBox())!;

  const onTop = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return !hit?.closest('[data-port-label]');
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  expect(onTop).toBe(true);
  expect(connectionIds).toHaveLength(3);

  await settle(page);
  await page.screenshot({
    path: `${SHOTS}/36-barre-d-actions.png`,
    clip: { x: 520, y: 150, width: 520, height: 400 },
  });
});

test('a hand wobbling across the diagonal does not flip the cables', async ({ page }) => {
  const { routerId, connectionIds } = await seedStar(page);
  const card = page.locator(`[data-device-id="${routerId}"]`);
  const start = (await card.boundingBox())!;
  const centre = { x: start.x + start.width / 2, y: start.y + start.height / 2 };

  const snapshot = async () => {
    const boxes = [];
    for (const id of connectionIds) {
      for (const end of [0, 1] as const) {
        boxes.push((await labelOf(page, id, end).boundingBox())!);
      }
    }
    return boxes;
  };

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y + 57, { steps: 12 });

  let previous = await snapshot();
  let noisy = 0;
  for (let step = 0; step < 12; step++) {
    await page.mouse.move(centre.x, centre.y + 57 + (step % 2 === 0 ? 8 : 0));
    const now = await snapshot();
    const moved = now.some((box, i) =>
      Math.hypot(box.x - previous[i].x, box.y - previous[i].y) > 40);
    if (moved) noisy++;
    previous = now;
  }
  await page.mouse.up();

  expect(noisy).toBeLessThanOrEqual(1);
});
