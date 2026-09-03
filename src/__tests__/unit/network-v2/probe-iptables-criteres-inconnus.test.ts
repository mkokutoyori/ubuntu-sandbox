/**
 * Un module de correspondance qui n'existe pas ne rend pas la regle plus
 * permissive : il la refuse.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   iptables -m <module> [--option <valeur>] …
 *   iptables -p tcp --tcp-flags <masque> <compare>
 *            (SYN,ACK,FIN,RST,URG,PSH,ALL,NONE)
 *   iptables -t nat -j SNAT --to-source <adresse>[-<adresse>][:port]
 *   iptables -t nat -j DNAT --to-destination <adresse>…
 *
 * Mesure de depart sur un hote Linux, en root :
 *
 *   iptables -A INPUT -m zorglub -j ACCEPT           -> ACCEPTE, MUET
 *   iptables -A INPUT -p tcp --tcp-flags zorglub SYN -j ACCEPT
 *                                                    -> ACCEPTE, MUET
 *   iptables -t nat -A POSTROUTING -j SNAT --to-source zorglub
 *                                                    -> ACCEPTE, MUET
 *
 * LE PREMIER EST UN DEFAUT DE POSTURE, pas d'affichage, et c'est ce qui
 * le rend grave. `matchesRule` ne connait que `multiport`, `limit`,
 * `state`, `conntrack`, `mac` et `iprange` : un module qu'elle ne
 * reconnait pas est simplement SAUTE, donc le critere ne restreint rien
 * et la regle correspond a PLUS de trafic que ce que l'operateur a
 * ecrit. C'est exactement l'inverse de la regle que ce depot s'est
 * donnee — « in any matching engine, a criterion the engine cannot
 * decide must fail the match » — et une faute de frappe dans
 * `-m conntrack` ouvre donc silencieusement la regle qu'elle devait
 * fermer.
 *
 * Le vrai iptables refuse a la SAISIE (`Couldn't load match`), ce qui est
 * mieux encore : la regle n'entre jamais dans la chaine.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, mesure plutot que
 * suppose : que `-i zorglub` soit refuse. Une interface qui n'existe pas
 * encore est LEGITIME dans une regle iptables — les interfaces
 * apparaissent et disparaissent, et le vrai iptables accepte le nom sans
 * le resoudre. Un cas de non-regression l'epingle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = { executeCommand(c: string): Promise<string> };

const hote = (n: string) => new LinuxPC(n) as unknown as Dev;

const sudo = (d: Dev, cmd: string) => d.executeCommand(`sudo ${cmd}`).then(String);

const cle = (s: string) => s.replace(/\W/g, '');

describe('un module de correspondance inconnu est refuse', () => {
  it.each(['zorglub', 'conntrak', 'statee'])('`-m %s` est refuse', async (mod) => {
    const d = hote(`M${cle(mod)}`);
    expect(await sudo(d, `iptables -A INPUT -m ${mod} -j ACCEPT`))
      .toMatch(/Couldn't load match/);
  });

  it('et la regle n entre PAS dans la chaine', async () => {
    const d = hote('MR');
    await sudo(d, 'iptables -A INPUT -m zorglub -j ACCEPT');
    expect(await sudo(d, 'iptables -S')).not.toContain('zorglub');
  });

  it.each(['state --state NEW', 'conntrack --ctstate NEW', 'multiport --dports 22,80',
    'limit --limit 5/min', 'mac --mac-source 00:11:22:33:44:55',
    'iprange --src-range 10.0.0.1-10.0.0.9', 'comment --comment ok',
    'tcp --dport 22'])('`-m %s` reste accepte', async (reste) => {
    const d = hote(`MO${cle(reste)}`);
    const proto = reste.startsWith('tcp') ? '-p tcp ' : '';
    expect(await sudo(d, `iptables -A INPUT ${proto}-m ${reste} -j ACCEPT`))
      .not.toMatch(/Couldn't load match/);
  });
});

describe('un drapeau TCP est l un des huit', () => {
  it.each(['zorglub', 'SYNC'])('`--tcp-flags %s SYN` est refuse', async (f) => {
    const d = hote(`F${cle(f)}`);
    expect(await sudo(d, `iptables -A INPUT -p tcp --tcp-flags ${f} SYN -j ACCEPT`))
      .toMatch(/Bad TCP flags/);
  });

  it('`--tcp-flags SYN,ACK zorglub` est refuse aussi', async () => {
    const d = hote('F2');
    expect(await sudo(d, 'iptables -A INPUT -p tcp --tcp-flags SYN,ACK zorglub -j ACCEPT'))
      .toMatch(/Bad TCP flags/);
  });

  it('et rien n en reste dans la chaine', async () => {
    const d = hote('F3');
    await sudo(d, 'iptables -A INPUT -p tcp --tcp-flags zorglub SYN -j ACCEPT');
    expect(await sudo(d, 'iptables -S')).not.toContain('zorglub');
  });

  it.each(['SYN,ACK,FIN,RST SYN', 'ALL SYN', 'ALL NONE'])(
    '`--tcp-flags %s` reste accepte', async (f) => {
      const d = hote(`FO${cle(f)}`);
      expect(await sudo(d, `iptables -A INPUT -p tcp --tcp-flags ${f} -j ACCEPT`))
        .not.toMatch(/Bad TCP flags/);
    });
});

describe('une adresse de traduction est une adresse', () => {
  it.each(['--to-source', '--to-destination'])('`%s zorglub` est refuse', async (opt) => {
    const d = hote(`N${cle(opt)}`);
    const cible = opt === '--to-source' ? 'POSTROUTING -j SNAT' : 'PREROUTING -j DNAT';
    expect(await sudo(d, `iptables -t nat -A ${cible} ${opt} zorglub`))
      .toMatch(/Bad IP address/);
  });

  it('et rien n en reste dans la table nat', async () => {
    const d = hote('NR');
    await sudo(d, 'iptables -t nat -A POSTROUTING -j SNAT --to-source zorglub');
    expect(await sudo(d, 'iptables -t nat -S')).not.toContain('zorglub');
  });

  it.each(['10.0.0.1', '10.0.0.1-10.0.0.9', '10.0.0.1:8080'])(
    '`--to-source %s` reste accepte', async (v) => {
      const d = hote(`NO${cle(v)}`);
      expect(await sudo(d, `iptables -t nat -A POSTROUTING -j SNAT --to-source ${v}`))
        .not.toMatch(/Bad IP address/);
    });
});

describe('une adresse IPv6 de traduction n est pas coupee a ses deux-points', () => {
  it('`ip6tables … --to-destination fd00::9` reste accepte', async () => {
    const d = hote('V1');
    expect(await sudo(d,
      'ip6tables -t nat -A PREROUTING -d fd00::1 -j DNAT --to-destination fd00::9'))
      .not.toMatch(/Bad IP address/);
  });

  it('`--to-destination [fd00::9]:80` reste accepte', async () => {
    const d = hote('V2');
    expect(await sudo(d,
      'ip6tables -t nat -A PREROUTING -d fd00::1 -j DNAT --to-destination [fd00::9]:80'))
      .not.toMatch(/Bad IP address/);
  });

  it('mais `--to-destination zorglub` est refuse en IPv6 aussi', async () => {
    const d = hote('V3');
    expect(await sudo(d,
      'ip6tables -t nat -A PREROUTING -d fd00::1 -j DNAT --to-destination zorglub'))
      .toMatch(/Bad IP address/);
  });
});

describe('non-regression — ce que la famille jugeait deja', () => {
  it('`-i zorglub` reste accepte : une interface peut ne pas exister encore', async () => {
    const d = hote('XA');
    expect(await sudo(d, 'iptables -A INPUT -i zorglub -j ACCEPT')).not.toContain('iptables v');
    expect(await sudo(d, 'iptables -S')).toContain('zorglub');
  });

  it.each(['-s 999.1.1.1', '-p tcp --dport 99999'])('`%s` reste refuse', async (mauvais) => {
    const d = hote(`XB${cle(mauvais)}`);
    expect(await sudo(d, `iptables -A INPUT ${mauvais} -j ACCEPT`)).toContain('iptables');
  });

  it('et une regle bien formee entre dans la chaine', async () => {
    const d = hote('XC');
    await sudo(d, 'iptables -A INPUT -p tcp --dport 22 -m state --state NEW -j ACCEPT');
    const vue = await sudo(d, 'iptables -S');
    expect(vue).toContain('--dport 22');
    expect(vue).toContain('NEW');
  });
});
