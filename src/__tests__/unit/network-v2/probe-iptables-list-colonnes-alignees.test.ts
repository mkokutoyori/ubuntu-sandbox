/**
 * `iptables -L` aligne ses colonnes comme le C de iptables 1.8.7 (variante nft, celle d'Ubuntu) : iptables/nft-shared.c `print_header` et
 * `print_rule_details`, iptables/nft-ipv4.c `print_fragment`, iptables/xshared.c `print_ifaces` et `print_ipv4_addresses`, libxtables
 * `xtables_print_num`. Chaque ligne attendue ci-dessous est ecrite par ces printf (`%-4u `, `%5llu `, `%-9s `, `%-5s`, ` %-6s `,
 * ` %-19s `), blancs de fin compris : le vrai iptables les laisse.
 *
 * Mesure de depart : l'adresse de destination n'etait pas calee (la ligne finissait au dernier caractere), le `!` d'une adresse
 * negative etait compte DANS la colonne, un nom d'interface absent s'ecrivait `*` hors `-n` (le C ecrit `any`), et aucune ligne ne
 * portait les blancs de fin.
 *
 * Discrimination : voir le message du commit (nombre de cas qui tombent avant le correctif, et les temoins qui passent des deux cotes).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

let srv: LinuxServer;

async function list(options: string, chain = 'INPUT'): Promise<string[]> {
  return (await srv.executeCommand(`iptables -L ${chain} ${options}`)).split('\n');
}

beforeEach(async () => {
  srv = new LinuxServer('linux-server', 'srv', 0, 0);
  srv.powerOn();
  await srv.executeCommand('iptables -F');
});

describe('sans option', () => {
  it('l\'en-tete est « target prot opt source destination » aux largeurs du C', async () => {
    const out = await list('');
    expect(out[0]).toBe('Chain INPUT (policy ACCEPT)');
    expect(out[1]).toBe('target     prot opt source               destination         ');
  });

  it('une ligne cale la source ET la destination', async () => {
    await srv.executeCommand('iptables -A INPUT -p tcp -s 10.0.0.0/24 -j DROP');
    const out = await list('');
    expect(out[2]).toBe('DROP       tcp  --  10.0.0.0/24          anywhere            ');
  });

  it('une adresse inversee met le « ! » dans la colonne de l\'inversion', async () => {
    await srv.executeCommand('iptables -A INPUT ! -s 10.0.0.1 -j DROP');
    const out = await list('');
    expect(out[2]).toBe('DROP       all  -- !10.0.0.1             anywhere            ');
  });

  it('un nom de cible plus long que la colonne pousse la suite sans rien tronquer', async () => {
    await srv.executeCommand('iptables -N MY_LONG_CHAIN_X');
    await srv.executeCommand('iptables -A INPUT -j MY_LONG_CHAIN_X');
    const out = await list('');
    expect(out[2]).toBe('MY_LONG_CHAIN_X  all  --  anywhere             anywhere            ');
  });
});

describe('-n', () => {
  it('ecrit 0.0.0.0/0 et garde les criteres a la suite', async () => {
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
    const out = await list('-n');
    expect(out[2]).toBe('DROP       tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:22');
  });
});

describe('-v', () => {
  it('l\'en-tete porte pkts, bytes, in et out', async () => {
    const out = await list('-v');
    expect(out[1]).toBe(' pkts bytes target     prot opt in     out     source               destination         ');
  });

  it('une interface absente s\'ecrit « any » et non « * »', async () => {
    await srv.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
    const out = await list('-v');
    expect(out[2]).toBe('    0     0 ACCEPT     all  --  lo     any     anywhere             anywhere            ');
  });

  it('avec -n elle s\'ecrit « * »', async () => {
    await srv.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
    const out = await list('-vn');
    expect(out[2]).toBe('    0     0 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0           ');
  });

  it('la politique porte les compteurs de la chaine', async () => {
    expect((await list('-v'))[0]).toBe('Chain INPUT (policy ACCEPT 0 packets, 0 bytes)');
  });
});

describe('-x', () => {
  it('l\'en-tete est a 8 et 10 colonnes, les donnees a 8 et 8 comme xtables_print_num', async () => {
    await srv.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
    const out = await list('-vx');
    expect(out[1]).toBe('    pkts      bytes target     prot opt in     out     source               destination         ');
    expect(out[2]).toBe('       0        0 ACCEPT     all  --  lo     any     anywhere             anywhere            ');
  });
});

describe('--line-numbers', () => {
  it('« num » et le rang tiennent sur 4 colonnes plus un blanc', async () => {
    await srv.executeCommand('iptables -A INPUT ! -s 10.0.0.1 -j DROP');
    const out = await list('--line-numbers');
    expect(out[1]).toBe('num  target     prot opt source               destination         ');
    expect(out[2]).toBe('1    DROP       all  -- !10.0.0.1             anywhere            ');
  });
});

describe('la cible MARK (libxt_MARK.c, mark_tg_print : toujours en hexadecimal)', () => {
  const listed = async (option: string): Promise<string> => {
    await srv.executeCommand(`iptables -t mangle -A PREROUTING -j MARK ${option}`);
    return (await srv.executeCommand('iptables -t mangle -L PREROUTING -n')).split('\n')[2];
  };

  it.each([
    ['--set-mark 5', 'MARK set 0x5'],
    ['--set-mark 0x10', 'MARK set 0x10'],
    ['--or-mark 3', 'MARK or 0x3'],
    ['--and-mark 0xff', 'MARK and 0xff'],
    ['--xor-mark 6', 'MARK xor 0x6'],
    ['--set-xmark 0x1/0xf', 'MARK xset 0x1/0xf'],
  ])('%s est ecrit « %s »', async (option, text) => {
    expect(await listed(option)).toMatch(new RegExp(`${text.replace(/[/]/g, '\\/')}$`));
  });
});
