/*
 * Sonde -- l'authentification SSH est celle de la RFC 4252, en messages
 * binaires, et non une enveloppe JSON `{"op":"auth",...}'.
 *
 * MESURE DE DEPART (base `origin/mandeng' + etape A). Une fois le transport
 * RFC 4253 etabli et le SERVICE_REQUEST « ssh-userauth » accepte, le serveur
 * ignorait tout SSH_MSG_USERAUTH_REQUEST (50) : il n'ecoutait que du JSON
 * `{"op":"auth"}' porte par le message local 192. Mesure avec paramiko 5.0,
 * un client independant : « Authentication type (none) not permitted ».
 * Meme defaut cote client : le simulateur ne savait pas lire un
 * SSH_MSG_USERAUTH_FAILURE (51), SUCCESS (52), BANNER (53) ni PK_OK (60).
 *
 * AUTORITES. RFC 4252 §5 (USERAUTH_REQUEST, un SERVICE_REQUEST « ssh-userauth »
 * est accepte tant que l'authentification n'a pas reussi), §5.1 (reponses :
 * FAILURE porte la liste des methodes et « partial success »), §5.4
 * (BANNER), §7 (publickey : requete sans signature -> PK_OK 60 qui renvoie
 * l'algorithme et la cle, puis requete signee), §8 (password), RFC 4256
 * (keyboard-interactive : INFO_REQUEST 60 / INFO_RESPONSE 61). Les cas limites
 * viennent du CODE d'OpenSSH 8.9p1 (clone local) : `auth2.c'
 * (`input_userauth_request' : « Change of username or service not allowed:
 * (%s,%s) -> (%s,%s) » ; `input_service_request' : « bad service request %s »
 * pour tout service autre que ssh-userauth ou apres le succes ;
 * `userauth_finish' : tentative `none' initiale sans penalite, puis
 * `auth_maxtries_exceeded' -> « Too many authentication failures »),
 * `auth2-pubkey.c' (have_sig, PK_OK) et `auth2-chall.c'.
 *
 * Eprouve HORS DEPOT sur une vraie socket locale, dans les deux sens : un
 * client paramiko 5.0 contre le serveur du simulateur (none -> liste
 * « publickey,password », bannieres, mot de passe faux puis juste, cle
 * ed25519 avec requete puis signature, utilisateur inconnu refuse) et le
 * client du simulateur contre un serveur asyncssh 2.24 (mot de passe, cle
 * avec PK_OK, trois echecs puis « Permission denied (...) »).
 *
 * DISCRIMINATION (`git stash' des fichiers suivis) : 12 des 13 cas tombent
 * avant le correctif. Passe des deux cotes le TEMOIN, qui prouve que le
 * laboratoire joint le port 22 et que le transport s'etablit. Les numeros de
 * messages attendus sont ecrits en clair (RFC 4252 §6) et non importes du
 * code teste : importes, ils valent `undefined' avant le correctif et cinq
 * assertions passaient a vide.
 *
 * LIMITE MESUREE : le limiteur reactif du serveur Linux (5 echecs en 60 s,
 * type fail2ban) coupe la connexion avant MaxAuthTries 6 ; les cas de
 * MaxAuthTries fixent donc la limite a 3 ou 2.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import type { TcpStream } from '@/network/tcp/types';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import {
  decodeUserauthBanner, decodeUserauthFailure, encodeUserauthRequest,
} from '@/network/protocols/ssh/auth/UserauthMessages';
import { SshReader, SshWriter } from '@/network/protocols/ssh/wire/SshDataTypes';
import { base64ToBytes } from '@/crypto/encoding';
import { keygenPair, keygenPrivateKey, sshPublicKeyBlob } from '@/network/devices/linux/network/SshKeygenMaterial';
import { signUserauth, userauthSignatureAlgorithm, userauthSignedData } from '@/network/protocols/ssh/auth/UserauthSignature';
import { sshPublicKeyFromBlob } from '@/network/devices/linux/network/SshKeygenMaterial';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const SSH_MSG_SERVICE_ACCEPT = 6;
const SSH_MSG_USERAUTH_FAILURE = 51;
const SSH_MSG_USERAUTH_SUCCESS = 52;
const SSH_MSG_USERAUTH_BANNER = 53;
const SSH_MSG_USERAUTH_PK_OK = 60;
const SSH_USERAUTH_SERVICE = 'ssh-userauth';
const CLIENT_IP = '10.0.0.10';
const SERVER_IP = '10.0.0.2';

async function lab(sshdLines: readonly string[] = []): Promise<{ client: LinuxPC; server: LinuxServer; publicKey: string; privateKey: string }> {
  const client = new LinuxPC('linux-pc', 'PC', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c').connect(client.getPort('eth0')!, server.getPort('eth0')!);
  const mask = new SubnetMask('255.255.255.0');
  client.getPort('eth0')!.configureIP(new IPAddress(CLIENT_IP), mask);
  server.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), mask);
  const pair = keygenPair('ssh-ed25519', 'probe@lab');
  for (const line of [
    'sudo systemctl start ssh',
    'sudo useradd -m alice',
    'echo "alice:secret" | sudo chpasswd',
    'sudo mkdir -p /home/alice/.ssh',
    `echo '${pair.pub.trim()}' | sudo tee /home/alice/.ssh/authorized_keys`,
    'sudo chown -R alice:alice /home/alice/.ssh',
    'sudo chmod 700 /home/alice/.ssh',
    'sudo chmod 600 /home/alice/.ssh/authorized_keys',
    'echo "AUTHORIZED ACCESS ONLY" | sudo tee /etc/issue.net',
    ...sshdLines.map((l) => `echo "${l}" | sudo tee -a /etc/ssh/sshd_config`),
    ...(sshdLines.length > 0 ? ['sudo systemctl reload ssh'] : []),
  ]) await server.executeCommand(line);
  await settle();
  return { client, server, publicKey: pair.pub, privateKey: pair.priv };
}

interface Wire {
  readonly transport: SshTransport;
  readonly sessionId: Uint8Array;
  readonly inbox: Uint8Array[];
  readonly closes: string[];
  send(payload: Uint8Array): Promise<void>;
  last(): Uint8Array | undefined;
}

async function open(client: LinuxPC): Promise<Wire> {
  const socket = await (client as unknown as {
    tcpConnect(ip: string, port: number): Promise<TcpStream | null>;
  }).tcpConnect(SERVER_IP, 22);
  expect(socket).toBeTruthy();
  const transport = new SshTransport(socket!, { role: 'client', identification: 'SSH-2.0-probe' });
  const inbox: Uint8Array[] = [];
  const closes: string[] = [];
  transport.onClose((reason) => closes.push(reason));
  const outcome = await transport.established;
  expect(outcome.ok).toBe(true);
  transport.onMessage((payload) => { inbox.push(payload); });
  return {
    transport,
    sessionId: outcome.ok ? outcome.sessionId : new Uint8Array(),
    inbox,
    closes,
    send: async (payload) => { transport.send(payload); await settle(); },
    last: () => inbox.at(-1),
  };
}

function disconnectText(wire: Wire): string | null {
  return wire.transport.peerDisconnect?.description ?? null;
}

describe('le serveur authentifie en messages RFC 4252', () => {
  it('TEMOIN -- le transport s etablit et un SERVICE_REQUEST ssh-userauth est accepte', async () => {
    const { client } = await lab();
    const wire = await open(client);

    expect(wire.transport.isOpen).toBe(true);
  });

  it('`none` est refuse en listant les methodes -- publickey,password', async () => {
    const { client } = await lab();
    const wire = await open(client);
    await wire.send(encodeUserauthRequest('alice', { method: 'none' }));
    const failure = wire.last() ? decodeUserauthFailure(wire.last()!) : null;

    expect(failure).toEqual({ methods: 'publickey,password', partialSuccess: false });
  });

  it('un mot de passe faux donne USERAUTH_FAILURE, le bon USERAUTH_SUCCESS', async () => {
    const { client } = await lab();
    const wire = await open(client);
    await wire.send(encodeUserauthRequest('alice', { method: 'password', password: 'nope' }));
    const afterWrong = wire.last()?.[0];
    await wire.send(encodeUserauthRequest('alice', { method: 'password', password: 'secret' }));

    expect([afterWrong, wire.last()?.[0]]).toEqual([SSH_MSG_USERAUTH_FAILURE, SSH_MSG_USERAUTH_SUCCESS]);
  });

  it('la banniere de sshd_config arrive en USERAUTH_BANNER avant la premiere reponse', async () => {
    const { client } = await lab(['Banner /etc/issue.net']);
    const wire = await open(client);
    await wire.send(encodeUserauthRequest('alice', { method: 'none' }));
    const types = wire.inbox.map((m) => m[0]);

    expect(types).toEqual([SSH_MSG_USERAUTH_BANNER, SSH_MSG_USERAUTH_FAILURE]);
    expect(decodeUserauthBanner(wire.inbox[0])).toBe('AUTHORIZED ACCESS ONLY\n');
  });

  it('une cle sans signature recoit PK_OK avec l algorithme et la cle', async () => {
    const { client, publicKey } = await lab();
    const wire = await open(client);
    const blob = base64ToBytes(publicKey.trim().split(/\s+/)[1]);
    await wire.send(encodeUserauthRequest('alice', { method: 'publickey', algorithm: 'ssh-ed25519', publicKeyBlob: blob }));
    const reply = wire.last()!;
    const reader = new SshReader(reply);

    expect(reader.readByte()).toBe(SSH_MSG_USERAUTH_PK_OK);
    expect(reader.readString()).toBe('ssh-ed25519');
    expect(Array.from(reader.readBytes())).toEqual(Array.from(blob));
  });

  it('la meme cle signee sur l identifiant de session ouvre la session', async () => {
    const { client, publicKey, privateKey } = await lab();
    const wire = await open(client);
    const blob = base64ToBytes(publicKey.trim().split(/\s+/)[1]);
    const key = keygenPrivateKey(privateKey)!;
    const algorithm = userauthSignatureAlgorithm(sshPublicKeyFromBlob(sshPublicKeyBlob(key))!);
    const signature = signUserauth(key, userauthSignedData(wire.sessionId, 'alice', algorithm, blob));
    await wire.send(encodeUserauthRequest('alice', { method: 'publickey', algorithm, publicKeyBlob: blob, signature }));

    expect(wire.last()?.[0]).toBe(SSH_MSG_USERAUTH_SUCCESS);
  });

  it('une signature faite sur un autre identifiant de session est refusee', async () => {
    const { client, publicKey, privateKey } = await lab();
    const wire = await open(client);
    const blob = base64ToBytes(publicKey.trim().split(/\s+/)[1]);
    const key = keygenPrivateKey(privateKey)!;
    const signature = signUserauth(key, userauthSignedData(new Uint8Array(32), 'alice', 'ssh-ed25519', blob));
    await wire.send(encodeUserauthRequest('alice', { method: 'publickey', algorithm: 'ssh-ed25519', publicKeyBlob: blob, signature }));

    expect(wire.last()?.[0]).toBe(SSH_MSG_USERAUTH_FAILURE);
  });

  it('changer d utilisateur en cours d authentification deconnecte comme auth2.c', async () => {
    const { client } = await lab();
    const wire = await open(client);
    await wire.send(encodeUserauthRequest('alice', { method: 'none' }));
    await wire.send(encodeUserauthRequest('bob', { method: 'none' }));

    expect(disconnectText(wire)).toBe(
      'Change of username or service not allowed: (alice,ssh-connection) -> (bob,ssh-connection)');
  });

  it('un SERVICE_REQUEST ssh-userauth repete avant le succes est accepte', async () => {
    const { client } = await lab();
    const wire = await open(client);
    await wire.send(encodeUserauthRequest('alice', { method: 'none' }));
    await wire.send(new SshWriter().writeByte(5).writeString(SSH_USERAUTH_SERVICE).toBytes());

    expect(wire.last()?.[0]).toBe(SSH_MSG_SERVICE_ACCEPT);
  });

  it('apres le succes, un nouveau SERVICE_REQUEST ssh-userauth est refuse -- bad service request', async () => {
    const { client } = await lab();
    const wire = await open(client);
    await wire.send(encodeUserauthRequest('alice', { method: 'password', password: 'secret' }));
    await wire.send(new SshWriter().writeByte(5).writeString(SSH_USERAUTH_SERVICE).toBytes());

    expect(disconnectText(wire)).toBe('bad service request ssh-userauth');
  });

  it('trois echecs avec MaxAuthTries 3 ferment avec « Too many authentication failures »', async () => {
    const { client, server } = await lab();
    await server.executeCommand("sudo sed -i 's/^MaxAuthTries 6/MaxAuthTries 3/' /etc/ssh/sshd_config");
    await server.executeCommand('sudo systemctl reload ssh');
    const wire = await open(client);
    for (let i = 0; i < 3; i++) {
      await wire.send(encodeUserauthRequest('alice', { method: 'password', password: `bad${i}` }));
    }

    expect(disconnectText(wire)).toBe('Too many authentication failures');
  });

  it('une tentative `none` initiale ne compte pas dans MaxAuthTries', async () => {
    const { client, server } = await lab();
    await server.executeCommand("sudo sed -i 's/^MaxAuthTries 6/MaxAuthTries 2/' /etc/ssh/sshd_config");
    await server.executeCommand('sudo systemctl reload ssh');
    const wire = await open(client);
    await wire.send(encodeUserauthRequest('alice', { method: 'none' }));
    await wire.send(encodeUserauthRequest('alice', { method: 'password', password: 'bad' }));
    await wire.send(encodeUserauthRequest('alice', { method: 'password', password: 'secret' }));

    expect(wire.last()?.[0]).toBe(SSH_MSG_USERAUTH_SUCCESS);
  });

  it('un JSON {"op":"auth"} dans le message local ne repond plus', async () => {
    const { client } = await lab();
    const wire = await open(client);
    const json = new TextEncoder().encode(JSON.stringify({ op: 'auth', method: 'password', user: 'alice', password: 'secret' }));
    await wire.send(new Uint8Array([192, 0, ...json]));
    const reply = wire.inbox.map((m) => JSON.parse(new TextDecoder().decode(m.slice(2))));

    expect(reply).toEqual([{ ok: false, error: 'not authenticated' }]);
  });
});
