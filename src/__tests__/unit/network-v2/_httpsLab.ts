/**
 * Laboratoire commun des sondes HTTPS : PKI produite PAR la machine (openssl),
 * client TLS direct sur la pile TCP d'un `LinuxServer`.
 */
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { pemToCert } from '@/network/pki/pem';
import { createRequest } from '@/network/http/semantics/types';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import { runTlsHandshakeOverSocket, encodeRecords, decodeRecords, bytesToBinaryString, binaryStringToBytes } from '@/network/http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { encodeRequest } from '@/network/http/http1/Http1Wire';
import type { TlsRecord } from '@/network/tls/recordLayer';

export const PKI = '/etc/ssl/pki';

export function machine(): LinuxServer {
  const srv = new LinuxServer('linux-server', 'NG');
  srv.powerOn();
  return srv;
}

export async function sh(srv: LinuxServer, command: string): Promise<string> {
  return srv.executeCommand(command);
}

export async function selfSigned(srv: LinuxServer, name: string, cn: string): Promise<void> {
  await sh(srv, `openssl req -x509 -newkey rsa:1024 -keyout ${PKI}/${name}.key -out ${PKI}/${name}.crt -days 365 -nodes -subj "/CN=${cn}"`);
}

export async function issue(srv: LinuxServer, ca: string, name: string, cn: string): Promise<void> {
  await sh(srv, `openssl req -new -newkey rsa:1024 -nodes -keyout ${PKI}/${name}.key -out ${PKI}/${name}.csr -subj "/CN=${cn}"`);
  await sh(srv, `openssl x509 -req -in ${PKI}/${name}.csr -CA ${PKI}/${ca}.crt -CAkey ${PKI}/${ca}.key -CAcreateserial -out ${PKI}/${name}.crt -days 30`);
}

export async function lab(srv: LinuxServer): Promise<void> {
  await sh(srv, `mkdir -p ${PKI}`);
  await selfSigned(srv, 'ca', 'Lab CA');
  await selfSigned(srv, 'rogue', 'Rogue CA');
  await selfSigned(srv, 'srv', 'lab.local');
  await issue(srv, 'ca', 'alice', 'alice');
  await issue(srv, 'rogue', 'mallory', 'mallory');
}

export const ALICE = `--cert ${PKI}/alice.crt --key ${PKI}/alice.key`;
export const MALLORY = `--cert ${PKI}/mallory.crt --key ${PKI}/mallory.key`;

async function trustedVerifier(srv: LinuxServer, ...names: string[]): Promise<CertificateVerifier> {
  const anchors = [];
  for (const name of names) {
    const cert = pemToCert(await sh(srv, `cat ${PKI}/${name}.crt`));
    if (cert) anchors.push(cert);
  }
  return new CertificateVerifier({ trustAnchors: anchors });
}

export interface Exchange { readonly client: TlsClientSession; readonly records: TlsRecord[]; readonly status: string }

export async function exchange(
  srv: LinuxServer, config: Partial<TlsClientConfig>, host = 'lab.local', path = '/', port = 443, hostHeader = host,
): Promise<Exchange | null> {
  const socket = srv.getTcpStack().connect('127.0.0.1', port);
  if (!socket || socket.state !== 'established') return null;
  const verifier = await trustedVerifier(srv, 'srv', 'srv2', 'srv3');
  const client = new TlsClientSession({ verifier, serverName: host, ...config } as TlsClientConfig);
  runTlsHandshakeOverSocket(socket, client);
  if (client.result !== 'success') { socket.close(); return { client, records: [], status: '' }; }
  const request = createRequest('GET', path);
  request.headers.set('Host', hostHeader);
  request.headers.set('Connection', 'close');
  const sealed = encryptApplicationData(client.clientTraffic(), 0, new TextEncoder().encode(encodeRequest(request)));
  let received: TlsRecord[] = [];
  const stop = socket.onData((data) => { received = decodeRecords(binaryStringToBytes(String(data))); });
  socket.write(bytesToBinaryString(encodeRecords(sealed.records)));
  stop();
  const plain = received.length > 0 ? new TextDecoder().decode(decryptApplicationData(client.serverTraffic(), 0, received).plaintext) : '';
  return { client, records: received, status: plain.split('\r\n')[0] ?? '' };
}
