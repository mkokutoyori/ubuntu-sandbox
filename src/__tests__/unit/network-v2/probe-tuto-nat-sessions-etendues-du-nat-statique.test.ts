/**
 * Tuto NAT / PAT sur Cisco, parties 6.4 et 9.3 : une connexion entrante a travers un NAT statique
 * ou une redirection de port doit apparaitre dans `show ip nat translations` avec ses ports
 * (« tcp 203.0.113.3:80 192.168.10.10:80 203.0.113.1:23456 203.0.113.1:23456 »), pas seulement la
 * ligne statique.
 *
 * Mesure avant correction : la traduction de destination d'une entree statique etait sans etat,
 * aucune session n'etait creee, donc la table ne montrait que la ligne statique pendant que la
 * connexion etait ouverte, rien ne vieillissait, et `ip nat log translations syslog` ne disait
 * rien d'une connexion qui traversait pourtant le NAT. Avec src remis a HEAD : les cas de table,
 * de journal et d'expiration tombent ; le temoin (la ligne statique est la, et le trafic passe)
 * passe dans les deux etats.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PAT = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';
const FORWARD = 'ip nat inside source static tcp 192.168.10.10 80 interface GigabitEthernet0/1 80';
const STATIC = 'ip nat inside source static 192.168.10.10 203.0.113.3';

describe('extended entries of static translations', () => {
  it('witness: the static line is listed and the service answers', async () => {
    const { r, ext } = await tutoNatLab([PAT, STATIC]);
    expect(await ext.executeCommand('curl -s -m 5 -o /dev/null -w "%{http_code}\\n" http://203.0.113.3/')).toContain('200');
    expect(await r.executeCommand('show ip nat translations')).toMatch(/^---\s+203\.0\.113\.3\s+192\.168\.10\.10/m);
  });

  it('a connection through a 1:1 static translation is listed with both ends and its ports', async () => {
    const { r, isp } = await tutoNatLab([PAT, STATIC]);
    expect(await isp.executeCommand('telnet 203.0.113.3 80')).toContain('Open');
    const table = await r.executeCommand('show ip nat translations');
    expect(table).toMatch(/^tcp\s+203\.0\.113\.3:80\s+192\.168\.10\.10:80\s+203\.0\.113\.1:(\d+)\s+203\.0\.113\.1:\1\s*$/m);
  });

  it('a connection through a port forwarding is listed likewise', async () => {
    const { r, isp } = await tutoNatLab([PAT, FORWARD]);
    await isp.executeCommand('telnet 203.0.113.2 80');
    const table = await r.executeCommand('show ip nat translations');
    expect(table).toMatch(/^tcp\s+203\.0\.113\.2:80\s+192\.168\.10\.10:80\s+203\.0\.113\.1:(\d+)\s+203\.0\.113\.1:\1\s*$/m);
    expect(table).toMatch(/^tcp\s+203\.0\.113\.2:80\s+192\.168\.10\.10:80\s+---\s+---\s*$/m);
  });

  it('the server reaching out through its 1:1 translation is listed as well', async () => {
    const { r, srv } = await tutoNatLab([PAT, STATIC]);
    await srv.executeCommand('curl -s -m 5 -o /dev/null http://198.51.100.10/');
    expect(await r.executeCommand('show ip nat translations')).toMatch(/^tcp\s+203\.0\.113\.3:\d+\s+192\.168\.10\.10:\d+\s+198\.51\.100\.10:80\s+198\.51\.100\.10:80\s*$/m);
  });

  it('is journalised and ages out like any other translation', async () => {
    const { r, isp } = await tutoNatLab([PAT, FORWARD, 'ip nat log translations syslog']);
    await isp.executeCommand('telnet 203.0.113.2 80');
    expect(await r.executeCommand('show logging | include IPNAT')).toContain('%IPNAT-6-CREATED: tcp 192.168.10.10:80 203.0.113.2:80 203.0.113.1:');
    r._getNATEngine().purgeStale(0);
    expect(await r.executeCommand('show logging | include IPNAT')).toContain('%IPNAT-6-DELETED: tcp 192.168.10.10:80 203.0.113.2:80');
    expect(await r.executeCommand('show ip nat translations')).not.toMatch(/203\.0\.113\.1:\d+/);
  });
});
