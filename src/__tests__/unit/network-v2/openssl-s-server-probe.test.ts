/**
 * `openssl s_server -www|-WWW` ouvre une écoute TLS sur la pile TCP de la machine : le simulateur
 * l'interroge avec son propre `s_client` ET avec le vrai `openssl s_client` (relais TCP réel → pile
 * simulée) ; `-tls1_2` fixe la version, `-cipher` est évalué, un second `s_server` sur le même port
 * est refusé comme « Address already in use ».
 *
 * MESURÉ avant correctif : `s_server` n'était pas une commande du simulateur, aucune écoute ne
 * s'ouvrait. Avant correctif (stash de src/network) 6 cas sur 7 tombent ; le témoin (le certificat
 * et la clé du laboratoire se génèrent) passe dans les deux états.
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
});
