/**
 * Sonde — `listen-on` et `listen-on-v6` decident des adresses sur lesquelles named ecoute, en clair comme en TLS.
 *
 * Mesure (BIND 9.18.39 reel, boucle locale, `ss -lnt`) : `listen-on port N { ADRESSES; }` n'ouvre que les adresses de la liste
 * (`listen-on port 5353 { 127.0.0.1; }` : un seul LISTEN sur 127.0.0.1:5353, rien sur les autres adresses) ; plusieurs declarations
 * s'additionnent, chacune avec son port ; `{ none; }` n'ouvre rien ; sans declaration, named ecoute sur toutes les adresses du 53.
 * `listen-on-v6` ne vaut que pour les adresses IPv6, avec les memes regles ; un `tls` ou un `http` qui suit `listen-on-v6` ouvre ses
 * ports sur les adresses IPv6 de la liste.
 *
 * Non mesure ici : l'IPv6 reel (le noyau du banc n'a aucune interface IPv6, named dit « no IPv6 interfaces found ») ; les cas v6 suivent
 * la memes regles que le v4 mesure, ce que dit le manuel de reference de BIND 9.18 pour `listen-on-v6`.
 *
 * Avant la correction (git stash push -- src/network src/powershell) : 9 cas sur 11 tombent (le 53 ecoutait sur toutes les adresses
 * quelle que soit la liste, `listen-on-v6 ... tls` etait lu sans rien ouvrir, un listener `listen-on-v6 { none; }` n'etait pas lu).
 * Passent des deux cotes : les deux temoins (le 53 repond sans declaration, en IPv4 comme en IPv6).
 */
import { describe, it, expect } from 'vitest';
import { lab, SERVER_IP, PKI } from './_bind9-tls-lab';

const LONG = 120_000;
const V6_SERVER = 'fd00:1::1';
const V6_PC = 'fd00:1::2';
const TLS = `tls t { key-file "${PKI}/srv.key"; cert-file "${PKI}/srv.pem"; };`;

async function dualStackLab() {
  const context = await lab();
  await context.server.executeCommand(`ip -6 addr add ${V6_SERVER}/64 dev eth0`);
  await context.pc.executeCommand(`ip -6 addr add ${V6_PC}/64 dev eth0`);
  return context;
}

describe('listen-on en clair', () => {
  it('temoin : sans declaration, le 53 repond sur l\'adresse du reseau et sur la boucle locale', async () => {
    const { start, dig, server } = await lab();
    await start('options { recursion no; };');
    expect(await dig('www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await server.executeCommand('dig @127.0.0.1 www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);

  it('une liste de boucle locale ne repond pas sur le reseau, ni en UDP ni en TCP', async () => {
    const { start, dig, server } = await lab();
    await start('options { listen-on { 127.0.0.1; }; recursion no; };');
    expect(await server.executeCommand('dig @127.0.0.1 www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await server.executeCommand('dig @127.0.0.1 +tcp www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await dig('+tries=1 +time=1 www.banquehorizon.com +short')).not.toBe('203.0.113.20');
    expect(await dig('+tcp +tries=1 www.banquehorizon.com')).toContain('failed: connection refused.');
  }, LONG);

  it('une liste qui porte l\'adresse du reseau y repond, et plus sur la boucle locale', async () => {
    const { start, dig, server } = await lab();
    await start(`options { listen-on { ${SERVER_IP}; }; recursion no; };`);
    expect(await dig('www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await server.executeCommand('dig @127.0.0.1 +tries=1 +time=1 www.banquehorizon.com +short')).not.toBe('203.0.113.20');
  }, LONG);

  it('plusieurs declarations s\'additionnent, chacune avec son port', async () => {
    const { start, dig } = await lab();
    await start(`options { listen-on { ${SERVER_IP}; }; listen-on port 5353 { ${SERVER_IP}; }; recursion no; };`);
    expect(await dig('www.banquehorizon.com +short')).toBe('203.0.113.20');
    expect(await dig('-p 5353 www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);

  it('{ none; } n\'ouvre aucun 53 IPv4', async () => {
    const { start, dig } = await lab();
    await start('options { listen-on { none; }; recursion no; };');
    expect(await dig('+tries=1 +time=1 www.banquehorizon.com +short')).not.toBe('203.0.113.20');
  }, LONG);

  it('un rechargement qui change la liste deplace l\'ecoute', async () => {
    const { start, dig, server } = await lab();
    await start('options { recursion no; };');
    expect(await dig('www.banquehorizon.com +short')).toBe('203.0.113.20');
    await server.executeCommand(`sed -i 's/options { recursion no; };/options { listen-on { 127.0.0.1; }; recursion no; };/' /etc/bind/named.conf`);
    await server.executeCommand('rndc reload');
    expect(await dig('+tries=1 +time=1 www.banquehorizon.com +short')).not.toBe('203.0.113.20');
    expect(await server.executeCommand('dig @127.0.0.1 www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);
});

describe('listen-on-v6', () => {
  it('temoin : le 53 repond en IPv6 sans declaration', async () => {
    const { start, pc } = await dualStackLab();
    await start('options { recursion no; };');
    expect(await pc.executeCommand(`dig @${V6_SERVER} www.banquehorizon.com +short`)).toBe('203.0.113.20');
  }, LONG);

  it('listen-on-v6 { none; } ferme le 53 IPv6 sans toucher l\'IPv4', async () => {
    const { start, pc, dig } = await dualStackLab();
    await start('options { listen-on-v6 { none; }; recursion no; };');
    expect(await pc.executeCommand(`dig @${V6_SERVER} +tries=1 +time=1 www.banquehorizon.com +short`)).not.toBe('203.0.113.20');
    expect(await dig('www.banquehorizon.com +short')).toBe('203.0.113.20');
  }, LONG);

  it('listen-on-v6 ... tls ouvre le 853 sur les adresses IPv6 de la liste, et dig +tls y repond', async () => {
    const { start, pc, server } = await dualStackLab();
    await start([TLS, `options { listen-on-v6 port 853 tls t { ${V6_SERVER}; }; recursion no; };`].join('\n'));
    expect(await server.executeCommand('ss -ltn')).toContain(`[${V6_SERVER}]:853`);
    const out = await pc.executeCommand(`dig @${V6_SERVER} +tls www.banquehorizon.com`);
    expect(out).toContain('203.0.113.20');
    expect(out).toContain(`;; SERVER: ${V6_SERVER}#853(${V6_SERVER}) (TLS)`);
  }, LONG);

  it('listen-on-v6 ... tls http ouvre aussi le DoH en IPv6', async () => {
    const { start, pc } = await dualStackLab();
    await start([TLS, `options { listen-on-v6 port 443 tls t http default { any; }; recursion no; };`].join('\n'));
    const out = await pc.executeCommand(`dig @${V6_SERVER} +https www.banquehorizon.com`);
    expect(out).toContain('203.0.113.20');
    expect(out).toContain('(HTTPS)');
  }, LONG);

  it('une liste IPv6 qui ne porte pas l\'adresse du serveur n\'ouvre rien', async () => {
    const { start, pc } = await dualStackLab();
    await start([TLS, `options { listen-on-v6 port 853 tls t { fd00:9::1; }; recursion no; };`].join('\n'));
    expect(await pc.executeCommand(`dig @${V6_SERVER} +tls +tries=1 www.banquehorizon.com`)).toContain('connection refused.');
  }, LONG);
});
