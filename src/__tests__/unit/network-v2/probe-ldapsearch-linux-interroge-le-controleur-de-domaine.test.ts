/*
 * Sonde — un poste Linux interroge un controleur de domaine Active Directory
 * avec `ldapsearch` (paquet ldap-utils), et chaque octet de l'echange passe
 * par le fil.
 *
 * Le client est le port du vrai `ldapsearch` d'OpenLDAP 2.5 (voir la sonde de
 * rejeu `probe-ldapsearch-replays-the-real-openldap-client`, qui le compare
 * octet par octet au binaire d'origine). Cette sonde-ci mesure ce que le
 * rejeu ne peut pas : le poste, le commutateur, le DC promu par PowerShell,
 * et les trames comptees sur l'interface.
 *
 * Autorite : le comportement du client est celui du depot officiel
 * OpenLDAP (clone, compile et execute ici) ; les chaines de diagnostic du
 * DC (`000004DC`, `80090308 ... data 52e`) sont celles d'Active Directory
 * telles que les restituent les clients LDAP. Non attestable ici : la
 * banniere `-V` du paquet Ubuntu 22.04 (version Debian, hote de
 * construction), donnee de memoire.
 *
 * Mesure avant correction (`git stash` des sources suivies : la commande
 * n'est plus enregistree, l'interpreteur et `which` reprennent leur ancien
 * etat, le serveur LDAP du DC perd ses controles) : 16 des 17 cas tombent.
 * `ldapsearch` n'existait pas (« command not found ») ; `which`, `type` et
 * `command -v` ignoraient toute commande du registre (nmap, snmpwalk...) ;
 * `LDAPTLS_REQCERT=never ldapsearch ...` laissait la variable dans le
 * shell, si bien que la commande suivante passait le controle du certificat
 * sans qu'on le lui ait demande.
 * Passe dans les deux etats :
 *   - « the lab is sound » est le TEMOIN : le client LDAP deja present lit le
 *     rootDSE du DC promu, donc l'echec vient de la commande et pas du
 *     laboratoire.
 *
 * Les deux cas de `-C` (deuxieme foret, DC02 joint par son nom via
 * /etc/hosts) ont aussi ete mesures contre l'ancien port, qui acceptait
 * `-C` sans rien suivre : celui qui compte les octets recus par DC02 tombe
 * (aucun octet n'arrivait), celui de l'hote qui ne se resout pas passe avant
 * et apres, par construction : sans cible joignable, le referral reste
 * imprime, avec ou sans `-C` (temoin). La reponse du DC02 est celle du vrai
 * client : libldap rejoue un bind ANONYME sur la connexion suivie, et un DC
 * refuse alors la recherche (`Operations error`, 000004DC), exactement ce que
 * le vrai `ldapsearch -C` obtient d'un controleur Active Directory.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';

const SAFE_MODE = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
const DC_ADDRESS = '10.0.0.10';
const ADMIN_UPN = 'Administrator@corp.local';
const ADMIN_PASSWORD = 'P@ssw0rd!';

async function buildLab(): Promise<{ workstation: LinuxPC; controller: WindowsServer; hub: GenericSwitch }> {
  const workstation = new LinuxPC('linux-pc', 'PC1');
  const controller = new WindowsServer('DC01');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  workstation.powerOn();
  controller.powerOn();
  new Cable('c-pc').connect(workstation.getPort('eth0') as never, hub.getPorts()[0]);
  new Cable('c-dc').connect(controller.getPort('eth0') as never, hub.getPorts()[1]);
  await workstation.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await workstation.executeCommand('ip link set eth0 up');
  await controller.executeCommand(`netsh interface ip set address "Ethernet0" static ${DC_ADDRESS} 255.255.255.0`);
  const shell = PowerShellSubShell.create(controller as never).subShell;
  await shell.processLine('Install-WindowsFeature -Name AD-Domain-Services');
  await shell.processLine(`Install-ADDSForest -DomainName "corp.local" -Force ${SAFE_MODE}`);
  return { workstation, controller, hub };
}

const bound = `-x -H ldap://${DC_ADDRESS} -D '${ADMIN_UPN}' -w '${ADMIN_PASSWORD}'`;

const OTHER_DC_ADDRESS = '10.0.0.11';

async function buildForestPair(): Promise<{ workstation: LinuxPC; controller: WindowsServer; other: WindowsServer }> {
  const { workstation, controller, hub } = await buildLab();
  const other = new WindowsServer('DC02');
  other.powerOn();
  new Cable('c-dc2').connect(other.getPort('eth0') as never, hub.getPorts()[2]);
  await other.executeCommand(`netsh interface ip set address "Ethernet0" static ${OTHER_DC_ADDRESS} 255.255.255.0`);
  const shell = PowerShellSubShell.create(other as never).subShell;
  await shell.processLine('Install-WindowsFeature -Name AD-Domain-Services');
  await shell.processLine(`Install-ADDSForest -DomainName "other.local" -Force ${SAFE_MODE}`);
  await workstation.executeCommand(`echo '${OTHER_DC_ADDRESS} other.local' >> /etc/hosts`);
  return { workstation, controller, other };
}

const referralSearch = `-x -H ldap://${DC_ADDRESS} -D '${ADMIN_UPN}' -w '${ADMIN_PASSWORD}' -b dc=other,dc=local -s base -LLL dn`;

describe('ldapsearch from a Linux host against a promoted domain controller', () => {
  it('the lab is sound: the existing LDAP client reads the root DSE of the promoted controller', async () => {
    const { workstation } = await buildLab();
    const connection = dialLdap(workstation.getTcpStack(), DC_ADDRESS);
    expect(connection.ok).toBe(true);
    expect(connection.client!.bind(ADMIN_UPN, ADMIN_PASSWORD).ok).toBe(true);
    const found = connection.client!.search('', 'base', { kind: 'present', attr: 'objectClass' });
    expect(found.entries.length).toBeGreaterThan(0);
  });

  it('which, type and command -v agree on where ldapsearch lives', async () => {
    const workstation = new LinuxPC('linux-pc', 'PC1');
    workstation.powerOn();
    expect((await workstation.executeCommand('which ldapsearch')).trim()).toBe('/usr/bin/ldapsearch');
    expect((await workstation.executeCommand('type ldapsearch')).trim()).toBe('ldapsearch is /usr/bin/ldapsearch');
    expect((await workstation.executeCommand('command -v ldapsearch')).trim()).toBe('/usr/bin/ldapsearch');
  });

  it('every command the registry serves is found by which, not only the ones in the hand-written list', async () => {
    const workstation = new LinuxPC('linux-pc', 'PC1');
    workstation.powerOn();
    expect((await workstation.executeCommand('which snmpwalk')).trim()).toBe('/usr/bin/snmpwalk');
    expect((await workstation.executeCommand('which nmap')).trim()).toBe('/usr/bin/nmap');
  });

  it('the anonymous bind reads the root DSE', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -s base -b '' -LLL defaultNamingContext supportedLDAPVersion`,
    );
    expect(output).toContain('defaultNamingContext: DC=corp,DC=local');
    expect(output).toContain('supportedLDAPVersion: 3');
  });

  it('without a successful bind the directory answers an operations error', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -b dc=corp,dc=local -LLL dn`,
    );
    expect(output).toContain('Operations error (1)');
    expect(output).toContain('000004DC: LdapErr: DSID-0C090A69');
    expect(output).not.toContain('dn:');
  });

  it('a wrong password is refused with the AcceptSecurityContext diagnostic and exit status 49', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -D '${ADMIN_UPN}' -w wrong -b dc=corp,dc=local -s base; echo "exit=$?"`,
    );
    expect(output).toContain('ldap_bind: Invalid credentials (49)');
    expect(output).toContain('80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e');
    expect(output).toContain('exit=49');
  });

  it('a bound search returns the account with its binary attributes in base64', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(
      `ldapsearch ${bound} -b dc=corp,dc=local -LLL '(sAMAccountName=Administrator)' cn objectSid objectGUID`,
    );
    expect(output).toContain('dn: CN=Administrator,CN=Users,DC=corp,DC=local');
    expect(output).toMatch(/^objectSid:: [A-Za-z0-9+/=]+$/m);
    expect(output).toMatch(/^objectGUID:: [A-Za-z0-9+/=]+$/m);
  });

  it('DOMAIN\\user is accepted as a simple bind name', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -D 'CORP\\Administrator' -w '${ADMIN_PASSWORD}' -b cn=Users,dc=corp,dc=local -s base -LLL dn`,
    );
    expect(output).toContain('dn: CN=Users,DC=corp,DC=local');
  });

  it('-z stops the listing at the size limit and exits with status 4', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(
      `ldapsearch ${bound} -b cn=Users,dc=corp,dc=local -z 2 -LLL sAMAccountName; echo "exit=$?"`,
    );
    expect(output).toContain('Size limit exceeded (4)');
    expect(output).toContain('exit=4');
    expect(output.match(/^dn: /gm)).toHaveLength(2);
  });

  it('errors go to standard error and entries to standard output', async () => {
    const { workstation } = await buildLab();
    const hidden = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -b dc=corp,dc=local -LLL dn 2>/dev/null; echo "exit=$?"`,
    );
    expect(hidden.trim()).toBe('exit=1');
    const piped = await workstation.executeCommand(
      `ldapsearch ${bound} -b cn=Users,dc=corp,dc=local -s one -LLL sAMAccountName | grep -c '^sAMAccountName'`,
    );
    expect(Number(piped.trim())).toBeGreaterThan(1);
  });

  it('a password file is read from the machine filesystem', async () => {
    const { workstation } = await buildLab();
    await workstation.executeCommand(`printf '%s' '${ADMIN_PASSWORD}' > /tmp/ldap.pw`);
    await workstation.executeCommand('chmod 600 /tmp/ldap.pw');
    const output = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -D '${ADMIN_UPN}' -y /tmp/ldap.pw -b cn=Users,dc=corp,dc=local -s base -LLL dn`,
    );
    expect(output).toContain('dn: CN=Users,DC=corp,DC=local');
  });

  it('-W prompts on standard error and reads the password from the pipe when there is no terminal', async () => {
    const { workstation } = await buildLab();
    const accepted = await workstation.executeCommand(
      `echo '${ADMIN_PASSWORD}' | ldapsearch -x -H ldap://${DC_ADDRESS} -D '${ADMIN_UPN}' -W -b dc=corp,dc=local -s base -LLL dn; echo "exit=$?"`,
    );
    expect(accepted).toContain('Enter LDAP Password: ');
    expect(accepted).toContain('dn: DC=corp,DC=local');
    expect(accepted).toContain('exit=0');
    const refused = await workstation.executeCommand(
      `echo wrong | ldapsearch -x -H ldap://${DC_ADDRESS} -D '${ADMIN_UPN}' -W -b dc=corp,dc=local -s base -LLL dn; echo "exit=$?"`,
    );
    expect(refused).toContain('ldap_bind: Invalid credentials (49)');
    expect(refused).toContain('exit=49');
    const endOfInput = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -D '${ADMIN_UPN}' -W -b dc=corp,dc=local -s base -LLL dn < /dev/null; echo "exit=$?"`,
    );
    expect(endOfInput).toContain('Enter LDAP Password: ');
    expect(endOfInput).not.toContain('dn:');
    expect(endOfInput).toContain('exit=1');
  });

  it('the exchange crosses the wire: the credentials leave in the request and the entries return in the reply', async () => {
    const { workstation } = await buildLab();
    const port = workstation.getPort('eth0')!;
    const measure = async (command: string) => {
      const before = port.getCounters();
      await workstation.executeCommand(command);
      const after = port.getCounters();
      return { sent: after.bytesOut - before.bytesOut, received: after.bytesIn - before.bytesIn };
    };
    await measure(`ldapsearch -x -H ldap://${DC_ADDRESS} -s base -b '' -LLL dn`);
    const anonymous = await measure(`ldapsearch -x -H ldap://${DC_ADDRESS} -s base -b '' -LLL dn`);
    const authenticated = await measure(`ldapsearch ${bound} -s base -b '' -LLL dn`);
    const wide = await measure(`ldapsearch ${bound} -s one -b cn=Users,dc=corp,dc=local -LLL dn`);
    expect(anonymous.sent).toBeGreaterThan(0);
    expect(authenticated.sent).toBeGreaterThan(anonymous.sent);
    expect(wide.received).toBeGreaterThan(authenticated.received);
  });

  it('an untrusted LDAPS certificate is refused, and a prefix variable lifts the check for its own command only', async () => {
    const { workstation } = await buildLab();
    const refused = await workstation.executeCommand(`ldapsearch -x -H ldaps://${DC_ADDRESS} -s base -b '' -LLL dn`);
    expect(refused).toContain("ldap_sasl_bind(SIMPLE): Can't contact LDAP server (-1)");
    const lifted = await workstation.executeCommand(
      `LDAPTLS_REQCERT=never ldapsearch -x -H ldaps://${DC_ADDRESS} -s base -b '' -LLL defaultNamingContext`,
    );
    expect(lifted).toContain('defaultNamingContext: DC=corp,DC=local');
    expect((await workstation.executeCommand('env | grep LDAPTLS')).trim()).toBe('');
    const refusedAgain = await workstation.executeCommand(`ldapsearch -x -H ldaps://${DC_ADDRESS} -s base -b '' -LLL dn`);
    expect(refusedAgain).toContain("Can't contact LDAP server (-1)");
  });

  it('StartTLS with -ZZ fails the same way and reports the TLS library wording', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(
      `ldapsearch -x -H ldap://${DC_ADDRESS} -ZZ -s base -b '' -LLL dn`,
    );
    expect(output).toContain('ldap_start_tls: Connect error (-11)');
    expect(output).toContain('additional info: (unknown error code)');
  });
  it('without -C the referral of another forest is printed and nothing reaches the other controller; with -C the second connection crosses the wire', async () => {
    const { workstation, other } = await buildForestPair();
    const otherPort = other.getPort('eth0')!;
    const received = async (command: string) => {
      const before = otherPort.getCounters().bytesIn;
      const output = await workstation.executeCommand(command);
      return { output, bytes: otherPort.getCounters().bytesIn - before };
    };
    await received(`ldapsearch ${referralSearch}`);
    const plain = await received(`ldapsearch ${referralSearch}; echo "exit=$?"`);
    const chased = await received(`ldapsearch -C ${referralSearch}; echo "exit=$?"`);
    expect(plain.output).toContain('Referral (10)');
    expect(plain.output).toContain('Referral: ldap://other.local/dc=other,dc=local');
    expect(plain.output).toContain('exit=10');
    expect(plain.bytes).toBe(0);
    expect(chased.bytes).toBeGreaterThan(0);
    expect(chased.output).not.toContain('Referral (10)');
    expect(chased.output).toContain('Operations error (1)');
    expect(chased.output).toContain('a successful bind must be completed on the connection');
    expect(chased.output).toContain('exit=1');
  });

  it('with -C and a referral whose host does not resolve, the unfollowed referral is printed as without -C', async () => {
    const { workstation } = await buildLab();
    const output = await workstation.executeCommand(`ldapsearch -C ${referralSearch}; echo "exit=$?"`);
    expect(output).toContain('Referral (10)');
    expect(output).toContain('Referral: ldap://other.local/dc=other,dc=local');
    expect(output).toContain('exit=10');
  });
});
