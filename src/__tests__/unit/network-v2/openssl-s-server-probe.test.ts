/**
 * `openssl s_server -www|-WWW` ouvre une écoute TLS sur la pile TCP de la machine : le simulateur
 * l'interroge avec son propre `s_client` ET avec le vrai `openssl s_client` (relais TCP réel → pile
 * simulée) ; `-tls1_2` fixe la version, `-cipher` est évalué, un second `s_server` sur le même port
 * est refusé comme « Address already in use ».
 *
 * MESURÉ avant l'ajout de l'authentification du client (-Verify/-verify côté s_server, -cert/-key côté s_client) :
 * s_server refusait ces options et un client ne pouvait pas présenter de certificat. Avant ce correctif (stash de
 * src/network) 2 cas sur 10 tombent : -Verify avec le bon certificat client, et -Verify avec une autre autorité.
 * Les huit autres passent dans les deux états : la série initiale de s_server, déjà commitée, et -verify sans
 * exiger. Les cas « refusé » ne valent que par le témoin du même laboratoire où le client légitime obtient la page.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PKI, machine, sh } from './_httpsLab';
import { startTcpRelay } from './_tcpRelay';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab() {
  const srv = machine();
  await sh(srv, `mkdir -p ${PKI}`);
  await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/s.key -out ${PKI}/s.crt -days 30 -nodes -subj "/CN=lab.local"`);
  return srv;
}

function realClient(port: number, input: string, extra: readonly string[] = []): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('openssl', ['s_client', '-connect', `127.0.0.1:${port}`, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stdin.write(input);
    setTimeout(() => child.stdin.end(), 700);
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
  });
}

const GET = "printf 'GET / HTTP/1.0\\r\\n\\r\\n'";

describe('openssl s_server', () => {
  it('témoin : le laboratoire fournit un certificat et une clé', async () => {
    const srv = await lab();
    expect(await sh(srv, `openssl x509 -in ${PKI}/s.crt -noout -subject`)).toContain('lab.local');
  });

  it('-www ouvre une écoute et répond au s_client du simulateur', async () => {
    const srv = await lab();
    expect(await sh(srv, `openssl s_server -accept 4433 -cert ${PKI}/s.crt -key ${PKI}/s.key -www`)).toContain('ACCEPT');
    const out = await sh(srv, `${GET} | openssl s_client -connect 127.0.0.1:4433`);
    expect(out).toContain('s_server -accept 4433 -www');
  });

  it("l'écoute est visible dans ss -ltn", async () => {
    const srv = await lab();
    await sh(srv, `openssl s_server -accept 4433 -cert ${PKI}/s.crt -key ${PKI}/s.key -www`);
    expect(await sh(srv, 'ss -ltn')).toContain(':4433');
  });

  it('le vrai openssl s_client obtient la page par le fil', async () => {
    const srv = await lab();
    await sh(srv, `openssl s_server -accept 4433 -cert ${PKI}/s.crt -key ${PKI}/s.key -www`);
    const relay = await startTcpRelay(srv.getTcpStack(), '127.0.0.1', 4433);
    const real = await realClient(relay.port, 'GET / HTTP/1.0\r\n\r\n');
    relay.stop();
    expect(real).toContain('s_server -accept 4433 -www');
  }, 40000);

  it('-WWW sert un fichier du répertoire courant et 404 sinon', async () => {
    const srv = await lab();
    await sh(srv, 'cd /tmp');
    await sh(srv, 'echo hello-file > page.txt');
    expect(await sh(srv, `openssl s_server -accept 4434 -cert ${PKI}/s.crt -key ${PKI}/s.key -WWW`)).toContain('ACCEPT');
    const hit = await sh(srv, "printf 'GET /page.txt HTTP/1.0\\r\\n\\r\\n' | openssl s_client -connect 127.0.0.1:4434");
    const miss = await sh(srv, "printf 'GET /nope HTTP/1.0\\r\\n\\r\\n' | openssl s_client -connect 127.0.0.1:4434");
    expect(hit).toContain('hello-file');
    expect(miss).toContain("Error opening");
  });

  it('-tls1_2 fixe la version négociée', async () => {
    const srv = await lab();
    await sh(srv, `openssl s_server -accept 4433 -cert ${PKI}/s.crt -key ${PKI}/s.key -www -tls1_2`);
    const out = await sh(srv, `${GET} | openssl s_client -connect 127.0.0.1:4433`);
    expect(out).toContain('New, TLSv1.2');
  });

  it('un second s_server sur le même port est refusé', async () => {
    const srv = await lab();
    await sh(srv, `openssl s_server -accept 4433 -cert ${PKI}/s.crt -key ${PKI}/s.key -www`);
    expect(await sh(srv, `openssl s_server -accept 4433 -cert ${PKI}/s.crt -key ${PKI}/s.key -www`)).toContain('Address already in use');
  });

  it('-Verify exige un certificat client : sans lui la poignée de main échoue, avec lui la page arrive', async () => {
    const srv = await lab();
    await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/ca.key -out ${PKI}/ca.crt -days 30 -nodes -subj "/CN=Client CA"`);
    await sh(srv, `openssl req -new -newkey rsa:2048 -nodes -keyout ${PKI}/alice.key -out ${PKI}/alice.csr -subj "/CN=alice"`);
    await sh(srv, `openssl x509 -req -in ${PKI}/alice.csr -CA ${PKI}/ca.crt -CAkey ${PKI}/ca.key -CAcreateserial -out ${PKI}/alice.crt -days 30`);
    expect(await sh(srv, `openssl s_server -accept 4435 -cert ${PKI}/s.crt -key ${PKI}/s.key -www -Verify 1 -CAfile ${PKI}/ca.crt`)).toContain('ACCEPT');
    const without = await sh(srv, `${GET.replace('GET /', 'GET /')} | openssl s_client -connect 127.0.0.1:4435`);
    const withCert = await sh(srv, `${GET} | openssl s_client -connect 127.0.0.1:4435 -cert ${PKI}/alice.crt -key ${PKI}/alice.key`);
    expect(without).not.toContain('s_server -accept 4435');
    expect(withCert).toContain('s_server -accept 4435');
  });

  it('-Verify refuse un certificat client signé par une autre autorité', async () => {
    const srv = await lab();
    await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/ca.key -out ${PKI}/ca.crt -days 30 -nodes -subj "/CN=Client CA"`);
    await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/rogue.key -out ${PKI}/rogue.crt -days 30 -nodes -subj "/CN=rogue"`);
    await sh(srv, `openssl s_server -accept 4435 -cert ${PKI}/s.crt -key ${PKI}/s.key -www -Verify 1 -CAfile ${PKI}/ca.crt`);
    const out = await sh(srv, `${GET} | openssl s_client -connect 127.0.0.1:4435 -cert ${PKI}/rogue.crt -key ${PKI}/rogue.key`);
    expect(out).not.toContain('s_server -accept 4435');
  });

  it('-verify (sans exiger) laisse passer un client sans certificat', async () => {
    const srv = await lab();
    await sh(srv, `openssl req -x509 -newkey rsa:2048 -keyout ${PKI}/ca.key -out ${PKI}/ca.crt -days 30 -nodes -subj "/CN=Client CA"`);
    await sh(srv, `openssl s_server -accept 4435 -cert ${PKI}/s.crt -key ${PKI}/s.key -www -verify 1 -CAfile ${PKI}/ca.crt`);
    expect(await sh(srv, `${GET} | openssl s_client -connect 127.0.0.1:4435`)).toContain('s_server -accept 4435');
  });
});
