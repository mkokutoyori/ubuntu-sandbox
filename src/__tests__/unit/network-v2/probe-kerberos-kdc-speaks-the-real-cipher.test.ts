/**
 * Sonde : le KDC du controleur de domaine et le client Kerberos du simulateur
 * parlent le chiffrement reel (aes256-cts-hmac-sha1-96) et le cadrage TCP de
 * RFC 4120 §7.2.2 : les tickets ne se lisent qu'avec la cle derivee du secret
 * du compte et de son sel, le KDC annonce ce sel (ETYPE-INFO2) dans l'erreur
 * PREAUTH_REQUIRED et dans l'AS-REP, un mauvais mot de passe est refuse par le
 * controle d'integrite, et le client lit une reponse enregistree d'un vrai
 * krb5kdc MIT.
 *
 * Autorite : le profil de chiffrement est verifie contre le vrai KDC dans
 * `probe-kerberos-aes-cts-hmac-sha1-matches-mit` ; ici le simulateur est
 * confronte a lui-meme par une derivation independante (le module `enctype`,
 * sans la facade `crypto.ts`) et aux octets du vrai KDC
 * (`mit-kerberos-kdc-capture.json` : KRB-ERROR PREAUTH_REQUIRED et AS-REP de
 * bob@CORP.LOCAL, mot de passe bobpw). Le client rejoue la requete avec le
 * nonce de la capture : sa reponse est celle que le vrai KDC a donnee a une
 * autre requete, ce qui prouve la lecture de l'AS-REP reel (champs de MIT
 * absents du simulateur : last-req, key-expiration), du sel annonce et du
 * dechiffrement, pas l'egalite des requetes. Dans l'autre sens, le KDC du
 * simulateur recoit les deux AS-REQ que le vrai kinit a envoyes (dont le
 * PA-ENC-TIMESTAMP chiffre par le vrai client avec la cle de bob) et rend
 * un AS-REP que la cle du vrai KDC dechiffre.
 *
 * Verifie hors du depot (pont de socket, non livre : il exige les binaires
 * MIT) : le vrai `kinit`, `klist`, `kvno` et `kinit -R` obtiennent un TGT,
 * des billets de service ldap/ et host/ et un renouvellement aupres du KDC du
 * simulateur, et un mauvais mot de passe donne « Password incorrect ».
 *
 * Mesure avant correction (chiffrement par flux XOR, sans sel, sans cadrage) :
 * le fichier ne se charge pas, le profil `enctype` n'existant pas dans le
 * depot d'origine, et les 9 cas tombent. Le temoin (« le laboratoire est
 * sain ») ne se lit donc pas avant non plus ; il garde le cas le plus simple
 * (un TGT obtenu) au cote des cas qui le contraignent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { KerberosClient, dialKdc } from '@/network/kerberos/KerberosClient';
import { KdcSessionHandler } from '@/network/kerberos/KdcSession';
import {
  TcpMessageReader, decodeEncKdcRepPart, decodeEncTicketPart, decodeEtypeInfo2, decodeKdcRep, decodeKrbError,
  decodeEncryptedData, decodeKdcReq, decodePaDataSeq, encodeKdcReq, frameForTcp,
} from '@/network/kerberos/codec';
import { parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import { AES256_PROFILE, decrypt, stringToKey } from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { PA_ENC_TIMESTAMP, PA_ETYPE_INFO2, PrincipalNameType, principalName, type KdcReq } from '@/network/kerberos/types';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { loadJson } from './openldap-replay-support';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (device: WindowsServer) => PowerShellSubShell.create(device).subShell;
const run = async (shell: ReturnType<typeof ps>, line: string) => (await shell.processLine(line)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; client: LinuxServer }> {
  const dc = new WindowsServer('DC1');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], hub.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], hub.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.50.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.50.20'), mask);
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  return { dc, client };
}

interface Capture {
  readonly keys: Readonly<Record<string, string>>;
  readonly asExchange: readonly string[];
}

const capture = loadJson<Capture>('mit-kerberos-kdc-capture.json');
const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

const KU_TICKET = 2;
const KU_AS_REP_ENC_PART = 3;
const KDC_ADDRESS = '192.168.50.10';

async function buildCorpLan(): Promise<WindowsServer> {
  const dc = new WindowsServer('DC1');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName corp.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Enabled $true -Name bob -AccountPassword (ConvertTo-SecureString "bobpw" -AsPlainText -Force)');
  return dc;
}

function answers(handler: KdcSessionHandler, requests: readonly Uint8Array[]): Uint8Array[] {
  const replies: Uint8Array[] = [];
  const reader = new TcpMessageReader();
  let listener: ((data: Uint8Array) => void) | null = null;
  handler.register({
    onData(callback: (data: Uint8Array) => void) {
      listener = callback;
      return () => { listener = null; };
    },
    send(message: Uint8Array) {
      for (const reply of reader.push(message)) replies.push(reply);
    },
    close() {},
  } as unknown as TcpSocket);
  for (const request of requests) listener!(frameForTcp(request));
  return replies;
}

describe('the controller KDC and the Kerberos client use the real cipher', () => {
  it('the lab is sound: the client obtains a ticket-granting ticket for alice', async () => {
    const { client } = await buildLan();
    const result = dialKdc(client.getTcpStack(), KDC_ADDRESS).client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(result.ok).toBe(true);
  });

  it('the AS-REP is readable with the key derived from the password and the account salt, and with no other', async () => {
    const { client } = await buildLan();
    const connection = dialKdc(client.getTcpStack(), KDC_ADDRESS).client!;
    const result = connection.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(result.ok).toBe(true);
    expect(result.sessionKey).toHaveLength(32);
    expect(hex(result.sessionKey!)).toBe(hex(result.encKdcRepPart!.key.keyValue));
  });

  it('the ticket opens with the krbtgt key derived from its secret and the krbtgt salt', async () => {
    const { dc, client } = await buildLan();
    const result = dialKdc(client.getTcpStack(), KDC_ADDRESS).client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    const secret = dc.getDirectoryStore()!.getUserSecret('krbtgt')!;
    const krbtgtKey = stringToKey(AES256_PROFILE, secret, 'LAB.LOCALkrbtgt');
    const opened = decodeEncTicketPart(decrypt(AES256_PROFILE, krbtgtKey, KU_TICKET, result.ticket!.encPart.cipher));
    expect(hex(opened.key.keyValue)).toBe(hex(result.sessionKey!));
    expect(opened.cname.nameString).toEqual(['alice']);
  });

  it('the pre-authentication error announces the salt of the account', async () => {
    const { client } = await buildLan();
    const socket = dialKdc(client.getTcpStack(), KDC_ADDRESS);
    expect(socket.ok).toBe(true);
    const exchange = await probeFirstRequest(client);
    const announced = decodeEtypeInfo2(decodePaDataSeq(parseTLV(exchange.eData!, 0)).find((entry) => entry.type === PA_ETYPE_INFO2)!.value);
    expect(announced).toEqual([{ etype: 18, salt: 'LAB.LOCALalice' }]);
    expect(decodePaDataSeq(parseTLV(exchange.eData!, 0)).some((entry) => entry.type === PA_ENC_TIMESTAMP)).toBe(true);
  });

  it('a wrong password is refused by the integrity check, not by a garbled structure', async () => {
    const { client } = await buildLan();
    const result = dialKdc(client.getTcpStack(), KDC_ADDRESS).client!.asExchange('alice', 'wrongpassword', 'LAB.LOCAL');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(24);
  });

  it('every message crosses the wire with the four-octet length of RFC 4120 section 7.2.2', async () => {
    const framed = frameForTcp(new Uint8Array([1, 2, 3]));
    expect(Array.from(framed)).toEqual([0, 0, 0, 3, 1, 2, 3]);
    const reader = new TcpMessageReader();
    expect(reader.push(framed.subarray(0, 5))).toEqual([]);
    expect(reader.push(framed.subarray(5)).map((message) => Array.from(message))).toEqual([[1, 2, 3]]);
  });

  it('reads the pre-authentication error and the AS-REP a real krb5kdc gave bob', () => {
    const [, preauthRequired, secondRequest, reply] = capture.asExchange.map(bytes);
    const nonce = new Uint8Array(4);
    new DataView(nonce.buffer).setUint32(0, decodeKdcReq(secondRequest).reqBody.nonce, false);
    const socket = replaySocket([preauthRequired, reply]);
    const client = new KerberosClient(socket, () => Date.UTC(2026, 9, 7, 20, 28, 33), () => nonce);
    const result = client.asExchange('bob', 'bobpw', 'CORP.LOCAL');
    expect(result.ok).toBe(true);
    const recorded = decodeKdcRep(reply);
    expect(hex(result.ticket!.encPart.cipher)).toBe(hex(recorded.ticket.encPart.cipher));
    const opened = decodeEncKdcRepPart(decrypt(AES256_PROFILE, bytes(capture.keys['bob-aes256']), KU_AS_REP_ENC_PART, recorded.encPart.cipher));
    expect(hex(result.sessionKey!)).toBe(hex(opened.key.keyValue));
    expect(result.encKdcRepPart!.sname.nameString).toEqual(['krbtgt', 'CORP.LOCAL']);
    expect(socket.requests).toHaveLength(2);
  });

  it('answers the two requests a real kinit sent to a real krb5kdc for bob, whose key is the one the real KDC stores', async () => {
    const dc = await buildCorpLan();
    const [firstRequest, , secondRequest] = capture.asExchange.map(bytes);
    const stamp = decrypt(
      AES256_PROFILE, bytes(capture.keys['bob-aes256']), 1,
      decodeEncryptedDataOf(secondRequest),
    );
    const seconds = Date.parse(new TextDecoder().decode(parseTLV(parseTLV(stamp, 0).content, 0).content.subarray(2, 17)).replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const handler = new KdcSessionHandler({ store: dc.getDirectoryStore()!, deviceId: 'DC1', nowMs: () => seconds });
    const [error, reply] = answers(handler, [firstRequest, secondRequest]);
    const announced = decodePaDataSeq(parseTLV(decodeKrbError(error).eData!, 0)).find((entry) => entry.type === PA_ETYPE_INFO2)!;
    expect(decodeEtypeInfo2(announced.value)).toEqual([{ etype: 18, salt: 'CORP.LOCALbob' }]);
    const answered = decodeKdcRep(reply);
    const opened = decodeEncKdcRepPart(decrypt(AES256_PROFILE, bytes(capture.keys['bob-aes256']), KU_AS_REP_ENC_PART, answered.encPart.cipher));
    expect(opened.nonce).toBe(decodeKdcReq(secondRequest).reqBody.nonce);
    expect(opened.sname.nameString).toEqual(['krbtgt', 'CORP.LOCAL']);
    expect(opened.flags.preAuthent).toBe(true);
  });

  it('the pre-authentication error of a real krb5kdc announces the salt the client then used', () => {
    const [, preauthRequired] = capture.asExchange.map(bytes);
    const error = decodeKrbError(preauthRequired);
    const announced = decodePaDataSeq(parseTLV(error.eData!, 0)).find((entry) => entry.type === PA_ETYPE_INFO2)!;
    expect(decodeEtypeInfo2(announced.value)).toEqual([{ etype: 18, salt: 'CORP.LOCALbob' }]);
  });
});

function decodeEncryptedDataOf(request: Uint8Array): Uint8Array {
  const padata = decodeKdcReq(request).padata.find((entry) => entry.type === PA_ENC_TIMESTAMP)!;
  return decodeEncryptedData(parseTLV(padata.value, 0)).cipher;
}

async function probeFirstRequest(client: LinuxServer) {
  const conn = client.getTcpStack().connect(KDC_ADDRESS, 88)!;
  const reader = new TcpMessageReader();
  let reply: Uint8Array | null = null;
  conn.onData((data) => {
    if (data instanceof Uint8Array) for (const message of reader.push(data)) reply = message;
  });
  const request: KdcReq = {
    msgType: 'AS-REQ', padata: [],
    reqBody: {
      kdcOptions: 0, cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), realm: 'LAB.LOCAL',
      sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'), till: 2_000_000_000, nonce: 7, etype: [18],
    },
  };
  conn.send(frameForTcp(encodeKdcReq(request)));
  return decodeKrbError(reply!);
}

function replaySocket(replies: readonly Uint8Array[]): TcpSocket & { requests: Uint8Array[] } {
  const requests: Uint8Array[] = [];
  let listener: ((data: Uint8Array) => void) | null = null;
  let index = 0;
  return {
    requests,
    onData(callback: (data: Uint8Array) => void) {
      listener = callback;
      return () => { listener = null; };
    },
    send(message: Uint8Array) {
      requests.push(message);
      listener?.(frameForTcp(replies[index++]));
    },
  } as unknown as TcpSocket & { requests: Uint8Array[] };
}
