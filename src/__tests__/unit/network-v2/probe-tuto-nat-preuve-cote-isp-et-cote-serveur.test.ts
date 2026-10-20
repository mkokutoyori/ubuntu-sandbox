/**
 * Tuto NAT / PAT sur Cisco, parties 6.4, 8.4 et 9.3 : la preuve vue de L'AUTRE cote.
 *
 * - sur l'ISP, `show tcp brief` doit montrer la connexion ouverte (« ESTAB ») avec l'adresse
 *   publique du routeur NAT, jamais l'adresse privee ;
 * - sur SRV-WEB, `ss -tn state established '( sport = :80 )'` doit montrer l'ISP comme pair
 *   (« 192.168.10.10:80  203.0.113.1:<port> »), preuve que la redirection a livre la connexion.
 *
 * Mesure avant correction : le client telnet d'IOS ne parlait pas TCP (voir
 * probe-tuto-nat-telnet-ios-sur-le-fil), donc aucune connexion n'existait ni cote ISP ni cote
 * serveur. Avec src remis a HEAD, les deux cas qui ouvrent une connexion tombent ; le temoin
 * (un LISTEN sur le port 80 de l'ISP, qui est la, ligne du tuto) passe dans les deux etats.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PAT = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';
const FORWARD = 'ip nat inside source static tcp 192.168.10.10 80 interface GigabitEthernet0/1 80';

describe('the proof seen from the other side', () => {
  it('witness: the ISP shows its HTTP listener', async () => {
    const { isp } = await tutoNatLab([PAT]);
    expect(await isp.executeCommand('show tcp brief')).toMatch(/\*\.80\s+\*\.\*\s+LISTEN/);
  });

  it('the ISP lists the open connection under the public address of the NAT router', async () => {
    const { isp } = await tutoNatLab([PAT, FORWARD]);
    await isp.executeCommand('telnet 203.0.113.2 80');
    const brief = await isp.executeCommand('show tcp brief');
    expect(brief).toMatch(/203\.0\.113\.1\.\d+\s+203\.0\.113\.2\.80\s+ESTAB/);
    expect(brief).not.toContain('192.168.10.10');
  });

  it('the server sees the ISP as the peer of the forwarded connection', async () => {
    const { isp, srv } = await tutoNatLab([PAT, FORWARD]);
    await isp.executeCommand('telnet 203.0.113.2 80');
    const sockets = await srv.executeCommand("ss -tn state established '( sport = :80 )'");
    expect(sockets).toMatch(/192\.168\.10\.10:80\s+203\.0\.113\.1:\d+/);
  });
});
