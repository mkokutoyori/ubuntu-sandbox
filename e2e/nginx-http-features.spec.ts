import { test, expect } from '@playwright/test';
import {
  addDevice, cable, closeTerminal, lastLines, openTerminal, typeCmd, waitForStore, writeSite,
} from './helpers/terminalLab';

/**
 * docs/PRD-Nginx.md §9.11 à §9.15 dans le vrai terminal du navigateur.
 *
 * Équivalent e2e de `nginx-gzip.test.ts`, `curl-compressed.test.ts`,
 * `nginx-proxy-redirect.test.ts`, `nginx-return-mime.test.ts` et
 * `nginx-try-files-error-page.test.ts`. Ce qui se vérifie ici et nulle
 * part ailleurs : que l'opérateur tape lui-même ces lignes, à travers un
 * vrai câble, et lit ce que la machine lui répond — gzip demandé par un
 * client, redirection réécrite par un mandataire, page d'erreur choisie.
 */

const SRV = '10.72.0.10';
const CLI = '10.72.0.20';

test.describe('nginx : gzip, redirections et pages d\'erreur dans le terminal', () => {
  test('gzip on + curl --compressed à travers le câble', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const serverId = await addDevice(page, 'linux-server', 300, 250);
    const clientId = await addDevice(page, 'linux-server', 600, 250);
    await cable(page, serverId, clientId);

    await openTerminal(page, serverId);
    await typeCmd(page, `ip addr add ${SRV}/24 dev eth0`);
    await typeCmd(page, `sh -c 'seq 1 300 | sed "s/.*/<p>ligne &<\\/p>/" > /var/www/html/gros.html'`);
    await typeCmd(page, 'systemctl start nginx');
    await closeTerminal(page);

    await openTerminal(page, clientId);
    await typeCmd(page, `ip addr add ${CLI}/24 dev eth0`);

    await typeCmd(page, `curl -s -D /tmp/h -o /dev/null --compressed http://${SRV}/gros.html`);
    await typeCmd(page, 'cat /tmp/h');
    const headers = await lastLines(page, 12);
    expect(headers).toContain('Content-Encoding: gzip');
    expect(headers).toContain('Transfer-Encoding: chunked');

    await typeCmd(page, `curl -s --compressed http://${SRV}/gros.html | tail -n 1`);
    expect(await lastLines(page, 4)).toContain('<p>ligne 300</p>');

    await typeCmd(page, `curl -s -o /dev/null -w "wire=%{size_download}\\n" -H "Accept-Encoding: gzip" http://${SRV}/gros.html`);
    const wire = Number(/wire=(\d+)/.exec(await lastLines(page, 3))?.[1]);
    await typeCmd(page, `curl -s -o /dev/null -w "plain=%{size_download}\\n" --compressed http://${SRV}/gros.html`);
    const plain = Number(/plain=(\d+)/.exec(await lastLines(page, 3))?.[1]);
    expect(plain).toBeGreaterThan(0);
    expect(wire).toBeGreaterThan(0);
    expect(wire).toBeLessThan(plain / 2);
  });

  test('proxy_redirect réécrit le Location de l\'amont', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const serverId = await addDevice(page, 'linux-server', 300, 250);
    const clientId = await addDevice(page, 'linux-server', 600, 250);
    await cable(page, serverId, clientId);

    await openTerminal(page, serverId);
    await typeCmd(page, `ip addr add ${SRV}/24 dev eth0`);
    await writeSite(page,
      'server {\n  listen 8080;\n  location /r { return 302 http://127.0.0.1:8080/landing; }\n}\n'
      + 'server {\n  listen 80 default_server;\n  location / { proxy_pass http://127.0.0.1:8080; }\n}\n');
    await typeCmd(page, 'nginx -t');
    expect(await lastLines(page, 4)).toContain('test is successful');
    await typeCmd(page, 'systemctl start nginx');
    await closeTerminal(page);

    await openTerminal(page, clientId);
    await typeCmd(page, `ip addr add ${CLI}/24 dev eth0`);
    await typeCmd(page, `curl -s -D /tmp/h -o /dev/null http://${SRV}/r`);
    await typeCmd(page, 'cat /tmp/h');
    const headers = await lastLines(page, 12);
    expect(headers).toContain('302 Moved Temporarily');
    expect(headers).toContain(`Location: http://${SRV}/landing`);
    expect(headers).not.toContain('127.0.0.1:8080');
  });

  test('return, try_files et error_page, puis nginx -t refuse une faute', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    await openTerminal(page, await addDevice(page, 'linux-server', 400, 300));

    await typeCmd(page, `sh -c 'printf "PAGE-404-MAISON" > /var/www/html/404.html'`);
    await writeSite(page,
      'server {\n  listen 80 default_server;\n  root /var/www/html;\n  index index.nginx-debian.html;\n'
      + '  error_page 404 /404.html;\n  location /old { return 301 /nouveau; }\n'
      + '  location / { try_files $uri $uri/ =404; }\n}\n');
    await typeCmd(page, 'systemctl start nginx');

    await typeCmd(page, 'curl -s -i http://127.0.0.1/old');
    const redirect = await lastLines(page, 14);
    expect(redirect).toContain('301 Moved Permanently');
    expect(redirect).toContain('Location: http://127.0.0.1/nouveau');

    await typeCmd(page, 'curl -s -i http://127.0.0.1/absent');
    const missing = await lastLines(page, 14);
    expect(missing).toContain('404 Not Found');
    expect(missing).toContain('PAGE-404-MAISON');

    await typeCmd(page, 'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1/');
    expect(await lastLines(page, 3)).toContain('200');

    await writeSite(page, 'server {\n  listen 80;\n  gzip maybe;\n}\n');
    await typeCmd(page, 'nginx -t');
    const verdict = await lastLines(page, 6);
    expect(verdict).toContain('invalid value "maybe" in "gzip" directive');
    expect(verdict).toContain('test failed');
  });

  test('Last-Modified, ETag, 304 et Range d\'un fichier statique', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);

    const serverId = await addDevice(page, 'linux-server', 300, 250);
    const clientId = await addDevice(page, 'linux-server', 600, 250);
    await cable(page, serverId, clientId);

    await openTerminal(page, serverId);
    await typeCmd(page, `ip addr add ${SRV}/24 dev eth0`);
    await typeCmd(page, `sh -c 'printf "0123456789" > /var/www/html/digits.txt'`);
    await typeCmd(page, 'systemctl start nginx');
    await closeTerminal(page);

    await openTerminal(page, clientId);
    await typeCmd(page, `ip addr add ${CLI}/24 dev eth0`);

    await typeCmd(page, `curl -s -D /tmp/h -o /dev/null http://${SRV}/digits.txt`);
    await typeCmd(page, 'grep -i etag /tmp/h');
    const etag = /ETag: (".*?")/i.exec(await lastLines(page, 3))?.[1];
    expect(etag).toBeDefined();

    await typeCmd(page, `curl -s -i -H 'If-None-Match: ${etag}' http://${SRV}/digits.txt`);
    expect(await lastLines(page, 8)).toContain('HTTP/1.1 304 Not Modified');

    await typeCmd(page, `curl -s -i -H 'Range: bytes=2-5' http://${SRV}/digits.txt`);
    const partial = await lastLines(page, 10);
    expect(partial).toContain('HTTP/1.1 206 Partial Content');
    expect(partial).toContain('Content-Range: bytes 2-5/10');
    expect(partial).toContain('2345');

    await typeCmd(page, `curl -s -i -H 'Range: bytes=20-30' http://${SRV}/digits.txt`);
    expect(await lastLines(page, 20)).toContain('HTTP/1.1 416 Requested Range Not Satisfiable');
  });
});
