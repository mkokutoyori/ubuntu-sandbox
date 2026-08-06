/**
 * docs/PRD-Nginx.md §P0 (supprimer la contradiction), §P1 (nginx sert
 * vraiment un fichier), §P2 (la configuration est la source de vérité).
 *
 * Le défaut que §P0 ferme n'était pas une absence, c'était une
 * contradiction : `ServicePortProjection` inscrivait les ports déclarés
 * par `SERVICE_LISTENERS` dans la `SocketTable` — la table que lisent `ss`
 * et `netstat` — sans jamais appeler `TcpStack.listen()`, la seule chose
 * qui décide d'accepter une connexion. `systemctl start nginx` faisait
 * donc apparaître `0.0.0.0:80` pendant que `curl http://localhost/`
 * répondait `Connection refused`.
 *
 * Une absence enseigne « ce n'est pas simulé ». Une contradiction enseigne
 * une règle fausse : l'apprenant vérifie le service, le processus et le
 * port, obtient trois « oui », et conclut que le problème est ailleurs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';

const SRV_IP = '10.60.0.10';
const CLI_IP = '10.60.0.20';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function lab() {
  const server = new LinuxServer('linux-server', 'WEB');
  const client = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const uplink = new Cable('uplink');
  uplink.connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
  client.getPorts()[0].configureIP(new IPAddress(CLI_IP), mask);
  server.powerOn();
  client.powerOn();
  return { server, client, uplink };
}

describe('§P0 — `ss` et une connexion réelle ne peuvent plus se contredire', () => {
  it('nginx arrêté : aucun port affiché, et la connexion est refusée', async () => {
    const { server, client } = lab();

    expect(await server.executeCommand('ss -ltn')).not.toContain(':80');
    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`))
      .toContain('curl: (7)');
  });

  it('nginx démarré : le port est affiché ET la connexion aboutit', async () => {
    const { server, client } = lab();

    await server.executeCommand('systemctl start nginx');

    expect(await server.executeCommand('ss -ltn')).toContain(':80');
    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`))
      .toContain('Welcome to nginx!');
  });

  it('nginx arrêté à nouveau : les deux repartent ensemble', async () => {
    const { server, client } = lab();
    await server.executeCommand('systemctl start nginx');
    await server.executeCommand('systemctl stop nginx');

    expect(await server.executeCommand('ss -ltn')).not.toContain(':80');
    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`))
      .toContain('curl: (7)');
  });

  it('un service sans serveur n\'affiche plus un port qu\'il n\'ouvre pas', async () => {
    const { server } = lab();

    // L'exemple était apache2, et il ne l'est plus : depuis
    // docs/PRD-Manquements.md §M4a, apache2 OUVRE vraiment son port —
    // `apache2-really-listens.test.ts` le vérifie, conflit avec nginx
    // compris. La règle que ce cas protège est intacte et c'est mysql qui
    // l'illustre maintenant : un service qui démarre, a un PID et est
    // `active` sans qu'aucun serveur n'écoute pour lui ne doit afficher
    // aucun port.
    await server.executeCommand('systemctl start mysql');

    expect((await server.executeCommand('systemctl is-active mysql')).trim()).toBe('active');
    expect(await server.executeCommand('ss -ltn')).not.toContain(':3306');
  });
});

describe('§P1 — nginx sert vraiment le fichier de Debian', () => {
  it('les fichiers de la distribution sont là, et sites-enabled est un lien', async () => {
    const { server } = lab();

    expect(await server.executeCommand('cat /etc/nginx/nginx.conf'))
      .toContain('include /etc/nginx/sites-enabled/*;');
    expect(await server.executeCommand('cat /etc/nginx/sites-available/default'))
      .toContain('listen 80 default_server;');
    expect(await server.executeCommand('ls -l /etc/nginx/sites-enabled'))
      .toContain('->');
    expect(await server.executeCommand('cat /var/www/html/index.nginx-debian.html'))
      .toContain('Welcome to nginx!');
  });

  it('la réponse porte l\'en-tête Server de nginx et le bon type', async () => {
    const { server, client } = lab();
    await server.executeCommand('systemctl start nginx');

    const head = await client.executeCommand(`curl -sS -I http://${SRV_IP}/`);

    expect(head).toContain('HTTP/1.1 200 OK');
    expect(head).toContain('Server: nginx/1.24.0');
    expect(head).toContain('Content-Type: text/html');
  });

  it('un chemin absent donne le 404 de nginx', async () => {
    const { server, client } = lab();
    await server.executeCommand('systemctl start nginx');

    const out = await client.executeCommand(`curl -sS http://${SRV_IP}/absent.html`);

    expect(out).toContain('404 Not Found');
    expect(out).toContain('nginx/1.24.0');
  });

  it('le transfert traverse vraiment le câble intermédiaire', async () => {
    const { server, client, uplink } = lab();
    await server.executeCommand('systemctl start nginx');

    uplink.resetStats();
    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`))
      .toContain('Welcome to nginx!');

    expect(uplink.getStats().framesTransmitted).toBeGreaterThan(0);
  });
});

describe('§P2 — la configuration décide, et `nginx -t` la juge', () => {
  it('`nginx -t` accepte la configuration livrée', async () => {
    const { server } = lab();

    const out = await server.executeCommand('nginx -t');

    expect(out).toContain('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok');
    expect(out).toContain('nginx: configuration file /etc/nginx/nginx.conf test is successful');
    expect((await server.executeCommand('echo $?')).trim()).toBe('0');
  });

  it('une accolade en trop est refusée avec le fichier et la ligne', async () => {
    const { server } = lab();
    await server.executeCommand(
      `sh -c 'printf "server {\\n  listen 8080;\\n}\\n}\\n" > /etc/nginx/sites-available/default'`,
    );

    const out = await server.executeCommand('nginx -t');

    // Le chemin rapporté est celui que nginx a OUVERT — le lien de
    // sites-enabled, pas sa cible. C'est ce que fait le vrai nginx, et
    // c'est aussi le chemin que l'opérateur a mis dans son `include`.
    expect(out).toContain('nginx: [emerg] unexpected "}" in /etc/nginx/sites-enabled/default:4');
    expect(out).toContain('nginx: configuration file /etc/nginx/nginx.conf test failed');
    expect((await server.executeCommand('echo $?')).trim()).toBe('1');
  });

  it('une directive inexistante reçoit le message de nginx', async () => {
    const { server } = lab();
    await server.executeCommand(
      `sh -c 'printf "server {\\n  listen 80;\\n  zorglub on;\\n}\\n" > /etc/nginx/sites-available/default'`,
    );

    expect(await server.executeCommand('nginx -t'))
      .toContain('nginx: [emerg] unknown directive "zorglub" in /etc/nginx/sites-enabled/default:3');
  });

  it('une directive que nginx connaît et que ce simulateur n\'applique pas le dit', async () => {
    const { server } = lab();
    await server.executeCommand(
      `sh -c 'printf "server {\\n  listen 80;\\n  proxy_pass http://backend;\\n}\\n" > /etc/nginx/sites-available/default'`,
    );

    // `unknown directive` serait faux : nginx connaît parfaitement
    // proxy_pass. Le refus doit dire ce qui est vrai.
    const out = await server.executeCommand('nginx -t');
    expect(out).toContain('directive "proxy_pass" is not supported by this simulator');
    expect(out).not.toContain('unknown directive');
  });

  it('une configuration invalide fait ÉCHOUER le démarrage du service', async () => {
    const { server } = lab();
    await server.executeCommand(
      `sh -c 'printf "server {\\n  listen 80;\\n" > /etc/nginx/sites-available/default'`,
    );

    await server.executeCommand('systemctl start nginx');

    expect((await server.executeCommand('systemctl is-active nginx')).trim()).not.toBe('active');
    expect(await server.executeCommand('ss -ltn')).not.toContain(':80');
  });

  it('changer `root` dans le fichier change ce qui est servi, après reload', async () => {
    const { server, client } = lab();
    await server.executeCommand('systemctl start nginx');
    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`)).toContain('Welcome to nginx!');

    await server.executeCommand('mkdir -p /srv/site');
    await server.executeCommand(`sh -c 'echo "<h1>autre racine</h1>" > /srv/site/index.html'`);
    await server.executeCommand(
      `sh -c 'printf "server {\\n  listen 80 default_server;\\n  root /srv/site;\\n  index index.html;\\n  server_name _;\\n}\\n" > /etc/nginx/sites-available/default'`,
    );
    await server.executeCommand('systemctl reload nginx');

    const out = await client.executeCommand(`curl -sS http://${SRV_IP}/`);
    expect(out).toContain('autre racine');
    expect(out).not.toContain('Welcome to nginx!');
  });

  it('changer le port dans le fichier déplace vraiment l\'écoute', async () => {
    const { server, client } = lab();
    await server.executeCommand('systemctl start nginx');

    await server.executeCommand(
      `sh -c 'printf "server {\\n  listen 8888 default_server;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n  server_name _;\\n}\\n" > /etc/nginx/sites-available/default'`,
    );
    await server.executeCommand('systemctl reload nginx');

    expect(await client.executeCommand(`curl -sS http://${SRV_IP}:8888/`)).toContain('Welcome to nginx!');
    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`)).toContain('curl: (7)');
    const ss = await server.executeCommand('ss -ltn');
    expect(ss).toContain(':8888');
    expect(ss).not.toContain(':80 ');
  });

  it('`nginx -T` rend la configuration assemblée, includes résolus', async () => {
    const { server } = lab();

    const out = await server.executeCommand('nginx -T');

    expect(out).toContain('# configuration file /etc/nginx/nginx.conf:');
    expect(out).toContain('# configuration file /etc/nginx/sites-enabled/default:');
    expect(out).toContain('listen 80 default_server;');
  });

  it('`nginx -v` annonce la version', async () => {
    const { server } = lab();
    expect(await server.executeCommand('nginx -v')).toContain('nginx version: nginx/1.24.0');
  });
});

describe('§P3 — les pannes de nginx sont réelles', () => {
  it('`rm /etc/nginx/nginx.conf` empêche le démarrage, avec le message de nginx', async () => {
    const { server } = lab();
    await server.executeCommand('rm /etc/nginx/nginx.conf');

    const out = await server.executeCommand('nginx -t');

    expect(out).toContain('nginx: [emerg] open() "/etc/nginx/nginx.conf" failed (2: No such file or directory)');
    await server.executeCommand('systemctl start nginx');
    expect((await server.executeCommand('systemctl is-active nginx')).trim()).not.toBe('active');
  });

  it('retirer le lien de sites-enabled retire le site', async () => {
    const { server, client } = lab();
    await server.executeCommand('rm /etc/nginx/sites-enabled/default');
    await server.executeCommand('systemctl start nginx');

    // Plus aucun server block : rien à écouter, donc rien dans `ss`.
    expect(await server.executeCommand('ss -ltn')).not.toContain(':80');
    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`)).toContain('curl: (7)');
  });
});
