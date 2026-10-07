/**
 * PRD-Windows-Server-Advanced.md §5 P3 — LDAP GSSAPI SASL bind (RFC 4511 §4.2,
 * RFC 4752) : le client obtient un vrai TGT puis un vrai billet de service
 * pour le compte machine du DC (§5 P1/P2), conduit l'echange en trois binds
 * (jeton AP-REQ, reponse AP-REP du serveur, offre puis choix de la couche de
 * securite, jetons wrap de RFC 4121) et, la couche choisie, chaque PDU
 * ulterieur traverse le fil enveloppe — valide de bout en bout sur une vraie
 * topologie cablee contre le chemin GSSAPI de `LdapServerHandler`.
 *
 * Mesure avant correction (le serveur verifiait un AP-REQ nu en un seul
 * aller-retour, sans couche de securite) : les 4 cas qui conduisent l'echange
 * RFC 4752 tombent. Passent avant et apres, sans que rien en depende : le
 * mecanisme refuse, le bind simple, le jeton nu (refuse dans les deux modeles)
 * et la recherche sans bind (temoin : le DC refuse bien l'anonyme).
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
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { LdapResultCode } from '@/network/devices/windows/server/ad/ldap/LdapMessage';
import { parseFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilter';
import { principalName, PrincipalNameType } from '@/network/kerberos/types';
import { GssInitiator } from '@/network/kerberos/gssapi/GssInitiator';
import { GSS_C_CONF_FLAG, GSS_C_INTEG_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG } from '@/network/kerberos/gssapi/GssToken';
import { MAX_BUFFER_FIELD, type LayerPolicy } from '@/network/ldap/gssapi/Rfc4752';
import type { Ticket } from '@/network/kerberos/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; client: LinuxServer }> {
  const dc = new WindowsServer('DC1');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.53.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.53.20'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  return { dc, client };
}

const NONE: LayerPolicy = { minSsf: 0, maxSsf: 0, externalSsf: 0, maxBufferSize: MAX_BUFFER_FIELD };
const INTEGRITY: LayerPolicy = { minSsf: 0, maxSsf: 1, externalSsf: 0, maxBufferSize: MAX_BUFFER_FIELD };
const CONFIDENTIALITY: LayerPolicy = { minSsf: 0, maxSsf: 256, externalSsf: 0, maxBufferSize: MAX_BUFFER_FIELD };

async function serviceTicket(client: LinuxServer, dc: WindowsServer): Promise<{ ticket: Ticket; sessionKey: Uint8Array }> {
  const kerb = dialKdc(client.getTcpStack(), '192.168.53.10').client!;
  const asResult = kerb.asExchange('alice', 'alicepw', 'LAB.LOCAL');
  expect(asResult.ok).toBe(true);
  const tgsResult = kerb.tgsExchange(
    asResult.ticket!, asResult.sessionKey!, principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), 'LAB.LOCAL', dc.getHostname(),
  );
  expect(tgsResult.ok).toBe(true);
  return { ticket: tgsResult.ticket!, sessionKey: tgsResult.sessionKey! };
}

function initiatorOver(client: LinuxServer, held: { ticket: Ticket; sessionKey: Uint8Array }, layerFlags: number): GssInitiator {
  return new GssInitiator({
    credential: {
      ticket: held.ticket, sessionKey: held.sessionKey,
      clientName: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), clientRealm: 'LAB.LOCAL',
    },
    requestedFlags: GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG | layerFlags,
    clock: { nowMicroseconds: () => Math.floor(client.getTcpStack().nowMs() * 1000) },
  });
}

describe('LDAP GSSAPI SASL bind — RFC 4752 exchange over TCP/389', () => {
  it('binds with a genuine Kerberos exchange, then searches without a security layer', async () => {
    const { dc, client } = await buildLan();
    const held = await serviceTicket(client, dc);
    const ldap = dialLdap(client.getTcpStack(), '192.168.53.10').client!;
    const bound = ldap.bindGssapi(initiatorOver(client, held, GSS_C_INTEG_FLAG), NONE);
    expect(bound.ok).toBe(true);
    expect(bound.result.resultCode).toBe(LdapResultCode.success);
    const found = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(sAMAccountName=alice)'));
    expect(found.entries).toHaveLength(1);
  });

  it('an integrity layer wraps every later PDU and the search still answers', async () => {
    const { dc, client } = await buildLan();
    const held = await serviceTicket(client, dc);
    const ldap = dialLdap(client.getTcpStack(), '192.168.53.10').client!;
    expect(ldap.bindGssapi(initiatorOver(client, held, GSS_C_INTEG_FLAG), INTEGRITY).ok).toBe(true);
    const found = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(sAMAccountName=alice)'));
    expect(found.entries).toHaveLength(1);
  });

  it('a confidentiality layer hides the PDU on the wire and the search still answers', async () => {
    const { dc, client } = await buildLan();
    const held = await serviceTicket(client, dc);
    const ldap = dialLdap(client.getTcpStack(), '192.168.53.10').client!;
    expect(ldap.bindGssapi(initiatorOver(client, held, GSS_C_INTEG_FLAG | GSS_C_CONF_FLAG), CONFIDENTIALITY).ok).toBe(true);
    const found = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(sAMAccountName=alice)'));
    expect(found.entries).toHaveLength(1);
    expect(found.entries[0].dn.toLowerCase()).toContain('alice');
  });

  it('rejects a GSSAPI exchange whose ticket session key is wrong', async () => {
    const { dc, client } = await buildLan();
    const held = await serviceTicket(client, dc);
    const ldap = dialLdap(client.getTcpStack(), '192.168.53.10').client!;
    const forged = initiatorOver(client, { ticket: held.ticket, sessionKey: new Uint8Array(32).fill(7) }, GSS_C_INTEG_FLAG);
    const bound = ldap.bindGssapi(forged, NONE);
    expect(bound.ok).toBe(false);
    expect(bound.result.resultCode).toBe(LdapResultCode.invalidCredentials);
  });

  it('rejects a bare AP-REQ presented as the credentials, which is not a GSS-API token', async () => {
    const { client } = await buildLan();
    const ldap = dialLdap(client.getTcpStack(), '192.168.53.10').client!;
    const bound = ldap.bindSasl('GSSAPI', new Uint8Array([0x6e, 0x03, 0x02, 0x01, 0x00]));
    expect(bound.ok).toBe(false);
    expect(bound.result.resultCode).toBe(LdapResultCode.invalidCredentials);
  });

  it('an unauthenticated connection cannot search', async () => {
    const { client } = await buildLan();
    const ldap = dialLdap(client.getTcpStack(), '192.168.53.10').client!;
    expect(ldap.search('DC=lab,DC=local', 'sub', parseFilter('(sAMAccountName=alice)')).ok).toBe(false);
  });

  it('only GSSAPI is offered: another mechanism is refused', async () => {
    const { client } = await buildLan();
    const ldapConn = dialLdap(client.getTcpStack(), '192.168.53.10');
    const bindRes = ldapConn.client!.bindSasl('DIGEST-MD5', new Uint8Array([1, 2, 3]));
    expect(bindRes.ok).toBe(false);
    expect(bindRes.result.resultCode).toBe(LdapResultCode.authMethodNotSupported);
  });

  it('still permits ordinary simple binds unaffected by the SASL extension', async () => {
    const { client } = await buildLan();
    const ldapConn = dialLdap(client.getTcpStack(), '192.168.53.10');
    const bindRes = ldapConn.client!.bind('Administrator', 'P@ssw0rd');
    expect(bindRes.ok).toBe(true);
  });

});
