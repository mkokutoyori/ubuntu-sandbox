/**
 * Tuto NAT, NAT dynamique (pool, pool overload, interface overload) : coherence des translations
 * entre protocoles et clients.
 *
 * Mesure avant correction (8 cas, 7 tombent ; le temoin passe) : une adresse de pool epuisee laissait passer le
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
});
