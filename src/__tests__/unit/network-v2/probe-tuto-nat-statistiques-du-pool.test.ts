/**
 * Tuto NAT / PAT sur Cisco, parties 7.4 et 8.6 : `show ip nat statistics` quand le pool s'epuise.
 *
 * Mesure avant correction : le pool etait decrit par « POOL-AKWA: 203.0.113.4 - 203.0.113.6 — used
 * 5/3 (167%) » (le numerateur comptait les TRADUCTIONS, pas les adresses : cinq echos ICMP d'un seul
 * poste faisaient 167 % d'un pool de trois adresses), aucun compteur d'echecs par pool n'existait,
 * la regle s'affichait « -- Inside Source [acl 1] pool POOL-AKWA » sans identifiant ni refcount, et
 * une redirection de port s'affichait comme un NAT 1:1 (« static 192.168.10.10 203.0.113.2 »).
 * Le format vise est celui du tuto : « [Id: 1] access-list 1 pool POOL-AKWA refcount N », puis
 * « pool POOL-AKWA: netmask ... », « start ... end ... », « type generic, total addresses T,
 * allocated A (P%), misses M ».
 *
 * nat-pat-other 378 attendait le nom d'un pool que AUCUNE regle n'utilisait ; IOS ne decrit un pool
 * qu'a travers la regle qui s'en sert, le test en declare donc une.
 *
 * Un test de scenario-cisco-nat-audit-report epinglait l'ancienne ecriture « Inside Source [acl X]
 * overload » : il est corrige pour la forme IOS (« -- Inside Source » puis « [Id: 1] access-list X
 * interface ... refcount N »). Avec src remis a HEAD, 3 cas sur 4 tombent ; le temoin (les deux
 * premiers postes obtiennent une adresse chacun) passe dans les deux etats.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const POOL = [
  'ip nat pool POOL-AKWA 203.0.113.4 203.0.113.5 netmask 255.255.255.240',
  'ip nat inside source list 1 pool POOL-AKWA',
];

describe('show ip nat statistics with a two-address pool', () => {
  it('witness: the first two hosts each get an address of the pool', async () => {
    const { r, win, lin } = await tutoNatLab(POOL);
    await win.executeCommand('ping 198.51.100.10');
    await lin.executeCommand('ping -c 2 198.51.100.10');
    const table = await r.executeCommand('show ip nat translations');
    expect(table).toMatch(/203\.0\.113\.4:\d+\s+192\.168\.10\.2[12]/);
    expect(table).toMatch(/203\.0\.113\.5:\d+\s+192\.168\.10\.2[12]/);
  });

  it('counts addresses, not translations, and counts the host that found the pool empty', async () => {
    const { r, win, lin, srv } = await tutoNatLab(POOL);
    await win.executeCommand('ping 198.51.100.10');
    await lin.executeCommand('ping -c 2 198.51.100.10');
    expect(await srv.executeCommand('ping -c 2 198.51.100.10')).toContain('0 received');
    const stats = await r.executeCommand('show ip nat statistics');
    expect(stats).toContain('-- Inside Source\n[Id: 1] access-list 1 pool POOL-AKWA refcount ');
    expect(stats).toContain(' pool POOL-AKWA: netmask 255.255.255.240');
    expect(stats).toContain('\tstart 203.0.113.4 end 203.0.113.5');
    expect(stats).toMatch(/\ttype generic, total addresses 2, allocated 2 \(100%\), misses [1-9]\d*/);
    expect(stats).not.toMatch(/used \d+\/2/);
  });

  it('renders a port forwarding with its protocol and ports, not as a 1:1 translation', async () => {
    const { r } = await tutoNatLab([
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
      'ip nat inside source static tcp 192.168.10.10 80 interface GigabitEthernet0/1 80',
    ]);
    expect(await r.executeCommand('show ip nat statistics')).toMatch(/-- static\s+tcp 192\.168\.10\.10 80\s+203\.0\.113\.2 80/);
  });

  it('counts the extended entries in the first line', async () => {
    const { r, win } = await tutoNatLab(['ip nat inside source list 1 interface GigabitEthernet0/1 overload']);
    await win.executeCommand('ping 198.51.100.10');
    expect(await r.executeCommand('show ip nat statistics')).toMatch(/Total active translations: 4 \(0 static, 4 dynamic; 4 extended\)/);
  });
});
