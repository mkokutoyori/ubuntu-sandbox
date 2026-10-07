/**
 * `openssl s_client` lit son entrée standard et l'envoie en données applicatives une fois la poignée
 * de main faite, puis affiche ce que le serveur répond (openssl 3.0 apps/s_client.c : la boucle
 * lit stdin et appelle SSL_write ; la réponse est écrite sur stdout, « DONE » sur stderr).
 *
 * MESURÉ avant correctif : la commande n'envoyait rien, la sortie s'arrêtait au rapport de session
 * et le serveur ne voyait aucune requête. Avant correctif (stash de src/network) 2 cas sur 3 tombent ;
 * le témoin sans stdin (rapport seul) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'TLS');
  srv.powerOn();
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand('openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/lab.key -out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=lab.local"');
  const site = 'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n'
    + '  ssl_certificate /etc/ssl/certs/lab.crt;\\n  ssl_certificate_key /etc/ssl/private/lab.key;\\n}\\n';
  await srv.executeCommand(`sh -c 'printf "${site}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl start nginx');
  return srv;
}

describe('s_client envoie stdin et affiche la réponse', () => {
  it('témoin : sans stdin, le rapport de session seul', async () => {
    const srv = await lab();
    const out = await srv.executeCommand('openssl s_client -connect 127.0.0.1:443 </dev/null');
    expect(out).toContain('CONNECTED');
    expect(out).toContain('Cipher is');
  });

  it('une requête GET passée en entrée obtient la page du serveur', async () => {
    const srv = await lab();
    const out = await srv.executeCommand(`printf 'GET / HTTP/1.0\\r\\n\\r\\n' | openssl s_client -connect 127.0.0.1:443`);
    expect(out).toContain('HTTP/1.1 200 OK');
    expect(out).toContain('nginx');
  });

  it('la réponse suit le rapport de session', async () => {
    const srv = await lab();
    const out = await srv.executeCommand(`printf 'GET / HTTP/1.0\\r\\n\\r\\n' | openssl s_client -connect 127.0.0.1:443`);
    expect(out.indexOf('HTTP/1.1 200 OK')).toBeGreaterThan(out.indexOf('Cipher is'));
  });
});
