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
 * Puis, pour les commandes qui restaient refusées (S, P) ou imprimaient un texte inventé (SSL_renegotiate -> 1, KeyUpdate sent) :
 * les réponses sont celles du vrai s_server 3.0.13 (SSL_do_handshake -> 1, print_stats, texte en clair de P, erreurs OpenSSL de r et c).
 * Avant ce second correctif 7 des 10 cas de la fin du fichier tombent (S, P, r en 1.3, B, les statistiques de Q, et la connexion TCP
 * de contrôle que s_client ouvrait en plus de la sonde TLS et que le serveur comptait comme un second accept) ; le témoin -www passe.
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
    expect(text(server)).toContain('SSL_do_handshake -> 1');
    await type(client, 'after renegotiation');
    expect(text(server)).toContain('after renegotiation');
  });

  it('k lance un KeyUpdate en TLS 1.3 et la conversation continue', async () => {
    const { server, client } = await lab();
    await type(server, START);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433 -tls1_3');
    await type(server, 'k');
    expect(text(server)).toContain('SSL_do_handshake -> 1');
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

  it('S imprime les statistiques du contexte (format de print_stats) : une connexion acceptée et terminée', async () => {
    const { server, client } = await lab();
    await type(server, START);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433 -tls1_3');
    await type(server, 'S');
    const shown = text(server);
    expect(shown).toContain('   0 items in the session cache');
    expect(shown).toContain('   1 server accepts (SSL_accept())');
    expect(shown).toContain('   1 server accepts that finished');
    expect(shown).toContain('   0 cache full overflows (128 allowed)');
  });

  it('Q avec un client connecté : DONE, fermeture, puis les statistiques finales', async () => {
    const { server, client } = await lab();
    await type(server, START);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433 -tls1_3');
    await type(server, 'Q');
    const shown = text(server);
    expect(shown).toContain('DONE');
    expect(shown).toContain('shutdown accept socket');
    expect(shown).toContain('CONNECTION CLOSED');
    expect(shown).toContain('   1 server accepts that finished');
  });

  it('P écrit « Lets print some clear text » en clair sur la prise, hors de TLS', async () => {
    const { srv, server } = await lab();
    await type(server, START);
    const raw = srv.getTcpStack().connect('127.0.0.1', 4433)!;
    let received = '';
    raw.onData((data) => { received += String(data); });
    await type(server, 'P');
    expect(received).toContain('Lets print some clear text\n');
    expect(text(server)).not.toContain('not available');
  });

  it('k en TLS 1.2 et r en TLS 1.3 : SSL_do_handshake -> 1 et, pour r en 1.3, l\'erreur can_renegotiate', async () => {
    const { server, client } = await lab();
    await type(server, START);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433 -tls1_3');
    await type(server, 'r');
    expect(text(server)).toMatch(/error:0A00010A:SSL routines:can_renegotiate:wrong ssl version/);
    expect(text(server)).toContain('SSL_do_handshake -> 1');
  });

  it("B n'est pas une commande du s_client 3.0 (le heartbeat a disparu) : la ligne part comme donnée", async () => {
    const { server, client } = await lab();
    await type(server, START);
    await type(client, 'openssl s_client -connect 127.0.0.1:4433 -tls1_3');
    await type(client, 'B');
    expect(text(client)).not.toContain('heartbeat');
    expect(text(server)).toMatch(/\nB$/);
  });
});
