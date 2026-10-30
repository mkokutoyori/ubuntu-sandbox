/**
 * `curl --compressed` : curl 8.5.0 construit avec zlib.
 *
 * Source : src/tool_getparam.c (`--compressed` règle CURLOPT_ACCEPT_ENCODING
 * à "" quand libz est présent), lib/http.c (`Accept-Encoding: %s` posé sauf
 * si l'appelant a son propre en-tête `Accept-Encoding`), lib/content_encoding.c
 * (voir http-content-codings.test.ts pour les règles du décodeur).
 *
 * Mesuré avant le correctif : `--compressed` répondait
 * « the installed libcurl version doesn't support this » (curl sans libz),
 * alors que le nginx du simulateur compresse depuis docs/PRD-Nginx.md §9.11.
 * Un TP « activer gzip puis le constater avec curl --compressed -v » était
 * impossible : le client ne savait ni demander ni décoder.
 *
 * Ce que le client change, et ce qu'il ne change pas :
 *  - il ajoute `Accept-Encoding: deflate, gzip` (jamais `br` ni `zstd` :
 *    ces bibliothèques ne sont pas annoncées) ;
 *  - il décode le corps ; les en-têtes (`-D`, `-i`) restent ceux de la
 *    réponse, `Content-Encoding` compris ; `%{size_download}` compte les
 *    octets DÉCODÉS ;
 *  - un `-H 'Accept-Encoding: …'` de l'appelant l'emporte sur le sien, mais
 *    le décodage reste actif.
 *
 * Discrimination par `git stash` : voir la fin de l'en-tête dans le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { sh } from './_httpsLab';
import { up } from './_nginxLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const WELCOME = 'Welcome to nginx!';
const URL = 'http://localhost';

async function curl(srv: LinuxServer, args: string): Promise<string> {
  return sh(srv, `curl -s ${args}`);
}

describe('ce que curl annonce', () => {
  it('curl --version annonce libz et zlib', async () => {
    const srv = await up();
    const banner = await sh(srv, 'curl --version');
    expect(banner).toContain('zlib/1.3');
    expect(banner.split('\n').find((l) => l.startsWith('Features:'))).toBe('Features: IPv6 libz SSL');
  });

  it('--compressed pose Accept-Encoding: deflate, gzip', async () => {
    const srv = await up();
    const trace = await sh(srv, `curl -sv --compressed -o /dev/null ${URL}/ 2>&1`);
    expect(trace).toContain('> Accept-Encoding: deflate, gzip');
  });

  it('sans --compressed, aucun Accept-Encoding', async () => {
    const srv = await up();
    expect(await sh(srv, `curl -sv -o /dev/null ${URL}/ 2>&1`)).not.toContain('Accept-Encoding');
  });

  it('un -H Accept-Encoding de l\'appelant remplace celui de curl', async () => {
    const srv = await up();
    const trace = await sh(srv, `curl -sv --compressed -H 'Accept-Encoding: identity' -o /dev/null ${URL}/ 2>&1`);
    expect(trace).toContain('> Accept-Encoding: identity');
    expect(trace).not.toContain('Accept-Encoding: deflate, gzip');
  });

  it('--version reste cohérent avec les autres options : --http2 est toujours refusé', async () => {
    const srv = await up();
    expect(await sh(srv, `curl --http2 ${URL}/`)).toContain("the installed libcurl version doesn't support this");
  });
});

describe('contre le nginx du simulateur', () => {
  it('--compressed rend le corps DÉCODÉ', async () => {
    const srv = await up();
    expect(await curl(srv, `--compressed ${URL}/`)).toContain(WELCOME);
  });

  it('sans --compressed mais avec le même en-tête, le corps reste compressé', async () => {
    const srv = await up();
    await curl(srv, `-H 'Accept-Encoding: gzip' -o /tmp/raw ${URL}/`);
    expect(await sh(srv, 'cat /tmp/raw')).not.toContain(WELCOME);
  });

  it('--compressed -o écrit le corps décodé, identique au fichier servi', async () => {
    const srv = await up();
    await curl(srv, `--compressed -o /tmp/got ${URL}/big.html`);
    expect(await sh(srv, 'cat /tmp/got')).toBe(await sh(srv, 'cat /var/www/html/big.html'));
  });

  it('les en-têtes affichés restent ceux de la réponse : Content-Encoding: gzip', async () => {
    const srv = await up();
    await curl(srv, `--compressed -D /tmp/h -o /dev/null ${URL}/`);
    const head = await sh(srv, 'cat /tmp/h');
    expect(head).toContain('Content-Encoding: gzip');
    expect(head).toContain('Transfer-Encoding: chunked');
  });

  it('%{size_download} compte les octets décodés, pas ceux du fil', async () => {
    const srv = await up();
    const decoded = Number(await curl(srv, `--compressed -o /dev/null -w '%{size_download}' ${URL}/big.html`));
    const onWire = Number(await curl(srv, `-H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' ${URL}/big.html`));
    const original = Number(await sh(srv, 'wc -c < /var/www/html/big.html'));
    expect(decoded).toBe(original);
    expect(onWire).toBeLessThan(original);
  });

  it('un corps que le serveur ne compresse pas traverse (trop court, gzip off)', async () => {
    const srv = await up();
    expect(await curl(srv, `--compressed ${URL}/tiny.html`)).toBe('hi');
    EquipmentRegistry.getInstance().clear();
    const off = await up('  gzip off;\n');
    expect(await curl(off, `--compressed ${URL}/`)).toContain(WELCOME);
  });

  it('-I --compressed : HEAD ne porte pas de corps, donc rien à décoder', async () => {
    const srv = await up();
    const head = await curl(srv, `-I --compressed ${URL}/`);
    expect(head).toContain('200 OK');
  });

  it('-i --compressed : les en-têtes puis le corps décodé', async () => {
    const srv = await up();
    const out = await curl(srv, `-i --compressed ${URL}/`);
    expect(out).toContain('Content-Encoding: gzip');
    expect(out).toContain(WELCOME);
  });

  it('un fichier .gz servi avec Content-Encoding: x-gzip est décodé', async () => {
    const srv = await up('  location = /pre.gz { add_header Content-Encoding x-gzip; }\n');
    await curl(srv, `-H 'Accept-Encoding: gzip' -o /var/www/html/pre.gz ${URL}/big.html`);
    expect(await curl(srv, `--compressed ${URL}/pre.gz`)).toBe(await sh(srv, 'cat /var/www/html/big.html'));
  });
});

describe('les échecs sont ceux de curl (code 61)', () => {
  it('Content-Encoding: br → « Unrecognized content encoding type… »', async () => {
    const srv = await up('  location = /br { add_header Content-Encoding br; }\n');
    await sh(srv, 'cp /var/www/html/index.nginx-debian.html /var/www/html/br');
    const out = await sh(srv, `curl -sS --compressed ${URL}/br; echo EC=$?`);
    expect(out).toContain('curl: (61) Unrecognized content encoding type. libcurl understands deflate, gzip content encodings.');
    expect(out).toContain('EC=61');
  });

  it('le même fichier sans --compressed est livré tel quel', async () => {
    const srv = await up('  location = /br { add_header Content-Encoding br; }\n');
    await sh(srv, 'cp /var/www/html/index.nginx-debian.html /var/www/html/br');
    expect(await curl(srv, `${URL}/br`)).toContain(WELCOME);
  });

  it('un corps qui n\'est pas du gzip déclaré gzip → « Error while processing content unencoding »', async () => {
    const srv = await up('  location = /fake { add_header Content-Encoding gzip; }\n');
    await sh(srv, 'cp /var/www/html/index.nginx-debian.html /var/www/html/fake');
    const out = await sh(srv, `curl -sS --compressed ${URL}/fake; echo EC=$?`);
    expect(out).toContain('curl: (61) Error while processing content unencoding: ');
    expect(out).toContain('EC=61');
  });

  it('Content-Encoding: identity traverse', async () => {
    const srv = await up('  location = /id { add_header Content-Encoding identity; }\n');
    await sh(srv, 'cp /var/www/html/index.nginx-debian.html /var/www/html/id');
    expect(await curl(srv, `--compressed ${URL}/id`)).toContain(WELCOME);
  });
});
