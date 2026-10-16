/**
 * Reference : Cisco IOS Security Command Reference, Commands D to L, pages `kerberos clients
 * mandatory`, `credentials forward`, `instance map`, `local-realm`, `password`, `preauth`, `processes`,
 * `realm`, `retry`, `server`, `srvtab entry`, `timeout`, et `aaa authentication login ... krb5`
 * (Commands A to C). Ce qui est NOTRE choix, dit ici : le KDC est le controleur de domaine du
 * simulateur, interroge par un VRAI echange AS sur TCP/88 ; `kerberos srvtab remote` et la methode
 * `krb5-telnet` ne sont pas construits (ils demandent un fichier SRVTAB recupere par le reseau et
 * le dechiffrement d'un ticket de service), et les options `password`, `credentials
 * forward`, `clients mandatory`, `realm` et `processes` sont conservees et rendues sans effet
 * observable, ce que la machine reelle accepte aussi sans que ce simulateur ait de quoi les honorer
 * (pas de client rsh/rcp/rlogin/telnet kerberise, un seul KDC repond a la fois).
 *
 * Mesure avant correction : les treize commandes `kerberos ...` etaient refusees (« % Invalid input
 * detected »), et la methode `krb5`, acceptee par `aaa authentication login default krb5`, n'etait
 * evaluee nulle part : un mot de passe juste ET un mot de passe faux donnaient la meme reponse,
 * `exhausted`. Mesure avec src remis a HEAD : 6 cas sur 11 tombent. Les cinq autres passent dans les deux etats :
 * le temoin du laboratoire, l'absence de formes non documentees, les bornes (refusees avant comme apres),
 * le repli local sans serveur, et alice/admin (refuse avant parce que krb5 n'etait pas evalue, apres
 * parce que le KDC refuse un nom a plusieurs composants).
 *
 * Seconde mesure, `kerberos preauth` : la page dit « Command Default : Disabled » et « the no form is
 * equivalent to the none keyword » ; le routeur preauthentifiait pourtant toujours. Il envoie desormais
 * l'AS-REQ sans PA-ENC-TIMESTAMP par defaut et avec `none` (le KDC d'Active Directory repond
 * PREAUTH_REQUIRED, le login est refuse), `encrypted-kerberos-timestamp` envoie PA-ENC-TIMESTAMP
 * (type 2) et `encrypted-unix-timestamp` le type 5 d'avant la RFC 4120, que ce KDC ne connait pas, ce
 * que la page annonce (« communication with the KDC will fail »). Avec src a HEAD : 3 cas tombent
 * (defaut refuse, none/unix refuses, no form), le temoin du compte sans preauth passe dans les deux etats.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress, type IPv4Packet, type TCPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import { __setDefaultScheduler, type VirtualTimeScheduler } from '@/events/Scheduler';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialKdc } from '@/network/kerberos/KerberosClient';

const SAFE = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
const DC = '10.0.0.10';
const SILENT = '10.0.0.20';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

afterEach(() => { __setDefaultScheduler(null); });

async function lab(): Promise<{ nas: CiscoRouter; dc: WindowsServer; synsToSilent: () => number }> {
  const nas = new CiscoRouter('NAS');
  const dc = new WindowsServer('DC01');
  const silent = new LinuxPC('linux-pc', 'SILENT');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  nas.powerOn(); dc.powerOn(); silent.powerOn();
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0') as never, hub.getPorts()[0]);
  new Cable('b').connect(dc.getPort('eth0') as never, hub.getPorts()[1]);
  new Cable('c').connect(silent.getPort('eth0') as never, hub.getPorts()[2]);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  await silent.executeCommand(`ip addr add ${SILENT}/24 dev eth0`);
  await silent.executeCommand('ip link set eth0 up');
  await dc.executeCommand(`netsh interface ip set address "Ethernet0" static ${DC} 255.255.255.0`);
  const ps = PowerShellSubShell.create(dc as never).subShell;
  await ps.processLine('Install-WindowsFeature -Name AD-Domain-Services');
  await ps.processLine(`Install-ADDSForest -DomainName "corp.local" -Force ${SAFE}`);
  await ps.processLine('New-ADUser -Name alice -SamAccountName alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -Enabled $true');
  let syns = 0;
  nas.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }) => {
    if (direction !== 'out') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const tcp = packet?.type === 'ipv4' ? packet.payload as TCPPacket : undefined;
    if (tcp?.type === 'tcp' && tcp.flags.syn && !tcp.flags.ack && tcp.destinationPort === 88
      && packet!.destinationIP.toString() === SILENT) syns++;
  });
  return { nas, dc, synsToSilent: () => syns };
}

async function configure(nas: CiscoRouter, lines: readonly string[]): Promise<string[]> {
  const answers: string[] = [];
  for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'exit', 'aaa new-model', ...lines, 'end']) {
    answers.push(await nas.executeCommand(line));
  }
  return answers;
}

const login = (nas: CiscoRouter, user: string, password: string) =>
  clock.advanceUntilSettled(nas.getAaaAuthenticator().authenticate(user, password, 'default'));

describe('kerberos commands and the krb5 login method', () => {
  it('witness: the lab is sound, the router obtains a TGT from the controller', async () => {
    const { nas } = await lab();
    const connection = dialKdc(nas.getTcpStack(), DC);
    expect(connection.ok).toBe(true);
    expect(connection.client!.asExchange('alice', 'alicepw', 'CORP.LOCAL').ok).toBe(true);
  });

  it('the commands of the reference are accepted and rendered in the running-config', async () => {
    const { nas } = await lab();
    const answers = await configure(nas, [
      'kerberos local-realm CORP.LOCAL', 'kerberos realm .corp.local CORP.LOCAL',
      `kerberos server CORP.LOCAL ${DC}`, `kerberos server OTHER.LOCAL ${SILENT} 8888`,
      'kerberos instance map admin 15', 'kerberos preauth encrypted-unix-timestamp', 'kerberos password s3cret',
      'kerberos credentials forward', 'kerberos clients mandatory', 'kerberos retry 3', 'kerberos timeout 2',
      'kerberos processes 2',
    ]);
    expect(answers.filter((a) => /%/.test(a))).toEqual([]);
    const config = await nas.executeCommand('show running-config');
    for (const line of [
      'kerberos local-realm CORP.LOCAL', 'kerberos realm .corp.local CORP.LOCAL', `kerberos server CORP.LOCAL ${DC}`,
      `kerberos server OTHER.LOCAL ${SILENT} 8888`, 'kerberos instance map admin 15',
      'kerberos preauth encrypted-unix-timestamp', 'kerberos credentials forward', 'kerberos clients mandatory',
      'kerberos retry 3', 'kerberos timeout 2', 'kerberos processes 2',
    ]) expect(config, line).toContain(line);
  });

  it('the no forms remove what they set and the defaults leave no line', async () => {
    const { nas } = await lab();
    await configure(nas, ['kerberos local-realm CORP.LOCAL', `kerberos server CORP.LOCAL ${DC}`, 'kerberos retry 3',
      'kerberos timeout 2', 'kerberos credentials forward', 'kerberos instance map admin 15']);
    for (const line of ['configure terminal', 'no kerberos local-realm', `no kerberos server CORP.LOCAL ${DC}`, 'no kerberos retry',
      'no kerberos timeout', 'no kerberos credentials forward', 'no kerberos instance map admin', 'end']) await nas.executeCommand(line);
    expect(await nas.executeCommand('show running-config')).not.toContain('kerberos');
  });

  it('the ranges of the reference are enforced: retry 1-5, timeout 1-10, processes 1-10, privilege 0-15', async () => {
    const { nas } = await lab();
    const answers = await configure(nas, ['kerberos retry 6', 'kerberos retry 0', 'kerberos timeout 11', 'kerberos processes 11', 'kerberos instance map admin 16']);
    expect(answers.filter((a) => /Invalid input|range/.test(a))).toHaveLength(5);
    expect(await nas.executeCommand('show running-config')).not.toContain('kerberos retry');
  });

  it('krb5 accepts the right password of a principal the controller knows', async () => {
    const { nas } = await lab();
    await configure(nas, ['kerberos local-realm CORP.LOCAL', `kerberos server CORP.LOCAL ${DC}`, 'kerberos preauth encrypted-kerberos-timestamp', 'aaa authentication login default krb5']);
    const outcome = await login(nas, 'alice', 'alicepw');
    expect(outcome).toMatchObject({ accepted: true, method: 'krb5' });
  });

  it('krb5 refuses a wrong password and an unknown principal, and the refusal is final: the local account is not tried', async () => {
    const { nas } = await lab();
    await configure(nas, ['kerberos local-realm CORP.LOCAL', `kerberos server CORP.LOCAL ${DC}`, 'kerberos preauth encrypted-kerberos-timestamp', 'aaa authentication login default krb5 local']);
    expect((await login(nas, 'alice', 'wrong')).accepted).toBe(false);
    expect((await login(nas, 'mallory', 'x')).accepted).toBe(false);
    expect(await login(nas, 'alice', 'wrong')).toMatchObject({ method: 'krb5' });
  });

  it('a user cannot claim an instance the controller does not know: alice/admin is refused with the right password of alice', async () => {
    const { nas } = await lab();
    await configure(nas, ['kerberos local-realm CORP.LOCAL', `kerberos server CORP.LOCAL ${DC}`, 'kerberos instance map admin 15', 'kerberos preauth encrypted-kerberos-timestamp', 'aaa authentication login default krb5']);
    expect((await login(nas, 'alice/admin', 'alicepw')).accepted).toBe(false);
  });

  it('a realm typed after @ overrides the local realm and picks its own servers', async () => {
    const { nas } = await lab();
    await configure(nas, ['kerberos local-realm OTHER.LOCAL', `kerberos server CORP.LOCAL ${DC}`, 'kerberos preauth encrypted-kerberos-timestamp', 'aaa authentication login default krb5']);
    expect((await login(nas, 'alice', 'alicepw')).accepted).toBe(false);
    expect((await login(nas, 'alice@CORP.LOCAL', 'alicepw')).accepted).toBe(true);
  });

  it('a controller that cannot be reached is tried retry times, timeout seconds apart, then the next method answers', async () => {
    const { nas, synsToSilent } = await lab();
    await configure(nas, ['username bob secret bobpw', 'kerberos local-realm CORP.LOCAL', `kerberos server CORP.LOCAL ${SILENT}`,
      'kerberos retry 3', 'kerberos timeout 2', 'kerberos preauth encrypted-kerberos-timestamp', 'aaa authentication login default krb5 local']);
    const before = clock.now();
    const outcome = await login(nas, 'bob', 'bobpw');
    expect(outcome).toMatchObject({ accepted: true, method: 'local' });
    expect(synsToSilent()).toBe(3);
    expect(clock.now() - before).toBeGreaterThanOrEqual(6000);
  });

  it('witness: with no kerberos server the method does not answer and the next one does', async () => {
    const { nas } = await lab();
    await configure(nas, ['username bob secret bobpw', 'kerberos preauth encrypted-kerberos-timestamp', 'aaa authentication login default krb5 local']);
    expect(await login(nas, 'bob', 'bobpw')).toMatchObject({ accepted: true, method: 'local' });
  });

  it('aaa authorization exec krb5-instance maps the instance of the principal to its privilege level', async () => {
    const { nas } = await lab();
    await configure(nas, ['kerberos local-realm CORP.LOCAL', 'kerberos instance map admin 15', 'kerberos instance map ops 5', 'aaa authorization exec default krb5-instance']);
    const authenticator = nas.getAaaAuthenticator();
    expect(await authenticator.authorizeExec('alice/admin')).toEqual({ allowed: true, privilegeLevel: 15 });
    expect(await authenticator.authorizeExec('alice/ops')).toEqual({ allowed: true, privilegeLevel: 5 });
    expect(await authenticator.authorizeExec('alice/unmapped')).toEqual({ allowed: true, privilegeLevel: 1 });
    expect(await authenticator.authorizeExec('alice')).toEqual({ allowed: true, privilegeLevel: 1 });
  });

  const realm = ['kerberos local-realm CORP.LOCAL', `kerberos server CORP.LOCAL ${DC}`];

  it('preauth is off by default: the controller demands it and the login is refused', async () => {
    const { nas } = await lab();
    await configure(nas, [...realm, 'aaa authentication login default krb5 local', 'username alice secret alicepw']);
    expect(await login(nas, 'alice', 'alicepw')).toMatchObject({ accepted: false, method: 'krb5' });
  });

  it('kerberos preauth none and the unix timestamp are refused by a controller that wants the RFC 4120 timestamp', async () => {
    const { nas } = await lab();
    for (const method of ['none', 'encrypted-unix-timestamp']) {
      await configure(nas, [...realm, `kerberos preauth ${method}`, 'aaa authentication login default krb5']);
      expect(await login(nas, 'alice', 'alicepw')).toMatchObject({ accepted: false, method: 'krb5' });
    }
  });

  it('kerberos preauth encrypted-kerberos-timestamp is accepted by the controller, and its no form goes back to none', async () => {
    const { nas } = await lab();
    await configure(nas, [...realm, 'kerberos preauth encrypted-kerberos-timestamp', 'aaa authentication login default krb5']);
    expect(await login(nas, 'alice', 'alicepw')).toMatchObject({ accepted: true, method: 'krb5' });
    await configure(nas, ['no kerberos preauth']);
    expect(await login(nas, 'alice', 'alicepw')).toMatchObject({ accepted: false, method: 'krb5' });
  });

  it('witness: an account that does not require preauthentication is accepted without it', async () => {
    const { nas, dc } = await lab();
    await PowerShellSubShell.create(dc as never).subShell.processLine('Set-ADAccountControl -Identity alice -DoesNotRequirePreAuth $true');
    await configure(nas, [...realm, 'aaa authentication login default krb5']);
    expect(await login(nas, 'alice', 'alicepw')).toMatchObject({ accepted: true, method: 'krb5' });
  });
});
