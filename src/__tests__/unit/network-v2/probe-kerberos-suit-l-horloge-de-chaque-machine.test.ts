/**
 * Le KDC et le client Kerberos lisent l'horloge de LEUR machine (`TcpStack.nowMs`,
 * `KdcContext.nowMs`, `KerberosServiceIdentity.clockMs`), plus une heure globale : une horloge
 * decalee de plus de cinq minutes (RFC 4120 §5.2.7.2, `KRB_AP_ERR_SKEW` = 37, §7.5.9) fait echouer
 * l'echange.
 *
 * MESURE DE DEPART, un LinuxServer client et un WindowsServer controleur de domaine, horloge du
 * controleur avancee de dix minutes (`_stepSystemClock`) :
 *  - l'echange AS reussissait : le client et le KDC lisaient la meme heure globale, aucun
 *    decalage n'etait representable ;
 *  - et un decalage, une fois representable, etait confondu avec un mot de passe faux : la
 *    pre-authentification renvoyait `KDC_ERR_PREAUTH_FAILED` et le KDC COMPTAIT un mauvais mot de
 *    passe — dix echecs dus a l'horloge verrouillaient un compte sain ;
 *  - l'authentificateur d'un TGS decale rendait `KRB_AP_ERR_TKT_EXPIRED`, un autre diagnostic.
 * Corrige : `KRB_AP_ERR_SKEW` (« Clock skew too great ») pour l'AS comme pour le TGS, journal de
 * securite 4771 avec le statut 0x25 (MS-KILE), et aucun mauvais mot de passe compte.
 * Discriminee contre l'etat d'avant (`origin/main`, meme sonde et memes outils) : 4 des 7 cas
 * tombent (decalage du controleur, client en retard, journal 4771, TGS decale). Les trois qui
 * passent des deux cotes sont NOMMES : le temoin (horloges synchronisees), « quatre minutes de
 * decalage passent » (la tolerance de cinq minutes n'a pas bouge : non-regression) et « dix
 * tentatives decalees ne verrouillent pas le compte » (avant, le decalage n'etait pas
 * representable, donc aucun mauvais mot de passe n'etait compte : structurel, il garde la
 * correction contre une regression de la classification, pas contre l'etat d'avant).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { principalName, PrincipalNameType, KrbErrorCode } from '@/network/kerberos/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, line: string) => (await sh.processLine(line)).output.join('\n');
const MINUTE = 60_000;

async function lab() {
  const dc = new WindowsServer('DC1');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.50.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.50.20'), mask);
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  const asExchange = (password = 'alicepw') =>
    dialKdc(client.getTcpStack(), '192.168.50.10').client!.asExchange('alice', password, 'LAB.LOCAL');
  return { dc, client, asExchange };
}

describe('Kerberos reads the clock of each machine', () => {
  it('synchronised clocks: the AS exchange succeeds — WITNESS', async () => {
    const { asExchange } = await lab();
    expect(asExchange().ok).toBe(true);
  });

  it('a controller four minutes ahead is inside the five-minute tolerance', async () => {
    const { dc, asExchange } = await lab();
    dc._stepSystemClock(4 * MINUTE);
    expect(asExchange().ok).toBe(true);
  });

  it('a controller ten minutes ahead refuses with KRB_AP_ERR_SKEW', async () => {
    const { dc, asExchange } = await lab();
    dc._stepSystemClock(10 * MINUTE);
    const result = asExchange();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KRB_AP_ERR_SKEW);
    expect(result.eText).toBe('Clock skew too great');
  });

  it('a client ten minutes behind is refused the same way', async () => {
    const { client, asExchange } = await lab();
    client._stepSystemClock(-10 * MINUTE);
    const result = asExchange();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KRB_AP_ERR_SKEW);
  });

  it('a skew is not a wrong password: ten refusals do not lock the account', async () => {
    const { dc, asExchange } = await lab();
    dc._stepSystemClock(10 * MINUTE);
    for (let attempt = 0; attempt < 10; attempt++) asExchange();
    dc._stepSystemClock(-10 * MINUTE);
    expect(asExchange().ok).toBe(true);
  });

  it('the domain controller logs 4771 with the status 0x25', async () => {
    const { dc, asExchange } = await lab();
    dc._stepSystemClock(10 * MINUTE);
    asExchange();
    const log = await run(ps(dc), 'Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4771} | Format-List Message');
    expect(log).toContain('0x25');
  });

  it('a TGS request whose authenticator is ten minutes off is refused with KRB_AP_ERR_SKEW', async () => {
    const { client, asExchange } = await lab();
    const tgt = asExchange();
    expect(tgt.ok).toBe(true);
    client._stepSystemClock(10 * MINUTE);
    const conn = dialKdc(client.getTcpStack(), '192.168.50.10');
    const cname = principalName(PrincipalNameType.NT_PRINCIPAL, 'alice');
    const result = conn.client!.tgsExchange(tgt.ticket!, tgt.sessionKey!, cname, 'LAB.LOCAL', 'DC1');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KRB_AP_ERR_SKEW);
  });
});
