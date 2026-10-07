/**
 * `openssl s_server` sans -www, lancé depuis un terminal : il écoute et reste au premier plan comme le vrai (apps/s_server.c). Les
 * données d'un client s'impriment ligne à ligne au fur et à mesure qu'elles arrivent, la fermeture d'une connexion écrit
 * « shutting down SSL / CONNECTION CLOSED / ACCEPT » et l'écoute continue ; les lignes tapées partent vers le client connecté ;
 * Q quitte (DONE), q ferme la connexion, r/R renégocient (TLS ≤ 1.2), k/K lancent un KeyUpdate (TLS 1.3). Le s_client
 * interactif du simulateur affiche aussi ce que le serveur lui envoie sans qu'il l'ait demandé.
 *
 * MESURÉ avant correctif : sans -www la commande était refusée (« interactive mode reads application data from a terminal »).
 * Avant correctif (git stash de src/network et src/terminal) 7 cas sur 8 tombent ; le témoin (le serveur -www, déjà commité)
 * passe dans les deux états.
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
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/s.key -out ${PKI}/s.crt -days 30 -nodes -subj "/CN=lab.local"`);
  const server = new LinuxTerminalSession('srv', srv);
  await server.init();
  const client = new LinuxTerminalSession('cli', srv);
  await client.init();
  return { srv, server, client };
}

const START = `openssl s_server -accept 4433 -cert ${PKI}/s.crt -key ${PKI}/s.key`;

describe('openssl s_server interactif', () => {
  it('témoin : le mode -www reste servi', async () => {
    const { srv } = await lab();
    expect(await sh(srv, `${START} -www`)).toContain('ACCEPT');
  });

  it('sans -www : le serveur écoute et prend la main du terminal sans invite', async () => {
    const { server } = await lab();
    await type(server, START);
    expect(text(server)).toContain('ACCEPT');
    expect(server.foreground.getPrompt()).toBe('');
  });

  it('la ligne envoyée par un client s\'affiche sur le terminal du serveur', async () => {
    const { srv, server } = await lab();
    await type(server, START);
    await sh(srv, "printf 'hello server\\n' | openssl s_client -connect 127.0.0.1:4433");
    await flush();
    expect(text(server)).toContain('hello server');
  });

  it('la fermeture d\'une connexion est annoncée et l\'écoute continue', async () => {
    const { srv, server } = await lab();
    await type(server, START);
    await sh(srv, "printf 'one\\n' | openssl s_client -connect 127.0.0.1:4433");
    await flush();
    expect(text(server)).toContain('CONNECTION CLOSED');
    await sh(srv, "printf 'two\\n' | openssl s_client -connect 127.0.0.1:4433");
    await flush();
    expect(text(server)).toContain('two');
  });

  it('une ligne tapée sur le serveur arrive au s_client interactif connecté', async () => {
    const { server, client } = await lab();
    await type(server, START);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433');
    await type(server, 'welcome from server');
    expect(text(client)).toContain('welcome from server');
  });

  it('r renégocie la connexion TLS 1.2 ouverte, le client la suit', async () => {
    const { server, client } = await lab();
    await type(server, `${START} -tls1_2`);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433 -tls1_2');
    await type(server, 'r');
    expect(text(server)).toContain('SSL_renegotiate -> 1');
    await type(client, 'after renegotiation');
    expect(text(server)).toContain('after renegotiation');
  });

  it('k lance un KeyUpdate en TLS 1.3 et la conversation continue', async () => {
    const { server, client } = await lab();
    await type(server, START);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433 -tls1_3');
    await type(server, 'k');
    expect(text(server)).toContain('KeyUpdate sent');
    await type(client, 'still alive');
    expect(text(server)).toContain('still alive');
  });

  it('Q arrête le serveur : DONE, plus d\'écoute, l\'invite du shell revient', async () => {
    const { srv, server } = await lab();
    await type(server, START);
    await type(server, 'Q');
    expect(text(server)).toContain('DONE');
    expect(server.foreground.getPrompt()).not.toBe('');
    expect(await sh(srv, 'ss -ltn')).not.toContain(':4433');
  });
});
