/**
 * Banc de mesure du serveur nginx simulé : débit, dérive, mémoire.
 *
 * Inactif par défaut (il durerait des dizaines de secondes dans une
 * passe ordinaire). Pour le jouer :
 *
 *   NGINX_PERF=1 PERF_OUT=/tmp/perf.txt node_modules/.bin/vitest run \
 *     src/__tests__/perf/nginx-load.perf.test.ts
 *
 * Il écrit son rapport sur la sortie standard, sous forme de lignes
 * `PERF <mesure> <valeur>`. Ce qu'il cherche :
 *  - le coût d'une requête selon son chemin (statique, gzip, mandataire,
 *    return, try_files, error_page) ;
 *  - la DÉRIVE : une requête coûte-t-elle plus cher au dix-millième tour
 *    qu'au premier (journal d'accès recopié, tables qui grossissent) ;
 *  - le coût du choix de location quand le fichier en compte beaucoup ;
 *  - la mémoire retenue après N requêtes, une fois le GC passé.
 */

import { appendFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { createRequest } from '@/network/http/semantics/types';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse } from '@/network/http/semantics/types';
import { demarrer, labo, type Labo } from '../unit/network-v2/_nginxProxyLab';

const enabled = process.env.NGINX_PERF === '1';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc') as () => void;

function heapMb(): number {
  collect();
  collect();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function report(name: string, value: string): void {
  const line = `PERF ${name} ${value}\n`;
  if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, line);
  else process.stdout.write(line);
}

const LONG = 600_000;

function fetchOnce(lab: Labo, path: string, headers: Record<string, string> = {}): number {
  const request = createRequest('GET', path);
  request.headers.set('Host', '10.0.0.1');
  for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
  const client = new Http1ClientSession(lab.back.getTcpStack(), '10.0.0.1', 80);
  const sent = client.send(request);
  client.close();
  return sent.ok && sent.response ? (sent.response.statusCode ?? 0) : 0;
}

function timeBatch(lab: Labo, count: number, path: string, headers: Record<string, string> = {}): number {
  const start = performance.now();
  for (let i = 0; i < count; i++) fetchOnce(lab, path, headers);
  return (performance.now() - start) / count;
}

async function front(lab: Labo, locations = ''): Promise<void> {
  new Http1ServerSession(lab.back.getTcpStack(), 9000, () => {
    const res = createResponse(200, 'OK');
    res.headers.set('Content-Type', 'text/plain');
    res.body = new TextEncoder().encode('amont');
    return res;
  }).start();
  await lab.front.executeCommand(`sh -c 'seq 1 300 | sed "s/.*/<p>ligne &<\\/p>/" > /var/www/html/gros.html'`);
  await lab.front.executeCommand(`sh -c 'printf "PAGE-404" > /var/www/html/404.html'`);
  await demarrer(lab, `server {
  listen 80 default_server;
  root /var/www/html;
  index index.nginx-debian.html;
  error_page 404 /404.html;
${locations}  location /ret { return 200 "ok"; }
  location /rw/ { rewrite ^/rw/(.*)$ /$1 last; }
  location /iff { if ($arg_x = 1) { return 403; } set $v 1; return 200 "ok"; }
  location /up/ { proxy_pass http://10.0.0.2:9000/; }
  location / { try_files $uri $uri/ =404; }
}
`);
}

describe.skipIf(!enabled)('nginx : charge, dérive et mémoire', () => {
  it('coût d\'une requête selon son chemin', async () => {
    const lab = labo();
    await front(lab);
    expect(fetchOnce(lab, '/gros.html')).toBe(200);
    const rows: Array<[string, string, Record<string, string>]> = [
      ['static', '/index.nginx-debian.html', {}],
      ['static-gzip', '/gros.html', { 'Accept-Encoding': 'gzip' }],
      ['static-plain-large', '/gros.html', {}],
      ['proxy', '/up/x', {}],
      ['return', '/ret', {}],
      ['rewrite-last', '/rw/index.nginx-debian.html', {}],
      ['if-set-return', '/iff?x=2', {}],
      ['range-206', '/gros.html', { Range: 'bytes=10-99' }],
      ['if-none-match-304', '/index.nginx-debian.html', { 'If-None-Match': '*' }],
      ['try_files-miss-404-error_page', '/absent', {}],
    ];
    for (const [name, path, headers] of rows) {
      timeBatch(lab, 20, path, headers);
      report(`ms_per_request.${name}`, timeBatch(lab, 200, path, headers).toFixed(3));
    }
  }, LONG);

  it('dérive : le tour 10 000 coûte-t-il plus que le tour 1 ?', async () => {
    const lab = labo();
    await front(lab);
    const samples: number[] = [];
    for (let round = 0; round < 10; round++) samples.push(timeBatch(lab, 300, '/index.nginx-debian.html'));
    report('drift.ms_per_request_by_round', samples.map((s) => s.toFixed(3)).join(' '));
    const logSize = Number((await lab.front.executeCommand('wc -c < /var/log/nginx/access.log')).trim());
    report('drift.access_log_bytes_after_3000', String(logSize));
    report('drift.ratio_last_over_first', (samples[samples.length - 1] / samples[0]).toFixed(2));
  }, LONG);

  it('choix de location : 1, 100, 1000 locations', async () => {
    for (const count of [1, 100, 1000]) {
      const lab = labo();
      const many = Array.from({ length: count }, (_, i) => `  location /zone${i}/ { return 200 "z${i}"; }\n`).join('');
      await front(lab, many);
      timeBatch(lab, 20, '/index.nginx-debian.html');
      report(`locations.${count}.ms_per_request`, timeBatch(lab, 200, '/index.nginx-debian.html').toFixed(3));
    }
  }, LONG);

  it('mémoire retenue après 2 000 requêtes', async () => {
    const lab = labo();
    await front(lab);
    timeBatch(lab, 200, '/index.nginx-debian.html');
    const before = heapMb();
    for (let round = 0; round < 10; round++) timeBatch(lab, 200, '/gros.html', { 'Accept-Encoding': 'gzip' });
    const after = heapMb();
    report('memory.heap_mb_before', before.toFixed(1));
    report('memory.heap_mb_after_2000_gzip', after.toFixed(1));
    report('memory.retained_kb_per_request', (((after - before) * 1024) / 2000).toFixed(2));
  }, LONG);

  it('rechargement de configuration avec 1000 locations', async () => {
    const lab = labo();
    const many = Array.from({ length: 1000 }, (_, i) => `  location /zone${i}/ { return 200 "z${i}"; }\n`).join('');
    await front(lab, many);
    const start = performance.now();
    for (let i = 0; i < 10; i++) await lab.front.executeCommand('systemctl reload nginx');
    report('reload.ms_with_1000_locations', ((performance.now() - start) / 10).toFixed(1));
  }, LONG);
});
