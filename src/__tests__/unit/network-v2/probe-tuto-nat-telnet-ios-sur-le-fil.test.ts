/**
 * Tuto NAT / PAT sur Cisco, parties 6.4 et 9.3 : `telnet <adresse> <port>` depuis le routeur ISP.
 *
 * Mesure avant correction : le client telnet d'IOS ne parlait pas au reseau. Il cherchait l'objet
 * equipement qui porte l'adresse (`findHostByAddress`) et ne repondait « Connection refused » que
 * pour tout port autre que 23, sans emettre un seul paquet. Un nginx qui ecoute sur 203.0.113.9:80
 * etait « refuse », une adresse portee par le NAT (203.0.113.3, qui n'est l'adresse d'aucun
 * equipement) « timed out », et le cache ARP de l'ISP restait vide. Desormais la reponse vient
 * du fil : poignee de main TCP reelle, RST pour « refused », silence pour « timed out ».
 *
 * Avec src remis a HEAD, 4 cas sur 6 tombent (voisin, NAT 1:1, redirection de port avec son refus,
 * session suivie par `where`). Passent dans les deux etats : le temoin du laboratoire (curl depuis
 * un hote externe traverse le meme NAT) et « timed out » sur une adresse que personne ne porte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PAT = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';

describe('IOS telnet <ip> <port> from the ISP, over the wire', () => {
  it('witness: a host outside the router reaches the published service through the same NAT', async () => {
    const { ext } = await tutoNatLab([PAT, 'ip nat inside source static tcp 192.168.10.10 80 interface GigabitEthernet0/1 80']);
    expect(await ext.executeCommand('curl -s -m 5 -o /dev/null -w "%{http_code}\\n" http://203.0.113.2/')).toContain('200');
  });

  it('opens a connection to a neighbour that listens (no NAT involved)', async () => {
    const { isp } = await tutoNatLab([PAT]);
    expect(await isp.executeCommand('telnet 203.0.113.9 80')).toContain('Open');
  });

  it('opens a connection through a static 1:1 translation', async () => {
    const { isp } = await tutoNatLab([PAT, 'ip nat inside source static 192.168.10.10 203.0.113.3']);
    expect(await isp.executeCommand('telnet 203.0.113.3 80')).toContain('Open');
  });

  it('opens a connection through a port forwarding and refuses a port that is not published', async () => {
    const { isp } = await tutoNatLab([PAT, 'ip nat inside source static tcp 192.168.10.10 80 interface GigabitEthernet0/1 80']);
    expect(await isp.executeCommand('telnet 203.0.113.2 80')).toContain('Open');
    expect(await isp.executeCommand('telnet 203.0.113.2 25')).toContain('% Connection refused by remote host');
  });

  it('records the session, which `where` lists and `disconnect` closes', async () => {
    const { isp } = await tutoNatLab([PAT]);
    await isp.executeCommand('telnet 203.0.113.9 80');
    expect(await isp.executeCommand('where')).toContain('203.0.113.9');
    await isp.executeCommand('disconnect 1');
    expect(await isp.executeCommand('where')).toContain('No connections open');
  });

  it('answers timed out when nothing answers', async () => {
    const { isp } = await tutoNatLab([PAT]);
    expect(await isp.executeCommand('telnet 203.0.113.12 80')).toContain('% Connection timed out');
  });
});
