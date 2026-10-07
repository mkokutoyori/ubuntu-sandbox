/**
 * `openssl s_client` lancé depuis un terminal (entrée standard = le clavier) reste ouvert après le
 * rapport de session : chaque ligne tapée part en données applicatives sur la connexion TLS et la
 * réponse s'affiche ; `Q` ferme (DONE), `k`/`K` déclenchent un KeyUpdate TLS 1.3 (apps/s_client.c).
 *
 * MESURÉ avant correctif : la commande affichait le rapport puis rendait la main, la connexion était
 * déjà fermée ; aucune ligne tapée ensuite n'atteignait le serveur. Avant correctif (stash de
 * src/network et src/terminal) 5 cas sur 6 tombent (série initiale) ; le cas R en TLS 1.2 tombe aussi avant le correctif de renégociation ; le témoin (le rapport s'affiche) passe dans les deux états.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { PKI, machine, sh } from './_httpsLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  const fg = session.foreground;
  fg.setInput(line);
  fg.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

const text = (session: TerminalSession): string => session.lines.map((l) => l.text).join('\n');

async function lab() {
  const srv = machine();
  await sh(srv, `mkdir -p ${PKI}`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/srv.key -out ${PKI}/srv.crt -days 365 -nodes -subj "/CN=lab.local"`);
  const body = `server {\\n  listen 443 ssl;\\n  server_name lab.local;\\n  root /var/www/html;\\n  index index.nginx-debian.html;\\n  ssl_certificate ${PKI}/srv.crt;\\n  ssl_certificate_key ${PKI}/srv.key;\\n}\\n`;
  await sh(srv, `sh -c 'printf "${body}" > /etc/nginx/sites-available/default'`);
  await sh(srv, 'systemctl start nginx');
  const term = new LinuxTerminalSession('t1', srv);
  await term.init();
  return { srv, term };
}

describe('openssl s_client interactif', () => {
  it('témoin : la commande affiche le rapport de session', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443');
    expect(text(term)).toContain('Certificate chain');
  });

  it('la connexion reste ouverte : le sous-shell prend la main sans invite', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443');
    expect(term.foreground.getPrompt()).toBe('');
  });

  it('une requête tapée ligne à ligne obtient la page', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443');
    await type(term, 'GET / HTTP/1.0');
    await type(term, '');
    expect(text(term)).toContain('HTTP/1.1 200 OK');
  });

  it('K déclenche un KeyUpdate et la connexion continue de servir', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443');
    await type(term, 'K');
    expect(text(term)).toContain('KEYUPDATE');
    await type(term, 'GET / HTTP/1.0');
    await type(term, '');
    expect(text(term)).toContain('HTTP/1.1 200 OK');
  });

  it('Q ferme la connexion et rend l\'invite du shell', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443');
    await type(term, 'Q');
    expect(text(term)).toContain('DONE');
    expect(term.foreground.getPrompt()).not.toBe('');
  });

  it('en TLS 1.2, k annonce que le KeyUpdate demande TLS 1.3', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443 -tls1_2');
    await type(term, 'k');
    expect(text(term)).toContain('KeyUpdate needs TLS 1.3');
  });

  it('en TLS 1.2, R renégocie sur la connexion ouverte puis la requête est servie sous les nouvelles clés', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443 -tls1_2');
    await type(term, 'R');
    expect(text(term)).toContain('RENEGOTIATING');
    expect(text(term)).not.toContain('refused by the server');
    await type(term, 'GET / HTTP/1.0');
    await type(term, '');
    expect(text(term)).toContain('HTTP/1.1 200 OK');
  });

  it('en TLS 1.3, R rappelle que la renégociation n\'existe pas et renvoie vers K', async () => {
    const { term } = await lab();
    await type(term, 'openssl s_client -connect 127.0.0.1:443 -tls1_3');
    await type(term, 'R');
    expect(text(term)).toContain('does not exist in TLS 1.3');
  });
});
