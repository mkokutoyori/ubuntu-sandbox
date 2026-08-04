/**
 * docs/PRD-Nginx.md §P3 (plusieurs sites, et la panne qui va avec) et §P4
 * (journaux).
 *
 * P3 tient à une idée : `sites-enabled/` est un répertoire réellement lu,
 * pas une liste en mémoire. `ln -s` et `rm` suffisent, aucune commande
 * dédiée — c'est ce qui rend le TP identique à celui d'une vraie machine.
 *
 * P4 en tient une autre : un serveur qui ne laisse pas de trace ne se
 * diagnostique pas. `tail -f /var/log/nginx/access.log` pendant qu'un autre
 * poste fait des requêtes est l'exercice d'observation le plus courant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';

const SRV_IP = '10.61.0.10';
const CLI_IP = '10.61.0.20';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function lab() {
  const server = new LinuxServer('linux-server', 'WEB');
  const client = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
  client.getPorts()[0].configureIP(new IPAddress(CLI_IP), mask);
  server.powerOn();
  client.powerOn();
  return { server, client };
}

/** Écrit un fichier de site, comme le ferait `vim`. */
function writeSite(server: LinuxServer, name: string, body: string): Promise<string> {
  return server.executeCommand(`sh -c 'printf "${body}" > /etc/nginx/sites-available/${name}'`);
}

describe('§P3 — plusieurs sites, routés par server_name', () => {
  async function twoSites() {
    const l = lab();
    await l.server.executeCommand('mkdir -p /srv/alpha /srv/bravo');
    await l.server.executeCommand(`sh -c 'echo "<h1>site alpha</h1>" > /srv/alpha/index.html'`);
    await l.server.executeCommand(`sh -c 'echo "<h1>site bravo</h1>" > /srv/bravo/index.html'`);
    await writeSite(l.server, 'alpha',
      'server {\\n  listen 80 default_server;\\n  server_name alpha.lab;\\n  root /srv/alpha;\\n  index index.html;\\n}\\n');
    await writeSite(l.server, 'bravo',
      'server {\\n  listen 80;\\n  server_name bravo.lab;\\n  root /srv/bravo;\\n  index index.html;\\n}\\n');
    await l.server.executeCommand('rm /etc/nginx/sites-enabled/default');
    await l.server.executeCommand('ln -s ../sites-available/alpha /etc/nginx/sites-enabled/alpha');
    await l.server.executeCommand('ln -s ../sites-available/bravo /etc/nginx/sites-enabled/bravo');
    await l.server.executeCommand('systemctl start nginx');
    return l;
  }

  it('l\'en-tête Host choisit le site', async () => {
    const { server, client } = await twoSites();
    const url = `http://${SRV_IP}/`;

    expect(await client.executeCommand(`curl -sS -H "Host: alpha.lab" ${url}`)).toContain('site alpha');
    expect(await client.executeCommand(`curl -sS -H "Host: bravo.lab" ${url}`)).toContain('site bravo');
    void server;
  });

  it('un Host inconnu tombe sur le default_server', async () => {
    const { client } = await twoSites();

    expect(await client.executeCommand(`curl -sS -H "Host: inconnu.lab" http://${SRV_IP}/`))
      .toContain('site alpha');
  });

  it('retirer le lien de sites-enabled retire le site, sans commande dédiée', async () => {
    const { server, client } = await twoSites();

    await server.executeCommand('rm /etc/nginx/sites-enabled/bravo');
    await server.executeCommand('systemctl reload nginx');

    // bravo.lab ne correspond plus à rien : c'est le default_server qui
    // répond, comme sur une vraie machine.
    const out = await client.executeCommand(`curl -sS -H "Host: bravo.lab" http://${SRV_IP}/`);
    expect(out).toContain('site alpha');
    expect(out).not.toContain('site bravo');
  });
});

describe('§P3 — les pannes que le TP cherche', () => {
  it('un port déjà pris : nginx refuse de démarrer avec l\'errno', async () => {
    const { server } = lab();
    // Quelqu'un d'autre tient déjà le 80.
    server.getTcpStack().listen(80, { onAccept: () => undefined });

    await server.executeCommand('systemctl start nginx');

    expect((await server.executeCommand('systemctl is-active nginx')).trim()).not.toBe('active');
    expect(await server.executeCommand('cat /var/log/nginx/error.log'))
      .toContain('bind() to 0.0.0.0:80 failed (98: Address already in use)');
  });

  it('un nginx.conf VIDE et un nginx.conf ABSENT sont deux pannes distinctes', async () => {
    const absent = lab().server;
    await absent.executeCommand('rm /etc/nginx/nginx.conf');
    expect(await absent.executeCommand('nginx -t'))
      .toContain('open() "/etc/nginx/nginx.conf" failed (2: No such file or directory)');

    EquipmentRegistry.getInstance().clear();
    const vide = lab().server;
    await vide.executeCommand(`sh -c 'printf "" > /etc/nginx/nginx.conf'`);

    // Syntaxiquement correct, et pourtant refusé : sans section `events`,
    // le démon n'a pas de modèle de connexions.
    const out = await vide.executeCommand('nginx -t');
    expect(out).toContain('no "events" section in configuration');
    expect(out).not.toContain('No such file or directory');
  });

  it('le refus de démarrage est tracé dans error.log, pas seulement à l\'écran', async () => {
    const { server } = lab();
    await server.executeCommand('rm /etc/nginx/nginx.conf');

    await server.executeCommand('systemctl start nginx');

    expect(await server.executeCommand('cat /var/log/nginx/error.log'))
      .toContain('open() "/etc/nginx/nginx.conf" failed');
  });
});

describe('§P4 — les journaux', () => {
  async function serving() {
    const l = lab();
    await l.server.executeCommand('systemctl start nginx');
    return l;
  }

  it('chaque requête servie laisse une ligne au format combined', async () => {
    const { server, client } = await serving();

    await client.executeCommand(`curl -sS http://${SRV_IP}/`);

    const access = await server.executeCommand('cat /var/log/nginx/access.log');
    expect(access).toMatch(/"GET \/ HTTP\/1\.1" 200 \d+/);
    expect(access).toContain('curl/8.5.0');
  });

  it('le journal distingue les requêtes, pas seulement leur nombre', async () => {
    const { server, client } = await serving();

    await client.executeCommand(`curl -sS http://${SRV_IP}/`);
    await client.executeCommand(`curl -sS http://${SRV_IP}/absent.html`);

    const access = await server.executeCommand('cat /var/log/nginx/access.log');
    expect(access).toMatch(/"GET \/ HTTP\/1\.1" 200/);
    expect(access).toMatch(/"GET \/absent\.html HTTP\/1\.1" 404/);
  });

  it('un 404 va aussi dans error.log, avec le chemin cherché', async () => {
    const { server, client } = await serving();

    await client.executeCommand(`curl -sS http://${SRV_IP}/introuvable.html`);

    const err = await server.executeCommand('cat /var/log/nginx/error.log');
    expect(err).toContain('/var/www/html/introuvable.html');
    expect(err).toContain('No such file or directory');
  });

  it('`access_log off;` fait vraiment taire le journal', async () => {
    const l = lab();
    await l.server.executeCommand(
      `sh -c 'printf "server {\\n  listen 80 default_server;\\n  server_name _;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n  access_log off;\\n}\\n" > /etc/nginx/sites-available/default'`,
    );
    await l.server.executeCommand('systemctl start nginx');

    await l.client.executeCommand(`curl -sS http://${SRV_IP}/`);

    expect(await l.server.executeCommand('cat /var/log/nginx/access.log')).not.toMatch(/"GET \//);
  });

  it('le journal survit à un `tail` pendant que les requêtes arrivent', async () => {
    const { server, client } = await serving();

    for (let i = 0; i < 3; i++) await client.executeCommand(`curl -sS http://${SRV_IP}/`);

    const tail = await server.executeCommand('tail -n 3 /var/log/nginx/access.log');
    expect(tail.split('\n').filter((l) => l.includes('GET /'))).toHaveLength(3);
  });
});
