/**
 * Sonde — `RekeyLimit` declenche un VRAI re-echange de cles (RFC 4253 §9).
 *
 * Mesure de depart : `ssh -o RekeyLimit=1K` et `RekeyLimit 1G 1h` dans
 * `sshd_config` etaient acceptes, ranges, et ignores -- le transport ne
 * savait faire qu'UN echange de cles, et tout KEXINIT apres la mise en place
 * des cles repondait `key re-exchange is not supported` par une deconnexion.
 * Un client qui re-echange (cas reel de OpenSSH au-dela de ~2 Gio ou de
 * `RekeyLimit`) etait donc coupe.
 *
 * Mesure : `RekeyLimit.ts` et `SshTransport.rekey()` sont NOUVEAUX, le fichier
 * ne se charge pas sur la base (les 12 cas tombent). La discrimination reelle
 * est celle du client reel, eprouve HORS DEPOT contre `ssh` 8.9p1 compile : avec
 * `-oRekeyLimit=1K` et 400 Kio de sortie, le serveur recevait un KEXINIT en
 * cours de session et deconnectait ; apres, la session va au bout, octet pour
 * octet. TEMOINS (passent a l'identique par construction) : « sans limite, un
 * volume ordinaire ne declenche aucun re-echange » -- il prouve que le compteur
 * n'est pas declenche a tort -- et le cas de syntaxe de `parseRekeyLimit`.
 *
 * Autorites : RFC 4253 §9 (KEXINIT a tout moment ; entre l'envoi de KEXINIT et
 * celui de NEWKEYS, rien d'autre que les messages 1-19 hors SERVICE_*, 20-29 hors
 * KEXINIT, 30-49 ; l'identifiant de session reste celui du premier echange ;
 * numeros de sequence continus) ; sshd_config(5) / ssh_config(5) `RekeyLimit`
 * (taille puis duree, `default`, `none`). Les attendus sont ecrits en dur.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { parseRekeyLimit } from '@/network/protocols/ssh/transport/RekeyLimit';
import { parseSshArgs } from '@/terminal/sessions/sshArgs';
import { LinuxSshServerContext } from '@/network/protocols/ssh/server/LinuxSshServerContext';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { bytesToUtf8 } from '@/crypto/encoding';
import { lab } from './sshConnectionLab';

const SSH_MSG_KEXINIT = 20;
const SSH_MSG_NEWKEYS = 21;

interface Sent { role: 'client' | 'server'; type: number }

function observeKeyExchange(): Sent[] {
  const sent: Sent[] = [];
  const original = (SshTransport.prototype as unknown as { sendPacket(p: Uint8Array): void }).sendPacket;
  vi.spyOn(SshTransport.prototype as unknown as { sendPacket(p: Uint8Array): void }, 'sendPacket')
    .mockImplementation(function (this: SshTransport, payload: Uint8Array) {
      const role = (this as unknown as { config: { role: 'client' | 'server' } }).config.role;
      sent.push({ role, type: payload[0] });
      original.call(this, payload);
    });
  return sent;
}

const count = (sent: Sent[], type: number, role?: 'client' | 'server'): number =>
  sent.filter((s) => s.type === type && (role === undefined || s.role === role)).length;

afterEach(() => {
  vi.restoreAllMocks();
  __setDefaultScheduler(null);
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('parseRekeyLimit', () => {
  it('TEMOIN -- lit une taille puis une duree, comme sshd_config(5)', () => {
    expect(parseRekeyLimit('default none')).toEqual({ seconds: null });
    expect(parseRekeyLimit('1G')).toEqual({ bytes: 1073741824, seconds: null });
    expect(parseRekeyLimit('500M 1h')).toEqual({ bytes: 524288000, seconds: 3600 });
    expect(parseRekeyLimit('4K 90')).toEqual({ bytes: 4096, seconds: 90 });
    expect(parseRekeyLimit('none')).toEqual({ bytes: null, seconds: null });
    expect(parseRekeyLimit('1K 2d')).toEqual({ bytes: 1024, seconds: 172800 });
  });

  it('refuse ce qui n\'est ni taille ni duree', () => {
    expect(parseRekeyLimit('')).toBeNull();
    expect(parseRekeyLimit('bogus')).toBeNull();
    expect(parseRekeyLimit('1X')).toBeNull();
    expect(parseRekeyLimit('1G 1h extra')).toBeNull();
  });
});

describe('re-echange declenche par le volume', () => {
  it('TEMOIN -- sans limite, un volume ordinaire ne declenche aucun re-echange', async () => {
    const sent = observeKeyExchange();
    const { client, server } = await lab();
    const got: number[] = [];
    server.onChannelOpen('session', (incoming) => incoming.accept().onData((d) => got.push(d.length)));
    const channel = await client.openChannel('session');
    for (let i = 0; i < 200; i++) channel.write(new Uint8Array(1000));
    await flush();
    expect(got.reduce((a, b) => a + b, 0)).toBe(200000);
    expect(count(sent, SSH_MSG_KEXINIT)).toBe(2);
  });

  it('au-dela de la limite, un second echange complet a lieu et la session continue octet pour octet', async () => {
    const sent = observeKeyExchange();
    const { client, server, clientTransport } = await lab(
      {}, { client: { algorithms: { rekeyLimit: { bytes: 5000, seconds: null } } } });
    const received: string[] = [];
    server.onChannelOpen('session', (incoming) => incoming.accept().onData((d) => received.push(bytesToUtf8(d))));
    const channel = await client.openChannel('session');
    const sessionId = (clientTransport as unknown as { sessionId: Uint8Array }).sessionId;
    for (let i = 0; i < 40; i++) channel.write(new TextEncoder().encode(`block-${String(i).padStart(2, '0')}:${'x'.repeat(300)}|`));
    await flush();

    expect(count(sent, SSH_MSG_KEXINIT, 'client')).toBeGreaterThanOrEqual(2);
    expect(count(sent, SSH_MSG_KEXINIT, 'server')).toBeGreaterThanOrEqual(2);
    expect(count(sent, SSH_MSG_NEWKEYS, 'client')).toBeGreaterThanOrEqual(2);
    expect(received.join('')).toBe(
      Array.from({ length: 40 }, (_, i) => `block-${String(i).padStart(2, '0')}:${'x'.repeat(300)}|`).join(''));
    expect((clientTransport as unknown as { sessionId: Uint8Array }).sessionId).toBe(sessionId);
    expect(clientTransport.isOpen).toBe(true);
  });

  it('la limite du SERVEUR amorce le re-echange tout aussi bien', async () => {
    const sent = observeKeyExchange();
    const { client, server } = await lab(
      {}, { server: { algorithms: { rekeyLimit: { bytes: 3000, seconds: null } } } });
    const received: number[] = [];
    client.onChannelOpen('session', (incoming) => incoming.accept().onData((d) => received.push(d.length)));
    server.onChannelOpen('session', (incoming) => {
      const channel = incoming.accept();
      for (let i = 0; i < 30; i++) channel.write(new Uint8Array(400));
    });
    const channel = await client.openChannel('session');
    await flush();
    void channel;
    expect(count(sent, SSH_MSG_KEXINIT, 'server')).toBeGreaterThanOrEqual(2);
    expect(count(sent, SSH_MSG_KEXINIT, 'client')).toBeGreaterThanOrEqual(2);
  });
});

describe('re-echange demande a la main, sur un lien a delai (§9 : rien d\'autre que 1-49 entre KEXINIT et NEWKEYS)', () => {
  it('les messages emis pendant l\'echange sont retenus puis livres, dans l\'ordre, une fois', async () => {
    const { client, server, clientTransport } = await lab({}, { deferred: true });
    const received: string[] = [];
    server.onChannelOpen('session', (incoming) => incoming.accept().onData((d) => received.push(bytesToUtf8(d))));
    const channel = await client.openChannel('session');
    await flush();

    clientTransport.rekey();
    for (let i = 0; i < 20; i++) channel.write(`m${i};`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(received.join('')).toBe(Array.from({ length: 20 }, (_, i) => `m${i};`).join(''));
  });

  it('un KEXINIT du pair, recu en pleine session, est repondu par un echange complet', async () => {
    const sent = observeKeyExchange();
    const { client, server, serverTransport } = await lab();
    const got: string[] = [];
    server.onChannelOpen('session', (incoming) => incoming.accept().onData((d) => got.push(bytesToUtf8(d))));
    const before = count(sent, SSH_MSG_NEWKEYS);
    serverTransport.rekey();
    await flush();
    expect(count(sent, SSH_MSG_NEWKEYS)).toBe(before + 2);
    const channel = await client.openChannel('session');
    channel.write('apres');
    expect(got).toEqual(['apres']);
  });

  it('deux KEXINIT simultanes ne produisent qu\'un echange par cote', async () => {
    const sent = observeKeyExchange();
    const { clientTransport, serverTransport } = await lab({}, { deferred: true });
    await flush();
    const before = count(sent, SSH_MSG_KEXINIT);
    clientTransport.rekey();
    serverTransport.rekey();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(count(sent, SSH_MSG_KEXINIT)).toBe(before + 2);
    expect(clientTransport.isOpen && serverTransport.isOpen).toBe(true);
  });
});

describe('re-echange declenche par la duree', () => {
  it('apres `seconds` de temps virtuel, un nouvel echange part', async () => {
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const sent = observeKeyExchange();
    await lab({}, { client: { algorithms: { rekeyLimit: { bytes: null, seconds: 60 } } } });
    const before = count(sent, SSH_MSG_KEXINIT, 'client');
    scheduler.advance(59_000);
    expect(count(sent, SSH_MSG_KEXINIT, 'client')).toBe(before);
    scheduler.advance(2_000);
    expect(count(sent, SSH_MSG_KEXINIT, 'client')).toBe(before + 1);
  });
});

describe('RekeyLimit arrive jusqu\'au transport', () => {
  it('`ssh -o RekeyLimit=2K` : le client le range dans ses preferences de transport', () => {
    const parsed = parseSshArgs(['-o', 'RekeyLimit=2K', 'alice@10.0.0.2']);
    expect(parsed!.algorithms.rekeyLimit).toEqual({ bytes: 2048, seconds: null });
  });

  it('`RekeyLimit 4K 30m` dans sshd_config : la politique de transport du serveur', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/etc/ssh', 0o755, 0, 0);
    vfs.writeFile('/etc/ssh/sshd_config', 'RekeyLimit 4K 30m\n', 0, 0, 0o022);
    const context = new LinuxSshServerContext(vfs, new LinuxUserManager(vfs), 'srv', {});
    expect(context.transportPolicy()).toEqual({ algorithms: { rekeyLimit: { bytes: 4096, seconds: 1800 } } });
  });

  it('sans RekeyLimit dans sshd_config, aucune politique n\'est imposee', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/etc/ssh', 0o755, 0, 0);
    const context = new LinuxSshServerContext(vfs, new LinuxUserManager(vfs), 'srv', {});
    expect(context.transportPolicy().algorithms?.rekeyLimit).toEqual({ seconds: null });
  });
});
