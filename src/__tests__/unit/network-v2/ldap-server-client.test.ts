/**
 * Real LDAP wire round-trip: `LdapServerHandler` on a real TCP/389
 * listener, `LdapClient` dialing across a real cable+switch, driving an
 * actual `DirectoryTree`. This exercises the same raw BER `Uint8Array`
 * PDUs a real LDAP client would exchange — not a JSON shortcut — so it
 * doubles as the integration test tying Ber/LdapDN/LdapFilter/
 * LdapMessage/DirectoryTree together over the network layer.
 *
 * `LdapServerHandler`/`LdapClient` are not yet wired into `WindowsServer`'s
 * boot sequence (that lands with the AD DS cmdlet layer), so this test
 * registers the listener directly on the device's own `TcpStack` — exactly
 * the pattern `WindowsPC`'s `listen(445, ...)`/`listen(5985, ...)` blocks
 * already use for SMB/WinRM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DirectoryTree } from '@/network/devices/windows/server/ad/ldap/DirectoryTree';
import { LdapServerHandler, type LdapBindCheck } from '@/network/devices/windows/server/ad/ldap/LdapServer';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { parseFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilter';
import { LdapResultCode } from '@/network/devices/windows/server/ad/ldap/LdapMessage';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function fixedPasswordAuth(dn: string, password: string): LdapBindCheck {
  return { checkBind: (name, pw) => name.toLowerCase() === dn.toLowerCase() && pw === password };
}

describe('LDAP wire round-trip — real BER PDUs over a real TcpStack', () => {
  it('binds, adds an entry, searches for it, compares an attribute, modifies it, then deletes it', () => {
    const srv = new WindowsServer('DC1');
    const client = new WindowsPC('windows-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const cSrv = new Cable('c-srv'); cSrv.connect(srv.getPorts()[0], sw.getPorts()[0]);
    const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    srv.getPorts()[0].configureIP(new IPAddress('192.168.30.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.30.20'), mask);

    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    const auth = fixedPasswordAuth('CN=Administrator,DC=lab,DC=local', 'P@ssw0rd');

    srv.getTcpStack().listen(389, {
      onAccept: (socket) => new LdapServerHandler({ tree, auth }).register(socket),
    });

    const conn = dialLdap(client.getTcpStack(), '192.168.30.10');
    expect(conn.ok).toBe(true);
    const ldap = conn.client!;

    const bindRes = ldap.bind('CN=Administrator,DC=lab,DC=local', 'P@ssw0rd');
    expect(bindRes.ok).toBe(true);
    expect(bindRes.result.resultCode).toBe(LdapResultCode.success);

    const addRes = ldap.add('OU=Users,DC=lab,DC=local', [
      { type: 'objectClass', values: ['top', 'organizationalUnit'] },
      { type: 'ou', values: ['Users'] },
    ]);
    expect(addRes.ok).toBe(true);

    const addUserRes = ldap.add('CN=Bob,OU=Users,DC=lab,DC=local', [
      { type: 'objectClass', values: ['top', 'person', 'user'] },
      { type: 'sAMAccountName', values: ['bob'] },
      { type: 'mail', values: ['bob@lab.local'] },
    ]);
    expect(addUserRes.ok).toBe(true);

    const searchRes = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(sAMAccountName=bob)'));
    expect(searchRes.ok).toBe(true);
    expect(searchRes.entries).toHaveLength(1);
    expect(searchRes.entries[0].dn).toBe('CN=Bob,OU=Users,DC=lab,DC=local');
    const mailAttr = searchRes.entries[0].attributes.find(a => a.type.toLowerCase() === 'mail');
    expect(mailAttr?.values).toEqual(['bob@lab.local']);

    const cmpTrue = ldap.compare('CN=Bob,OU=Users,DC=lab,DC=local', 'sAMAccountName', 'BOB');
    expect(cmpTrue.compareResult).toBe('true');
    const cmpFalse = ldap.compare('CN=Bob,OU=Users,DC=lab,DC=local', 'sAMAccountName', 'eve');
    expect(cmpFalse.compareResult).toBe('false');

    const modRes = ldap.modify('CN=Bob,OU=Users,DC=lab,DC=local', [
      { operation: 'replace', modification: { type: 'mail', values: ['bob2@lab.local'] } },
    ]);
    expect(modRes.ok).toBe(true);
    const searchAfterMod = ldap.search('CN=Bob,OU=Users,DC=lab,DC=local', 'base', parseFilter('(objectClass=*)'), ['mail']);
    expect(searchAfterMod.entries[0].attributes).toEqual([{ type: 'mail', values: ['bob2@lab.local'] }]);

    const delUserRes = ldap.delete('CN=Bob,OU=Users,DC=lab,DC=local');
    expect(delUserRes.ok).toBe(true);
    const searchAfterDelete = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(sAMAccountName=bob)'));
    expect(searchAfterDelete.entries).toHaveLength(0);

    ldap.unbind();
    expect(tree.getByDn(tree.getRootDn())).not.toBeNull();
  });

  it('rejects a bad bind password with invalidCredentials', () => {
    const srv = new WindowsServer('DC1');
    const client = new WindowsPC('windows-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const cSrv = new Cable('c-srv'); cSrv.connect(srv.getPorts()[0], sw.getPorts()[0]);
    const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    srv.getPorts()[0].configureIP(new IPAddress('192.168.30.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.30.20'), mask);

    const tree = new DirectoryTree('DC=lab,DC=local', {});
    const auth = fixedPasswordAuth('CN=Administrator,DC=lab,DC=local', 'P@ssw0rd');
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth }).register(socket) });

    const conn = dialLdap(client.getTcpStack(), '192.168.30.10');
    const bindRes = conn.client!.bind('CN=Administrator,DC=lab,DC=local', 'wrongpassword');
    expect(bindRes.ok).toBe(false);
    expect(bindRes.result.resultCode).toBe(LdapResultCode.invalidCredentials);
  });

  it('refuses search/add/modify/delete/compare before a successful bind (operationsError)', () => {
    const srv = new WindowsServer('DC1');
    const client = new WindowsPC('windows-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const cSrv = new Cable('c-srv'); cSrv.connect(srv.getPorts()[0], sw.getPorts()[0]);
    const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    srv.getPorts()[0].configureIP(new IPAddress('192.168.30.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.30.20'), mask);

    const tree = new DirectoryTree('DC=lab,DC=local', {});
    const auth = fixedPasswordAuth('CN=Administrator,DC=lab,DC=local', 'P@ssw0rd');
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth }).register(socket) });

    const conn = dialLdap(client.getTcpStack(), '192.168.30.10');
    const ldap = conn.client!;
    const searchRes = ldap.search('DC=lab,DC=local', 'base', parseFilter('(objectClass=*)'));
    expect(searchRes.ok).toBe(false);
    expect(searchRes.result.resultCode).toBe(LdapResultCode.operationsError);
  });

  it('allows anonymous bind (empty name and password)', () => {
    const srv = new WindowsServer('DC1');
    const client = new WindowsPC('windows-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const cSrv = new Cable('c-srv'); cSrv.connect(srv.getPorts()[0], sw.getPorts()[0]);
    const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    srv.getPorts()[0].configureIP(new IPAddress('192.168.30.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.30.20'), mask);

    const tree = new DirectoryTree('DC=lab,DC=local', {});
    const auth = fixedPasswordAuth('CN=Administrator,DC=lab,DC=local', 'P@ssw0rd');
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth }).register(socket) });

    const conn = dialLdap(client.getTcpStack(), '192.168.30.10');
    const bindRes = conn.client!.bind('', '');
    expect(bindRes.ok).toBe(true);
  });

  it('fails to dial when the cable is unplugged', () => {
    const srv = new WindowsServer('DC1');
    const client = new WindowsPC('windows-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const cSrv = new Cable('c-srv'); cSrv.connect(srv.getPorts()[0], sw.getPorts()[0]);
    const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    srv.getPorts()[0].configureIP(new IPAddress('192.168.30.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.30.20'), mask);

    const tree = new DirectoryTree('DC=lab,DC=local', {});
    const auth = fixedPasswordAuth('CN=Administrator,DC=lab,DC=local', 'P@ssw0rd');
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth }).register(socket) });

    cClient.disconnect();
    const conn = dialLdap(client.getTcpStack(), '192.168.30.10');
    expect(conn.ok).toBe(false);
  });
});
