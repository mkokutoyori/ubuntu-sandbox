/**
 * `openssl ocsp -url https://hôte:port/chemin` interroge le répondeur à travers une session TLS (apps/ocsp.c : `process_responder` crée un
 * SSL_CTX client quand le schéma est https, sans vérification du pair par défaut). Le port par défaut d'une URL https est 443 ; un schéma
 * inconnu reste refusé par `Error parsing -url argument`.
 *
 * MESURÉ avant correctif : seule l'expression `http://` était acceptée et `https://` répondait « Error parsing -url argument ». Avant
 * correctif (git stash de src/network) 2 cas sur 3 tombent ; le refus d'un schéma inconnu passe dans les deux états (témoin).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createResponse } from '@/network/http/semantics/types';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { pemToCert, pemToPrivateKey } from '@/network/pki/pem';
import { fileTextToBytes } from '@/crypto/encoding';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const CA = '/etc/ssl/CA';

async function lab(name: string) {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  await srv.executeCommand(`mkdir -p ${CA}`);
  await srv.executeCommand(`openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  await srv.executeCommand(`openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/good.key -out /tmp/good.csr -subj "/CN=good.lab"`);
  await srv.executeCommand(`openssl ca -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/good.csr -out /tmp/good.crt -days 30`);
  await srv.executeCommand(`openssl req -x509 -newkey rsa:1024 -keyout /tmp/resp.key -out /tmp/resp.crt -days 30 -nodes -subj "/CN=responder.lab"`);
  await srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert /tmp/good.crt -no_nonce -reqout /tmp/q.req`);
  await srv.executeCommand(`openssl ocsp -reqin /tmp/q.req -index ${CA}/index.txt -CA ${CA}/ca.crt -rkey ${CA}/ca.key -respout /tmp/r.resp`);
  const body = fileTextToBytes((srv as unknown as { executor: { vfs: { readFile(path: string): string | null } } }).executor.vfs.readFile('/tmp/r.resp')!);
  const certificate = pemToCert(await srv.executeCommand('cat /tmp/resp.crt'))!;
  const key = pemToPrivateKey(await srv.executeCommand('cat /tmp/resp.key'))!;
  const seen: string[] = [];
  new HttpsServerSession(srv.getTcpStack(), 8443, { serverCert: certificate, serverPrivateKey: key } as never, (request) => {
    seen.push(`${request.method} ${request.target}`);
    const response = createResponse(200, 'OK');
    response.headers.set('Content-Type', 'application/ocsp-response');
    response.body = body;
    return response;
  }).start();
  return { srv, seen };
}

describe('openssl ocsp -url https://', () => {
  it('le répondeur en TLS répond : Response verify OK et good, la requête POST est arrivée chiffrée', async () => {
    const { srv, seen } = await lab('OH1');
    const out = await srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert /tmp/good.crt -no_nonce -url https://127.0.0.1:8443/ocsp -CAfile ${CA}/ca.crt 2>&1`);
    expect(out).toContain('Response verify OK');
    expect(out).toContain('/tmp/good.crt: good');
    expect(seen).toEqual(['POST /ocsp']);
  });

  it('un port fermé : Error querying OCSP responder', async () => {
    const { srv } = await lab('OH2');
    const out = await srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert /tmp/good.crt -no_nonce -url https://127.0.0.1:8999/ocsp -CAfile ${CA}/ca.crt 2>&1`);
    expect(out).toContain('Error querying OCSP responder');
  });

  it('un schéma inconnu reste refusé : Error parsing -url argument', async () => {
    const { srv } = await lab('OH3');
    const out = await srv.executeCommand(`openssl ocsp -issuer ${CA}/ca.crt -cert /tmp/good.crt -url ftp://127.0.0.1/ocsp 2>&1`);
    expect(out).toContain('Error parsing -url argument');
  });
});
