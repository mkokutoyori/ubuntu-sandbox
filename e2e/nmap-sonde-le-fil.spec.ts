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

/** Un cable entre deux interfaces NOMMEES — un routeur en a plusieurs. */
async function cableAt(
  page: Page, a: string, ai: number, b: string, bi: number,
): Promise<void> {
  await page.evaluate(({ from, fromIdx, to, toIdx }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): {
        addConnection(f: string, fi: string, t: string, ti: string): unknown;
        getDevices(): Array<{ id: string; interfaces: Array<{ name: string }> }>;
      };
    };
    const devices = store.getState().getDevices();
    const src = devices.find((d) => d.id === from)!;
    const dst = devices.find((d) => d.id === to)!;
    store.getState().addConnection(
      from, src.interfaces[fromIdx].name, to, dst.interfaces[toIdx].name);
  }, { from: a, fromIdx: ai, to: b, toIdx: bi });
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

/** Le mot de passe du compte par defaut d'un poste (`user`). */
const SUDO_PASSWORD = 'admin';

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input').last();
  await input.waitFor({ state: 'attached', timeout: 15_000 });
  await input.focus();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(350);

  // Sur un POSTE, le compte par defaut n'est pas root : `sudo` demande le
  // mot de passe et le champ de saisie devient un champ de mot de passe.
  // Un serveur, dont la session est root, ne demande rien — d'ou le test
  // plutot qu'une reponse systematique.
  const secret = page.locator('[data-testid="terminal-modal"] input[type="password"]');
  if (await secret.count() > 0) {
    await secret.last().fill(SUDO_PASSWORD);
    await secret.last().press('Enter');
    await page.waitForTimeout(350);
  }
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

  test('un hote vivant est NOMME, et `-n` l en empeche', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 450);
    const scannerId = await addDevice(page, 'linux-pc', 600, 450);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, `sudo sh -c 'echo "${CIBLE} cible.lab" >> /etc/hosts'`);

    await typeCmd(page, `nmap -sn ${CIBLE}`);
    expect(await lastLines(page, 8)).toContain(`Nmap scan report for cible.lab (${CIBLE})`);

    await typeCmd(page, `nmap -n -sn ${CIBLE}`);
    const sansDns = await lastLines(page, 8);
    expect(sansDns).toContain(`Nmap scan report for ${CIBLE}`);
    expect(sansDns).not.toContain('cible.lab');
  });

  test('`-v` nomme les phases du balayage', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 500);
    const scannerId = await addDevice(page, 'linux-pc', 600, 500);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, `nmap -v -p 22 ${CIBLE}`);

    const sortie = await lastLines(page, 16);
    expect(sortie).toContain('Initiating ARP Ping Scan');
    expect(sortie).toContain('Initiating Connect Scan');
    expect(sortie).toContain(`Scanning ${CIBLE} [1 port]`);
    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });

  test('une option inconnue est refusee au lieu d etre ignoree', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const scannerId = await addDevice(page, 'linux-pc', 600, 550);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);

    await typeCmd(page, `nmap --zorglub ${CIBLE}`);
    const inconnue = await lastLines(page, 6);
    expect(inconnue).toContain("nmap: unrecognized option '--zorglub'");
    expect(inconnue).not.toContain('Nmap scan report');

    await typeCmd(page, `nmap --max-rate 100 ${CIBLE}`);
    const nonImplantee = await lastLines(page, 6);
    expect(nonImplantee).toContain(
      'nmap: option --max-rate: is not implemented in this simulator');
    expect(nonImplantee).not.toContain('Nmap scan report for 100');
  });

  test('`--scanflags` compose le segment, la base decide la lecture', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 600);
    const scannerId = await addDevice(page, 'linux-pc', 600, 600);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);

    // Le meme segment que `-sF`, lu comme un `-sS` : le port ouvert
    // ressort `filtered` la ou `-sF` rendrait `open|filtered`.
    await typeCmd(page, `nmap -Pn --scanflags FIN -p 22 ${CIBLE}`);
    expect(await lastLines(page, 8)).toMatch(/22\/tcp\s+filtered/);

    await typeCmd(page, `nmap -Pn -sF -p 22 ${CIBLE}`);
    expect(await lastLines(page, 8)).toMatch(/22\/tcp\s+open\|filtered/);

    await typeCmd(page, `nmap -Pn --scanflags 300 -p 22 ${CIBLE}`);
    expect(await lastLines(page, 6)).toContain('--scanflags option must be a number');
  });

  test('`--traceroute` releve le chemin, et une cible du meme segment n a qu un saut', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 250, 450);
    const routeurId = await addDevice(page, 'router-cisco', 450, 450);
    const scannerId = await addDevice(page, 'linux-pc', 650, 450);
    const commutateurId = await addDevice(page, 'switch-cisco', 550, 550);
    const voisinId = await addDevice(page, 'linux-server', 650, 600);
    await cableAt(page, cibleId, 0, routeurId, 0);
    await cableAt(page, routeurId, 1, commutateurId, 0);
    await cableAt(page, scannerId, 0, commutateurId, 1);

    await openTerminal(page, routeurId);
    for (const c of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.73.1.1 255.255.255.0',
      'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.73.0.1 255.255.255.0',
      'no shutdown', 'end',
    ]) await typeCmd(page, c);
    await closeTerminal(page);

    await openTerminal(page, cibleId);
    await typeCmd(page, 'ip addr add 10.73.1.10/24 dev eth0');
    await typeCmd(page, 'ip route add default via 10.73.1.1');
    await typeCmd(page, 'sudo systemctl start ssh');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, 'ip route add default via 10.73.0.1');
    await typeCmd(page, 'nmap --traceroute -n -p 22 10.73.1.10');
    const trace = await lastLines(page, 16);
    expect(trace).not.toContain('not implemented');
    expect(trace).toContain('TRACEROUTE');
    expect(trace).toMatch(/1\s+\S+ ms\s+10\.73\.0\.1/);
    expect(trace).toMatch(/2\s+\S+ ms\s+10\.73\.1\.10/);
    await closeTerminal(page);

    // Une cible du MEME segment est a une distance connue de 1 : aucune
    // sonde n'est emise et l'en-tete ne nomme aucun protocole.
    await cableAt(page, voisinId, 0, commutateurId, 2);
    await openTerminal(page, voisinId);
    await typeCmd(page, 'ip addr add 10.73.0.30/24 dev eth0');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, 'nmap --traceroute -n -p 22 10.73.0.30');
    const direct = await lastLines(page, 14);
    expect(direct).toContain('TRACEROUTE');
    expect(direct).not.toContain('using proto');
    expect(direct).toMatch(/1\s+\S+ ms\s+10\.73\.0\.30/);
  });

  test('`--packet-trace` montre les paquets, et un balayage connecte ses appels', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 500);
    const scannerId = await addDevice(page, 'linux-pc', 600, 500);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);

    await typeCmd(page, `nmap -Pn -sS --packet-trace -p 22 ${CIBLE}`);
    const demiOuvert = await lastLines(page, 20);
    expect(demiOuvert).not.toContain('not implemented');
    expect(demiOuvert).toMatch(
      new RegExp(`SENT \\(\\d+\\.\\d{4}s\\) TCP \\[${SCANNER}:\\d+ > ${CIBLE}:22 S seq=`));
    expect(demiOuvert).toMatch(/IP \[ttl=\d+ id=\d+ iplen=\d+ \]/);

    await typeCmd(page, `nmap -Pn -sT --packet-trace -p 22 ${CIBLE}`);
    const connecte = await lastLines(page, 20);
    expect(connecte).toContain(`CONN`);
    expect(connecte).toMatch(
      new RegExp(`TCP localhost > ${CIBLE}:22 => Connected`));
  });

  test('`-oA` ecrit les TROIS fichiers, et le XML se relit', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 550);
    const scannerId = await addDevice(page, 'linux-pc', 600, 550);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);

    await typeCmd(page, `nmap -Pn -oA balayage -p 22 ${CIBLE}`);
    await typeCmd(page, 'ls');
    const liste = await lastLines(page, 6);
    expect(liste).toContain('balayage.nmap');
    expect(liste).toContain('balayage.gnmap');
    expect(liste).toContain('balayage.xml');

    await typeCmd(page, 'cat balayage.xml');
    const xml = await lastLines(page, 24);
    expect(xml).toContain('<!DOCTYPE nmaprun>');
    expect(xml).toContain('<scaninfo type="connect" protocol="tcp" numservices="1" services="22"/>');
    expect(xml).toContain(`<address addr="${CIBLE}" addrtype="ipv4"/>`);
    expect(xml).toContain('<state state="open" reason="syn-ack"');
    expect(xml).toContain('</nmaprun>');
  });

  test('`--badsum` fait jeter la sonde par la pile, `-g` choisit son port source', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 400);
    const scannerId = await addDevice(page, 'linux-pc', 600, 400);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);

    await typeCmd(page, `nmap -Pn -sS -p 22 ${CIBLE}`);
    const temoin = await lastLines(page, 8);
    expect(temoin).toMatch(/22\/tcp\s+open\s+ssh/);

    await typeCmd(page, `nmap -Pn -sS --badsum -p 22 ${CIBLE}`);
    const corrompu = await lastLines(page, 8);
    expect(corrompu).not.toContain('not implemented');
    expect(corrompu).toMatch(/22\/tcp\s+filtered\s+ssh/);

    await typeCmd(page, `nmap -Pn -sS -g 53 --packet-trace -p 22 ${CIBLE}`);
    const source = await lastLines(page, 20);
    expect(source).toMatch(
      new RegExp(`SENT \\([^)]+\\) TCP \\[${SCANNER}:53 > ${CIBLE}:22 S seq=`));
    expect(source).toMatch(/22\/tcp\s+open\s+ssh/);

    await typeCmd(page, `nmap -Pn -sT --badsum -p 22 ${CIBLE}`);
    const connecte = await lastLines(page, 10);
    expect(connecte).toContain(
      'You have specified some options that require raw socket access.');
    expect(connecte).toMatch(/22\/tcp\s+open\s+ssh/);
  });

  test('`-f` decoupe la sonde, et la cible la recolle', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 470);
    const scannerId = await addDevice(page, 'linux-pc', 600, 470);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await typeCmd(page, 'tcpdump -nn -i eth0 -w frag.pcap &');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, `nmap -Pn -sS -f -p 22 ${CIBLE}`);
    const rapport = await lastLines(page, 8);
    expect(rapport).not.toContain('not implemented');
    expect(rapport).toMatch(/22\/tcp\s+open\s+ssh/);
    await closeTerminal(page);

    await openTerminal(page, cibleId);
    await typeCmd(page, 'tcpdump -r frag.pcap -nn -v');
    const capture = await lastLines(page, 24);
    expect(capture).toContain('offset 0, flags [+]');
    expect(capture).toContain('offset 8, flags [+]');
    expect(capture).toContain(`${SCANNER} > ${CIBLE}: ip-proto-6`);
  });

  test('`-D` seme de vraies trames, `-S` forge la seule qui parte', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 470);
    const scannerId = await addDevice(page, 'linux-pc', 600, 470);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await typeCmd(page, 'tcpdump -nn -i eth0 -w leurres.pcap &');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, `nmap -Pn -sS -D 10.0.0.31,ME,10.0.0.32 -p 22 ${CIBLE}`);
    const rapport = await lastLines(page, 8);
    expect(rapport).not.toContain('not implemented');
    expect(rapport).toMatch(/22\/tcp\s+open\s+ssh/);

    await typeCmd(page, `nmap -Pn -sS -S 10.73.0.99 -p 22 ${CIBLE}`);
    const usurpe = await lastLines(page, 8);
    expect(usurpe).toMatch(/22\/tcp\s+filtered\s+ssh/);
    await closeTerminal(page);

    await openTerminal(page, cibleId);
    await typeCmd(page, 'tcpdump -r leurres.pcap -nn');
    const capture = await lastLines(page, 30);
    expect(capture).toContain(`IP 10.0.0.31.`);
    expect(capture).toContain(`IP 10.0.0.32.`);
    expect(capture).toContain(`IP ${SCANNER}.`);
    expect(capture).toContain('IP 10.73.0.99.');
    expect(capture).toContain('ARP, Request who-has 10.73.0.99');
  });

  test('une cible se decrit : plage, fichier et exclusion', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 470);
    const scannerId = await addDevice(page, 'linux-pc', 600, 470);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);

    await typeCmd(page, 'nmap -sn 10.73.0.9-11');
    const plage = await lastLines(page, 8);
    expect(plage).not.toContain('Failed to resolve');
    expect(plage).toContain(`Nmap scan report for ${CIBLE}`);
    expect(plage).toContain('Nmap done: 3 IP addresses');

    await typeCmd(page, `echo "${CIBLE} 10.73.0.11" > cibles.txt`);
    await typeCmd(page, 'nmap -sn -iL cibles.txt');
    const fichier = await lastLines(page, 8);
    expect(fichier).not.toContain('not implemented');
    expect(fichier).toContain('Nmap done: 2 IP addresses');

    await typeCmd(page, `nmap -sn --exclude ${CIBLE} 10.73.0.9-11`);
    const exclu = await lastLines(page, 4);
    expect(exclu).toContain('Nmap done: 2 IP addresses (0 hosts up)');
    expect(exclu).not.toContain(`Nmap scan report for ${CIBLE}`);
  });

  test('la sonde porte une charge, et la charge est sur le fil', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const cibleId = await addDevice(page, 'linux-server', 300, 470);
    const scannerId = await addDevice(page, 'linux-pc', 600, 470);
    await cable(page, cibleId, scannerId);

    await openTerminal(page, cibleId);
    await typeCmd(page, `ip addr add ${CIBLE}/24 dev eth0`);
    await typeCmd(page, 'sudo systemctl start ssh');
    await typeCmd(page, 'tcpdump -nn -i eth0 tcp port 22 -w charge.pcap &');
    await closeTerminal(page);

    await openTerminal(page, scannerId);
    await typeCmd(page, `ip addr add ${SCANNER}/24 dev eth0`);
    await typeCmd(page, `nmap -Pn -sS --data-string SALUTLABO -p 22 ${CIBLE}`);
    const rapport = await lastLines(page, 8);
    expect(rapport).not.toContain('not implemented');
    expect(rapport).toMatch(/22\/tcp\s+open\s+ssh/);
    await closeTerminal(page);

    await openTerminal(page, cibleId);
    await typeCmd(page, 'tcpdump -r charge.pcap -nn -A');
    const capture = await lastLines(page, 20);
    expect(capture).toContain('SALUTLABO');
    expect(capture).toMatch(
      new RegExp(`${SCANNER}\\.\\d+ > ${CIBLE}\\.22: Flags \\[S\\].*length 9`));
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
