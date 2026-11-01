/**
 * `nc -x proxy[:port] [-X 4|5|connect] [-P user]` (netcat-openbsd 1.226, socks.c) : la connexion passe par un mandataire SOCKS4, SOCKS5 ou HTTP CONNECT.
 * Le simulateur la refusait (« this simulator cannot build proxy connections »). Les octets attendus et les messages ont ete RELEVES en lancant le vrai
 * `nc` 1.226 contre un mandataire Python qui consignait ce qu'il recevait : SOCKS5 = `05 01 00` puis `05 01 00 <atyp> <adresse> <port>` (atyp 1 pour une adresse IPv4
 * litterale, 4 pour IPv6, 3 + longueur + nom sinon : le nom n'est PAS resolu localement) ; SOCKS4 = `04 01 <port> <ipv4> 00` (le nom est resolu par le client, apres la
 * connexion au mandataire) ; CONNECT = `CONNECT h:p HTTP/1.0\r\n\r\n` (`[h]:p` pour IPv6). `-X 4A` est refuse par la version Debian (« unsupported proxy protocol »).
 * Les messages d'erreur de lecture annoncent « (n/3) » pour la reponse de methode de 2 octets, comme le source. Ports par defaut : 1080 (SOCKS), 3128 (CONNECT).
 * Reserve assumee : un mandataire HTTP qui repond 407 avec `-P` fait relire le mot de passe sur le terminal ; le simulateur n'a pas de terminal pour une commande et
 * repond « Unable to read proxy passphrase », ce que le vrai nc repond aussi sans tty (releve).
 *
 * Discrimine par `git stash` sur src/network : 38 des 40 cas tombent avant (le refus est general). TEMOINS : sans -x, une connexion directe arrive au serveur ; `-X 4A` etait deja refuse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

interface Step { readonly expect: number | 'http'; readonly reply: string; readonly close?: boolean }

const bytes = (...values: number[]): string => String.fromCharCode(...values);
const hex = (text: string): string => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const SOCKS5_OK: Step[] = [
  { expect: 3, reply: bytes(5, 0) },
  { expect: 'http', reply: bytes(5, 0, 0, 1, 0, 0, 0, 0, 0, 0) },
];
const SOCKS4_OK: Step[] = [{ expect: 9, reply: bytes(0, 0x5a, 0, 0, 0, 0, 0, 0) }];

async function lab(steps: readonly Step[], proxyPort = 1080) {
  const client = new LinuxPC('linux-pc', 'C');
  const proxy = new LinuxPC('linux-pc', 'S');
  client.powerOn();
  proxy.powerOn();
  new Cable('c').connect(client.getPort('eth0')!, proxy.getPort('eth0')!);
  await client.executeCommand('ifconfig eth0 192.168.1.1');
  await proxy.executeCommand('ifconfig eth0 192.168.1.2');
  const connections: string[][] = [];
  const stack = (proxy as unknown as { getTcpStack(): { listen(port: number, options: object): unknown } }).getTcpStack();
  stack.listen(proxyPort, {
    onAccept: (socket: { onData(h: (chunk: Uint8Array | string) => void): void; write(text: string): void; close(): void }) => {
      const seen: string[] = [];
      connections.push(seen);
      let step = 0;
      let pending = '';
      socket.onData((chunk) => {
        pending += typeof chunk === 'string' ? chunk : String.fromCharCode(...chunk);
        const current = steps[step];
        if (current === undefined) {
          seen.push(`after:${pending}`);
          pending = '';
          return;
        }
        const complete = current.expect === 'http' && !pending.startsWith('\x05') ? pending.endsWith('\r\n\r\n') : pending.length >= (current.expect === 'http' ? 10 : current.expect);
        if (!complete) return;
        seen.push(pending.startsWith('CONNECT') ? pending : hex(pending));
        pending = '';
        step++;
        if (current.reply !== '') socket.write(current.reply);
        if (current.close) socket.close();
      });
    },
  });
  const run = async (command: string): Promise<string> => String(await client.executeCommand(command)).trim();
  return { run, connections };
}

const HTTP_OK: Step[] = [{ expect: 'http', reply: 'HTTP/1.0 200 Connection established\r\nX-A: b\r\n\r\n' }];

describe('nc through a proxy', () => {
  it('WITNESS — without -x, nc dials the target itself', async () => {
    const { run, connections } = await lab([]);
    expect(await run('echo hi | nc -w 1 192.168.1.2 1080; echo rc=$?')).toBe('rc=0');
    expect(connections).toEqual([['after:hi\n']]);
  });

  it('SOCKS5 with an IPv4 literal sends the address, then the payload', async () => {
    const { run, connections } = await lab(SOCKS5_OK);
    expect(await run('printf "hello\\n" | nc -w 1 -x 192.168.1.2 10.1.2.3 80; echo rc=$?')).toBe('rc=0');
    expect(connections).toEqual([['050100', '050100010a0102030050', 'after:hello\n']]);
  });

  it('SOCKS5 with a name that does not resolve locally sends it as a domain', async () => {
    const { run, connections } = await lab(SOCKS5_OK);
    await run('printf "x" | nc -w 1 -x 192.168.1.2 example.invalid 443');
    expect(connections[0].slice(0, 2)).toEqual(['050100', '050100030f6578616d706c652e696e76616c696401bb']);
  });

  it('SOCKS5 sends localhost as a domain even when -n is given', async () => {
    const { run, connections } = await lab(SOCKS5_OK);
    await run('printf "x" | nc -n -w 1 -x 192.168.1.2 localhost 80');
    expect(connections[0][1]).toBe('05010003096c6f63616c686f73740050');
  });

  it('SOCKS5 with an IPv6 literal sends atyp 4', async () => {
    const { run, connections } = await lab([{ expect: 3, reply: bytes(5, 0) }, { expect: 'http', reply: bytes(5, 0, 0, 4, ...new Array(18).fill(0)) }]);
    await run('printf "x" | nc -w 1 -x 192.168.1.2 2001:db8::1 443');
    expect(connections[0][1]).toBe('0501000420010db800000000000000000000000101bb');
  });

  it('SOCKS5 refuses a host name longer than 255 bytes after the greeting', async () => {
    const { run, connections } = await lab(SOCKS5_OK);
    expect(await run(`nc -w 1 -x 192.168.1.2 ${'a'.repeat(256)}.invalid 80; echo rc=$?`)).toBe('nc: host name too long for SOCKS5\nrc=1');
    expect(connections).toEqual([['050100']]);
  });

  it('SOCKS5 reports a missing authentication method', async () => {
    const { run } = await lab([{ expect: 3, reply: bytes(5, 0xff) }]);
    expect(await run('nc -w 1 -x 192.168.1.2 10.1.2.3 80; echo rc=$?')).toBe('nc: authentication method negotiation failed\nrc=1');
  });

  it.each([
    [5, 'Connection refused'], [1, 'General SOCKS server failure'], [8, 'Address type not supported'], [0x77, 'Unknown error'],
  ])('SOCKS5 reply code %i is reported as %s', async (code, text) => {
    const { run } = await lab([{ expect: 3, reply: bytes(5, 0) }, { expect: 'http', reply: bytes(5, code, 0, 1, 0, 0, 0, 0, 0, 0) }]);
    expect(await run('nc -w 1 -x 192.168.1.2 10.1.2.3 80; echo rc=$?')).toBe(`nc: connection failed, SOCKSv5 error: ${text}\nrc=1`);
  });

  it('SOCKS5 rejects an unknown address type in the reply', async () => {
    const { run } = await lab([{ expect: 3, reply: bytes(5, 0) }, { expect: 'http', reply: bytes(5, 0, 0, 9) }]);
    expect(await run('nc -w 1 -x 192.168.1.2 10.1.2.3 80')).toBe('nc: connection failed, unsupported address type');
  });

  it('a proxy that closes at the greeting gives read failed (0/3)', async () => {
    const { run } = await lab([{ expect: 3, reply: '', close: true }]);
    expect(await run('nc -w 1 -x 192.168.1.2 10.1.2.3 80')).toBe('nc: read failed (0/3): Broken pipe');
  });

  it('a proxy that sends one byte of the method reply gives read failed (1/3)', async () => {
    const { run } = await lab([{ expect: 3, reply: bytes(5), close: true }]);
    expect(await run('nc -w 1 -x 192.168.1.2 10.1.2.3 80')).toBe('nc: read failed (1/3): Broken pipe');
  });

  it('a proxy that closes after the method gives read failed (0/4)', async () => {
    const { run } = await lab([{ expect: 3, reply: bytes(5, 0) }, { expect: 'http', reply: '', close: true }]);
    expect(await run('nc -w 1 -x 192.168.1.2 10.1.2.3 80')).toBe('nc: read failed (0/4): Broken pipe');
  });

  it('SOCKS4 sends the resolved IPv4 address and an empty user', async () => {
    const { run, connections } = await lab(SOCKS4_OK);
    await run('printf "hello\\n" | nc -w 1 -X 4 -x 192.168.1.2 10.1.2.3 80');
    expect(connections).toEqual([['040100500a01020300', 'after:hello\n']]);
  });

  it('SOCKS4 resolves localhost itself', async () => {
    const { run, connections } = await lab(SOCKS4_OK);
    await run('printf "x" | nc -w 1 -X 4 -x 192.168.1.2 localhost 80');
    expect(connections[0][0]).toBe('040100507f00000100');
  });

  it('SOCKS4 fails after connecting when the name does not resolve', async () => {
    const { run, connections } = await lab(SOCKS4_OK);
    expect(await run('nc -w 1 -X 4 -x 192.168.1.2 example.invalid 80; echo rc=$?'))
      .toBe('nc: getaddrinfo("example.invalid", "80"): Name or service not known\nrc=1');
    expect(connections).toEqual([[]]);
  });

  it('SOCKS4 refuses an IPv6 literal', async () => {
    const { run } = await lab(SOCKS4_OK);
    expect(await run('nc -w 1 -X 4 -x 192.168.1.2 2001:db8::1 80'))
      .toBe('nc: getaddrinfo("2001:db8::1", "80"): Address family for hostname not supported');
  });

  it.each([
    [0x5b, 'Request rejected or failed'], [0x5c, 'SOCKS server cannot connect to identd on the client'],
    [0x5d, 'Client program and identd report different user-ids'], [0x63, 'Unknown error'],
  ])('SOCKS4 reply code %i is reported as %s', async (code, text) => {
    const { run } = await lab([{ expect: 9, reply: bytes(0, code, 0, 0, 0, 0, 0, 0) }]);
    expect(await run('nc -w 1 -X 4 -x 192.168.1.2 10.1.2.3 80; echo rc=$?')).toBe(`nc: connection failed, SOCKSv4 error: ${text}\nrc=1`);
  });

  it('a SOCKS4 reply cut at two bytes gives read failed (2/8)', async () => {
    const { run } = await lab([{ expect: 9, reply: bytes(0, 0x5a), close: true }]);
    expect(await run('nc -w 1 -X 4 -x 192.168.1.2 10.1.2.3 80')).toBe('nc: read failed (2/8): Broken pipe');
  });

  it('CONNECT sends the request line and a blank line, then hands over the tunnel', async () => {
    const { run, connections } = await lab([{ expect: 'http', reply: 'HTTP/1.0 200 OK\r\n\r\nSERVER-DATA\n' }], 3128);
    expect(await run('printf "hello\\n" | nc -w 1 -X connect -x 192.168.1.2 example.invalid 443')).toBe('SERVER-DATA');
    expect(connections).toEqual([['CONNECT example.invalid:443 HTTP/1.0\r\n\r\n', 'after:hello\n']]);
  });

  it('CONNECT writes an IPv6 literal between brackets and accepts HTTP/1.1', async () => {
    const { run, connections } = await lab([{ expect: 'http', reply: 'HTTP/1.1 200 OK\r\n\r\n' }], 3128);
    await run('printf "x" | nc -w 1 -X CONNECT -x 192.168.1.2 2001:db8::1 443');
    expect(connections[0][0]).toBe('CONNECT [2001:db8::1]:443 HTTP/1.0\r\n\r\n');
  });

  it('CONNECT quotes the status line of a refusal', async () => {
    const { run } = await lab([{ expect: 'http', reply: 'HTTP/1.1 403 Forbidden\r\n\r\n' }], 3128);
    expect(await run('nc -w 1 -X connect -x 192.168.1.2 10.1.2.3 443; echo rc=$?')).toBe('nc: Proxy error: "HTTP/1.1 403 Forbidden"\nrc=1');
  });

  it('CONNECT refuses a host name with a blank before sending anything', async () => {
    const { run, connections } = await lab(HTTP_OK, 3128);
    expect(await run('nc -w 1 -X connect -x 192.168.1.2 "a b" 443')).toBe('nc: Invalid hostname');
    expect(connections).toEqual([[]]);
  });

  it('CONNECT without -P treats 407 as an ordinary error', async () => {
    const { run } = await lab([{ expect: 'http', reply: 'HTTP/1.0 407 Proxy Auth\r\n\r\n' }], 3128);
    expect(await run('nc -w 1 -X connect -x 192.168.1.2 10.1.2.3 80')).toBe('nc: Proxy error: "HTTP/1.0 407 Proxy Auth"');
  });

  it('CONNECT with -P retries on 407 and then cannot read a passphrase', async () => {
    const { run, connections } = await lab([{ expect: 'http', reply: 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n' }], 3128);
    expect(await run('nc -w 1 -X connect -P bob -x 192.168.1.2 10.1.2.3 443; echo rc=$?')).toBe('nc: Unable to read proxy passphrase\nrc=1');
    expect(connections.length).toBe(2);
    expect(connections[0][0]).toBe('CONNECT 10.1.2.3:443 HTTP/1.0\r\n\r\n');
  });

  it('CONNECT reports a proxy that closes before the status line', async () => {
    const { run } = await lab([{ expect: 'http', reply: '', close: true }], 3128);
    expect(await run('nc -w 1 -X connect -x 192.168.1.2 10.1.2.3 80')).toBe('nc: proxy read: Broken pipe');
  });

  it('CONNECT stops after 64 response headers', async () => {
    const { run } = await lab([{ expect: 'http', reply: `HTTP/1.0 200 OK\r\n${'X: y\r\n'.repeat(70)}\r\n` }], 3128);
    expect(await run('nc -w 1 -X connect -x 192.168.1.2 10.1.2.3 80')).toBe('nc: Too many proxy headers received');
  });

  it('-v names the destination, not the proxy', async () => {
    const { run } = await lab(SOCKS5_OK);
    expect(await run('nc -v -z -w 1 -x 192.168.1.2 10.1.2.3 80 2>&1')).toBe('Connection to 10.1.2.3 80 port [tcp/http] succeeded!');
  });

  it('-v names a host name as typed, without its address', async () => {
    const { run } = await lab(SOCKS5_OK);
    expect(await run('nc -v -z -w 1 -x 192.168.1.2 localhost 80 2>&1')).toBe('Connection to localhost 80 port [tcp/http] succeeded!');
  });

  it('a port range opens one proxy connection per port', async () => {
    const { run, connections } = await lab(SOCKS5_OK);
    await run('nc -z -w 1 -x 192.168.1.2 10.1.2.3 80-81');
    expect(connections.map((seen) => seen[1])).toEqual(['050100010a0102030050', '050100010a0102030051']);
  });

  it('a refused proxy names the proxy in -v, on its default SOCKS port', async () => {
    const { run } = await lab([], 9);
    expect(await run('nc -v -w 1 -x 192.168.1.2 10.1.2.3 80 2>&1; echo rc=$?'))
      .toBe('nc: connect to 192.168.1.2 port 1080 (tcp) failed: Connection refused\nrc=1');
  });

  it('a refused proxy uses 3128 by default with -X connect', async () => {
    const { run } = await lab([], 9);
    expect(await run('nc -v -w 1 -X connect -x 192.168.1.2 10.1.2.3 80 2>&1')).toBe('nc: connect to 192.168.1.2 port 3128 (tcp) failed: Connection refused');
  });

  it('an explicit proxy port is used', async () => {
    const { run, connections } = await lab(SOCKS5_OK, 9050);
    await run('nc -z -w 1 -x 192.168.1.2:9050 10.1.2.3 80');
    expect(connections.length).toBe(1);
  });

  it('an unknown proxy host fails with getaddrinfo on the proxy', async () => {
    const { run } = await lab([]);
    expect(await run('nc -v -w 1 -x nosuchproxy.invalid:1080 10.1.2.3 80; echo rc=$?'))
      .toBe('nc: getaddrinfo for host "nosuchproxy.invalid" port 1080: Name or service not known\nrc=1');
  });

  it('-X 4A is refused like the Debian build', async () => {
    const { run } = await lab([]);
    expect(await run('nc -X 4A -x 192.168.1.2 10.1.2.3 80')).toBe('nc: unsupported proxy protocol');
  });
});
