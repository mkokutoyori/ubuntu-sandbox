/**
 * Tuto NAT / PAT sur Cisco, partie 8.1 : le PAT « conserve le port s'il est libre » ; quand deux
 * postes utilisent le meme port source, le routeur en choisit un autre pour le second
 * (203.0.113.2:49152 pour le premier, 203.0.113.2:1024 pour le second).
 *
 * Mesure avant correction : le PAT ignorait le port d'origine et distribuait 10240, 10241... : un
 * poste qui sortait par le port 40000 apparaissait sous 203.0.113.2:10240, si bien que la
 * correlation port-a-port du tuto (partie 14, retrouver un poste a partir d'un port public) ne
 * pouvait pas etre faite en lisant la connexion. Le port d'origine est desormais conserve s'il est
 * libre ; sinon, comme IOS, un port de la meme classe (1-511, 512-1023, 1024 et au-dela) ; un
 * port public deja promis par une redirection de port n'est jamais donne a un flux traduit.
 *
 * Avec src remis a HEAD, les deux premiers cas tombent (ports 10240 et 10241) ; le troisieme
 * (le port 80 d'une redirection n'est pas pris) passe aussi par hasard, tant que l'allocateur ne
 * produit jamais 80 : c'est un cas de non-regression, pas de decouverte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PAT = 'ip nat inside source list 1 interface GigabitEthernet0/1 overload';
const curl = (port: number) => `curl -s -m 5 -o /dev/null --local-port ${port} http://198.51.100.10/`;

describe('PAT source port preservation', () => {
  it('keeps the source port of the first flow', async () => {
    const { r, lin } = await tutoNatLab([PAT]);
    await lin.executeCommand(curl(40000));
    expect(await r.executeCommand('show ip nat translations')).toMatch(/^tcp\s+203\.0\.113\.2:40000\s+192\.168\.10\.22:40000\s/m);
  });

  it('gives the second host that wants the same port another one, and keeps the first', async () => {
    const { r, lin, srv } = await tutoNatLab([PAT]);
    await lin.executeCommand(curl(40000));
    await srv.executeCommand(curl(40000));
    const table = await r.executeCommand('show ip nat translations');
    expect(table).toMatch(/^tcp\s+203\.0\.113\.2:40000\s+192\.168\.10\.22:40000\s/m);
    expect(table).toMatch(/^tcp\s+203\.0\.113\.2:1024\s+192\.168\.10\.10:40000\s/m);
  });

  it('never hands a public port promised by a port forwarding to a translated flow', async () => {
    const { r, lin } = await tutoNatLab([PAT, 'ip nat inside source static tcp 192.168.10.10 80 interface GigabitEthernet0/1 80']);
    await lin.executeCommand(curl(80));
    const table = await r.executeCommand('show ip nat translations');
    expect(table).toMatch(/^tcp\s+203\.0\.113\.2:\d+\s+192\.168\.10\.22:80\s/m);
    expect(table).not.toMatch(/^tcp\s+203\.0\.113\.2:80\s+192\.168\.10\.22/m);
  });
});
