/**
 * Tuto NAT, NAT dynamique (pool, pool overload, interface overload) : coherence des translations
 * entre protocoles et clients.
 *
 * Mesure avant correction (11 cas, 10 tombent ; le temoin passe)
 * Troisieme passe : l'entree de couple d'adresses ouvre aussi l'acces depuis l'exterieur (dernier cas).
 * Seconde passe (3 cas avant l'avant-dernier, 3 tombent) : `Translation errors` figé a 0, `ip nat translation timeout` pose aussi tcp/udp/icmp, et la forme verbose omettait les lignes statiques de la forme simple : une adresse de pool epuisee laissait passer le
 * paquet NON traduit au lieu de le jeter (le routeur repondait pourtant « Misses » ; le client
 * recevait la reponse de l'hote exterieur avec son adresse privee) ; une connexion TCP terminee
 * gardait 24 h de vie au lieu des 60 s de `finrst-timeout` ; un echange DNS (UDP/53) vivait 300 s
 * au lieu des 60 s de `dns-timeout` ; le ping Windows et `hping3 --icmp` changeaient
 * d'identifiant ICMP a chaque echo, donc ouvraient une translation par paquet ; la NAT dynamique
 * sans surcharge ne creait pas l'entree de couple d'adresses (`--- global local --- ---`) que
 * l'IOS maintient 24 h, de sorte que l'adresse du pool etait rendue des la fin du dernier flux et
 * que « allocated » du pool retombait a 0 entre deux echanges.
 *
 * Temoins qui passent avant comme apres : le ping Linux (un seul identifiant) traverse le pool, et
 * un hote qui obtient une adresse du pool atteint EXT.
 */
import { describe, it, expect } from 'vitest';
import { tutoNatLab } from './_helpers/tutoNatLab';

const POOL_ONE = ['ip nat pool P1 203.0.113.4 203.0.113.4 netmask 255.255.255.240', 'ip nat inside source list 1 pool P1'];
const POOL_ONE_PAT = ['ip nat pool P1 203.0.113.4 203.0.113.4 netmask 255.255.255.240', 'ip nat inside source list 1 pool P1 overload'];
const received = (out: string) => Number(/Received = (\d+)/.exec(out)?.[1] ?? '0');
const rows = (out: string, proto: string) => out.split('\n').filter(l => l.startsWith(proto));

describe('dynamic NAT coherence', () => {
  it('witness: a Linux host reaches EXT through the pool and is translated', async () => {
    const { r, lin } = await tutoNatLab(POOL_ONE);
    expect(await lin.executeCommand('ping -c 1 203.0.113.9')).toContain('1 received');
    expect(rows(await r.executeCommand('show ip nat translations'), 'icmp')).toHaveLength(1);
  });

  it('drops and refuses the packet of a second host when the pool is exhausted', async () => {
    const { win, lin } = await tutoNatLab(POOL_ONE);
    expect(await lin.executeCommand('ping -c 1 203.0.113.9')).toContain('1 received');
    const out = await win.executeCommand('ping -n 1 203.0.113.9');
    expect(received(out)).toBe(0);
    expect(out).toContain('Destination host unreachable');
  });

  it('does not let the exhausted host through with TCP either', async () => {
    const { lin, win } = await tutoNatLab(POOL_ONE);
    await lin.executeCommand('ping -c 1 203.0.113.9');
    expect(await win.executeCommand('powershell Test-NetConnection 203.0.113.9 -Port 80')).toMatch(/TcpTestSucceeded\s*:\s*False/);
  });

  it('keeps the address pair entry of a host after its flows have expired', async () => {
    const { r, lin, win } = await tutoNatLab(POOL_ONE);
    await lin.executeCommand('ping -c 1 203.0.113.9');
    const shown = await r.executeCommand('show ip nat translations');
    expect(rows(shown, '---')[0]).toMatch(/^---\s+203\.0\.113\.4\s+192\.168\.10\.22\s+---\s+---$/);
    r._getNATEngine().purgeStale(0);
    expect(rows(await r.executeCommand('show ip nat translations'), '---')).toHaveLength(1);
    expect(received(await win.executeCommand('ping -n 1 203.0.113.9'))).toBe(0);
  });

  it('counts the bound address in the pool and frees it with clear ip nat translation *', async () => {
    const { r, lin, win } = await tutoNatLab(POOL_ONE);
    await lin.executeCommand('ping -c 1 203.0.113.9');
    expect(await r.executeCommand('show ip nat statistics')).toMatch(/allocated 1 \(100%\)/);
    r._getNATEngine().purgeStale(0);
    expect(await r.executeCommand('show ip nat statistics')).toMatch(/allocated 1 \(100%\)/);
    await r.executeCommand('clear ip nat translation *');
    expect(await r.executeCommand('show ip nat statistics')).toMatch(/allocated 0 \(0%\)/);
    expect(received(await win.executeCommand('ping -n 1 203.0.113.9'))).toBe(1);
  });

  it('opens one translation for the four echoes of a Windows ping', async () => {
    const { r, win } = await tutoNatLab(POOL_ONE_PAT);
    expect(received(await win.executeCommand('ping 203.0.113.9'))).toBe(4);
    expect(rows(await r.executeCommand('show ip nat translations'), 'icmp')).toHaveLength(1);
  });

  it('opens one translation for the two echoes of hping3 --icmp', async () => {
    const { r, lin } = await tutoNatLab(POOL_ONE_PAT);
    expect(await lin.executeCommand('sudo hping3 --icmp -c 2 203.0.113.9')).toContain('2 packets received');
    expect(rows(await r.executeCommand('show ip nat translations'), 'icmp')).toHaveLength(1);
  });

  it('ages a closed TCP connection with the finrst-timeout and a DNS exchange with the dns-timeout', async () => {
    const { r, lin } = await tutoNatLab(POOL_ONE_PAT);
    await lin.executeCommand('curl -s -m 5 -o /dev/null http://203.0.113.9/');
    await lin.executeCommand('dig @203.0.113.9 example.com +time=1 +tries=1');
    const verbose = await r.executeCommand('show ip nat translations verbose');
    const left = (proto: string): string => {
      const at = verbose.split('\n').findIndex(l => l.startsWith(proto) && l.includes(proto === 'tcp' ? ':80 ' : ':53 '));
      return verbose.split('\n')[at + 1] ?? '';
    };
    expect(left('tcp')).toMatch(/left: 0d:00h:00m:\d\ds/);
    expect(left('udp')).toMatch(/left: 0d:00h:00m:\d\ds/);
  });

  it('counts a refused translation in Translation errors and resets it with clear ip nat statistics', async () => {
    const { r, lin, win } = await tutoNatLab(POOL_ONE);
    await lin.executeCommand('ping -c 1 203.0.113.9');
    expect(await r.executeCommand('show ip nat statistics')).toContain('Translation errors: 0');
    await win.executeCommand('ping -n 1 203.0.113.9');
    expect(await r.executeCommand('show ip nat statistics')).toContain('Translation errors: 1');
    await r.executeCommand('clear ip nat statistics');
    expect(await r.executeCommand('show ip nat statistics')).toContain('Translation errors: 0');
  });

  it('applies ip nat translation timeout to the address pair entries only', async () => {
    const { r, lin } = await tutoNatLab([...POOL_ONE, 'ip nat translation timeout 5']);
    const timeouts = await r.executeCommand('show ip nat translations timeout');
    expect(timeouts).toContain('timeout: 5');
    expect(timeouts).toContain('tcp-timeout: 86400');
    expect(timeouts).toContain('icmp-timeout: 60');
    expect(await r.executeCommand('show running-config | section ip nat')).toContain('ip nat translation timeout 5');
    await lin.executeCommand('ping -c 1 203.0.113.9');
    const lines = (await r.executeCommand('show ip nat translations verbose')).split('\n');
    const pair = lines.findIndex(l => /^---\s+203\.0\.113\.4/.test(l));
    expect(lines[pair + 1]).toMatch(/left: 0d:00h:00m:0\ds/);
    const echo = lines.findIndex(l => l.startsWith('icmp'));
    expect(lines[echo + 1]).toMatch(/left: 0d:00h:00m:[56]\ds/);
  });

  it('renders the outside static entries in the verbose form as in the plain one', async () => {
    const { r } = await tutoNatLab(['ip nat outside source static 198.51.100.77 10.9.9.9']);
    expect(await r.executeCommand('show ip nat translations')).toContain('198.51.100.77');
    expect(await r.executeCommand('show ip nat translations verbose')).toContain('198.51.100.77');
  });

  it('lets the outside reach an inside host through its bound pool address, and only while the binding lasts', async () => {
    const { r, isp, lin } = await tutoNatLab(POOL_ONE);
    const sent = (out: string) => /Success rate is (\d+) percent/.exec(out)?.[1];
    expect(sent(await isp.executeCommand('ping 203.0.113.4'))).toBe('0');
    await lin.executeCommand('ping -c 1 203.0.113.9');
    expect(sent(await isp.executeCommand('ping 203.0.113.4'))).toBe('100');
    await r.executeCommand('clear ip nat translation *');
    expect(sent(await isp.executeCommand('ping 203.0.113.4'))).toBe('0');
  });
});
