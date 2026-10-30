/**
 * `ipset` (ipset 7.15 : lib/session.c pour le listage, lib/errcode.c pour les erreurs, tests/hash:ip.t, hash:net.t, hash:ip,port.t et leurs
 * `.list*` pour les attendus) et `iptables -m set` / `-j SET` (libxt_set.c, libxt_SET.c).
 *
 * Mesure de depart : `ipset` etait « command not found » et `-m set` etait refuse.
 *
 * Choix assumes : « Size in memory » est une approximation (le noyau l'obtient de ses allocations), `initval` est derive du nom ; les
 * compteurs, skbinfo et les types hors hash:ip, hash:net, hash:ip,port ne sont pas construits et sont refuses en le disant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { LinuxIptablesManager, PacketInfo } from '@/network/devices/linux/LinuxIptablesManager';

interface Firewalled { executor: { iptables: LinuxIptablesManager } }

let host: LinuxPC;
const run = (command: string): Promise<string> => host.executeCommand(`sudo ${command}`);
const packet = (extra: Partial<PacketInfo> = {}): PacketInfo => ({
  direction: 'in', protocol: 6, srcIP: '10.0.0.2', dstIP: '10.0.0.1', srcPort: 40000, dstPort: 80, iface: 'eth0', ipPacketBytes: 60, ...extra,
});
const verdict = (extra: Partial<PacketInfo> = {}): string => (host as unknown as Firewalled).executor.iptables.filterPacket(packet(extra));

beforeEach(() => {
  host = new LinuxPC('H', 0, 0);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-03-04T10:30:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('create et list', () => {
  it('une table vide se liste comme lib/session.c list_create', async () => {
    expect(await run('ipset create test hash:ip')).toBe('');
    const lines = (await run('ipset list test')).split('\n');
    expect(lines.slice(0, 3)).toEqual(['Name: test', 'Type: hash:ip', 'Revision: 5']);
    expect(lines[3]).toMatch(/^Header: family inet hashsize 1024 maxelem 65536 bucketsize 12 initval 0x[0-9a-f]{8}$/);
    expect(lines[4]).toMatch(/^Size in memory: \d+$/);
    expect(lines.slice(5)).toEqual(['References: 0', 'Number of entries: 0', 'Members:']);
  });

  it('les options de creation figurent dans l\'ordre du type', async () => {
    await run('ipset create t hash:ip hashsize 128 maxelem 100 netmask 24 timeout 4');
    expect((await run('ipset list t')).split('\n')[3]).toMatch(/^Header: family inet hashsize 128 maxelem 100 netmask 24 timeout 4 bucketsize 12 initval /);
  });

  it('hash:net et hash:ip,port ont leurs revisions', async () => {
    await run('ipset create n hash:net');
    await run('ipset create p hash:ip,port family inet6');
    expect((await run('ipset list n')).split('\n')[2]).toBe('Revision: 7');
    const port = (await run('ipset list p')).split('\n');
    expect(port[2]).toBe('Revision: 6');
    expect(port[3]).toMatch(/^Header: family inet6 /);
  });

  it('creer deux fois le meme nom est refuse dans les mots de errcode.c', async () => {
    await run('ipset create test hash:ip');
    expect(await run('ipset create test hash:ip')).toBe('ipset v7.15: Set cannot be created: set with the same name already exists');
    expect(await run('ipset create -exist test hash:ip')).toBe('');
  });

  it('list -n donne les noms, list sans nom donne tous les ensembles', async () => {
    await run('ipset create b hash:ip');
    await run('ipset create a hash:net');
    expect(await run('ipset list -n')).toBe('b\na');
    expect((await run('ipset list')).match(/^Name: /gm)).toHaveLength(2);
  });

  it('un type inconnu et un ensemble absent', async () => {
    expect(await run('ipset create x hash:zorglub')).toContain('Unknown set type');
    expect(await run('ipset list absent')).toBe('ipset v7.15: The set with the given name does not exist');
  });
});

describe('add, test, del', () => {
  beforeEach(async () => { await run('ipset create test hash:ip'); });

  it('ajouter, tester, supprimer', async () => {
    expect(await run('ipset add test 192.168.1.5')).toBe('');
    expect(await run('ipset test test 192.168.1.5')).toBe('Warning: 192.168.1.5 is in set test.');
    expect(await run('ipset test test 192.168.1.6')).toBe('192.168.1.6 is NOT in set test.');
    expect(await run('ipset del test 192.168.1.5')).toBe('');
    expect(await run('ipset test test 192.168.1.5')).toBe('192.168.1.5 is NOT in set test.');
  });

  it('les codes de sortie : test absent et del absent valent 1', async () => {
    expect(await host.executeCommand('sudo ipset test test 1.1.1.1; echo code=$?')).toContain('code=1');
    expect(await host.executeCommand('sudo ipset add test 1.1.1.1; echo code=$?')).toContain('code=0');
    expect(await host.executeCommand('sudo ipset test test 1.1.1.1; echo code=$?')).toContain('code=0');
  });

  it('les doublons et les absents sont refuses, -exist les accepte', async () => {
    await run('ipset add test 1.1.1.1');
    expect(await run('ipset add test 1.1.1.1')).toBe("ipset v7.15: Element cannot be added to the set: it's already added");
    expect(await run('ipset add -exist test 1.1.1.1')).toBe('');
    expect(await run('ipset del test 2.2.2.2')).toBe("ipset v7.15: Element cannot be deleted from the set: it's not added");
    expect(await run('ipset del -exist test 2.2.2.2')).toBe('');
  });

  it('une plage et un CIDR ajoutent plusieurs elements', async () => {
    await run('ipset add test 1.1.1.1-1.1.1.5');
    expect(await run('ipset test test 1.1.1.3')).toContain('is in set');
    await run('ipset del test 1.1.1.2-1.1.1.5');
    expect(await run('ipset test test 1.1.1.2')).toContain('NOT in set');
    await run('ipset add test 10.0.0.0/30');
    expect((await run('ipset list test')).match(/^Number of entries: (\d+)$/m)?.[1]).toBe('5');
  });

  it('une adresse invalide est une erreur de syntaxe', async () => {
    expect(await run('ipset add test zorglub')).toContain("Syntax error: cannot parse zorglub: resolving to IPv4 address failed");
  });

  it('le netmask du type regroupe les adresses', async () => {
    await run('ipset create m hash:ip netmask 24');
    await run('ipset add m 200.100.10.99');
    expect(await run('ipset test m 200.100.10.1')).toContain('is in set');
    expect((await run('ipset list m')).split('\n').slice(-1)[0]).toBe('200.100.10.0');
  });

  it('maxelem plein : Hash is full', async () => {
    await run('ipset create f hash:ip maxelem 1');
    await run('ipset add f 1.1.1.1');
    expect(await run('ipset add f 1.1.1.2')).toBe('ipset v7.15: Hash is full, cannot add more elements');
  });
});

describe('timeout', () => {
  it('l\'element expire, le delai restant se liste', async () => {
    await run('ipset create t hash:ip timeout 4');
    await run('ipset add t 2.0.0.1');
    await run('ipset add t 192.168.68.69 timeout 0');
    vi.setSystemTime(new Date('2024-03-04T10:30:00.500Z'));
    const members = (await run('ipset list t')).split('\n');
    expect(members).toContain('2.0.0.1 timeout 3');
    expect(members).toContain('192.168.68.69 timeout 0');
    vi.setSystemTime(new Date('2024-03-04T10:30:05Z'));
    const later = (await run('ipset list t')).split('\n');
    expect(later).not.toContain('2.0.0.1 timeout 3');
    expect(later).toContain('192.168.68.69 timeout 0');
    expect(later).toContain('Number of entries: 1');
  });

  it('timeout sur un ensemble cree sans', async () => {
    await run('ipset create t hash:ip');
    expect(await run('ipset add t 1.1.1.1 timeout 4')).toBe('ipset v7.15: Timeout cannot be used: set was created without timeout support');
  });
});

describe('hash:net et hash:ip,port', () => {
  it('hash:net teste l\'appartenance par prefixe', async () => {
    await run('ipset create n hash:net');
    await run('ipset add n 192.168.68.69/27');
    expect(await run('ipset test n 192.168.68.65')).toContain('is in set');
    expect(await run('ipset test n 192.168.68.200')).toContain('NOT in set');
    expect((await run('ipset list n')).split('\n').slice(-1)[0]).toBe('192.168.68.64/27');
  });

  it('hash:ip,port : port par numero, par nom, avec protocole', async () => {
    await run('ipset create p hash:ip,port');
    await run('ipset add p 2.0.0.1,5');
    await run('ipset add p 2.1.0.3,smtp');
    await run('ipset add p 2.1.0.4,udp:53');
    expect(await run('ipset test p 2.1.0.3,25')).toContain('is in set');
    expect(await run('ipset test p 2.1.0.3,tcp:25')).toContain('is in set');
    expect(await run('ipset test p 2.1.0.3,udp:25')).toContain('NOT in set');
    const members = (await run('ipset list p')).split('\n');
    expect(members).toContain('2.0.0.1,tcp:5');
    expect(members).toContain('2.1.0.4,udp:53');
  });
});

describe('save, restore, flush, destroy, rename, swap', () => {
  it('save ecrit des lignes create et add que restore relit', async () => {
    await run('ipset create s hash:ip timeout 0');
    await run('ipset add s 1.1.1.1');
    const saved = await run('ipset save');
    expect(saved).toMatch(/^create s hash:ip family inet hashsize 1024 maxelem 65536 timeout 0 bucketsize 12 initval 0x[0-9a-f]{8}$/m);
    expect(saved).toContain('add s 1.1.1.1 timeout 0');
    await run('ipset destroy s');
    await host.executeCommand(`sh -c 'cat > /tmp/dump <<'"'"'EOF'"'"'\n${saved}\nEOF'`);
    expect(await host.executeCommand('sudo ipset restore < /tmp/dump')).toBe('');
    expect(await run('ipset test s 1.1.1.1')).toContain('is in set');
  });

  it('flush vide, destroy supprime', async () => {
    await run('ipset create s hash:ip');
    await run('ipset add s 1.1.1.1');
    await run('ipset flush s');
    expect((await run('ipset list s')).match(/^Number of entries: (\d+)$/m)?.[1]).toBe('0');
    await run('ipset destroy s');
    expect(await run('ipset list s')).toContain('The set with the given name does not exist');
  });

  it('rename et swap', async () => {
    await run('ipset create a hash:ip');
    await run('ipset create b hash:ip');
    await run('ipset add a 1.1.1.1');
    expect(await run('ipset rename a c')).toBe('');
    expect(await run('ipset rename c b')).toBe('ipset v7.15: Set cannot be renamed: a set with the new name already exists');
    expect(await run('ipset swap c b')).toBe('');
    expect(await run('ipset test b 1.1.1.1')).toContain('is in set');
    await run('ipset create n hash:net');
    expect(await run('ipset swap b n')).toBe('ipset v7.15: The sets cannot be swapped: their type does not match');
  });

  it('version', async () => {
    expect(await run('ipset version')).toBe('ipset v7.15, protocol version: 7');
  });
});

describe('iptables -m set et -j SET', () => {
  it('-m set --match-set decide sur l\'adresse source ou destination', async () => {
    await run('ipset create bad hash:ip');
    await run('ipset add bad 10.0.0.2');
    expect(await run('iptables -A INPUT -m set --match-set bad src -j DROP')).toBe('');
    expect(verdict()).toBe('drop');
    expect(verdict({ srcIP: '10.0.0.9' })).toBe('accept');
  });

  it('dst, et « ! » inverse', async () => {
    await run('ipset create srv hash:ip');
    await run('ipset add srv 10.0.0.1');
    await run('iptables -A INPUT -m set ! --match-set srv dst -j DROP');
    expect(verdict()).toBe('accept');
    expect(verdict({ dstIP: '10.0.0.77' })).toBe('drop');
  });

  it('hash:ip,port : src,dst compare l\'adresse source et le port de destination', async () => {
    await run('ipset create pp hash:ip,port');
    await run('ipset add pp 10.0.0.2,tcp:80');
    await run('iptables -A INPUT -m set --match-set pp src,dst -j DROP');
    expect(verdict()).toBe('drop');
    expect(verdict({ dstPort: 81 })).toBe('accept');
    expect(verdict({ protocol: 17 })).toBe('accept');
  });

  it('hash:net : un paquet dans le reseau correspond', async () => {
    await run('ipset create nets hash:net');
    await run('ipset add nets 10.0.0.0/24');
    await run('iptables -A INPUT -m set --match-set nets src -j DROP');
    expect(verdict({ srcIP: '10.0.0.200' })).toBe('drop');
    expect(verdict({ srcIP: '10.0.1.1' })).toBe('accept');
  });

  it('-j SET --add-set ajoute l\'adresse du paquet, --del-set la retire', async () => {
    await run('ipset create seen hash:ip');
    await run('iptables -A INPUT -j SET --add-set seen src');
    verdict();
    expect(await run('ipset test seen 10.0.0.2')).toContain('is in set');
    await run('iptables -F');
    await run('iptables -A INPUT -j SET --del-set seen src');
    verdict();
    expect(await run('ipset test seen 10.0.0.2')).toContain('NOT in set');
  });

  it('se liste comme print_match / print_target et compte une reference', async () => {
    await run('ipset create bad hash:ip,port');
    await run('iptables -A INPUT -m set --match-set bad src,dst -j DROP');
    expect((await run('iptables -L INPUT -n')).split('\n')[2]).toContain('match-set bad src,dst');
    expect((await run('ipset list bad')).match(/^References: (\d+)$/m)?.[1]).toBe('1');
    expect(await run('ipset destroy bad')).toBe('ipset v7.15: Set cannot be destroyed: it is in use by a kernel component');
  });

  it('-S et iptables-save ecrivent les arguments sans guillemets', async () => {
    await run('ipset create seen hash:ip');
    await run('iptables -A INPUT -m set ! --match-set seen src -j DROP');
    await run('iptables -A INPUT -j SET --add-set seen src --exist --timeout 30');
    const rules = (await run('iptables -S INPUT')).split('\n');
    expect(rules).toContain('-A INPUT -m set ! --match-set seen src -j DROP');
    expect(rules).toContain('-A INPUT -j SET --add-set seen src --exist --timeout 30');
  });

  it('un ensemble absent est refuse, une regle sans --match-set aussi', async () => {
    expect(await run('iptables -A INPUT -m set --match-set nothere src -j DROP')).toContain("Set nothere doesn't exist");
    expect(await run('iptables -A INPUT -m set -j DROP')).toContain("You must specify `--match-set' with proper arguments");
  });
});
