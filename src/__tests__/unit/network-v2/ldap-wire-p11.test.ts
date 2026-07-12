/**
 * PRD-Windows-Server-Advanced.md §5 P11 — the remaining real LDAP wire
 * operations: `modifyDNRequest` (rename/move), `extendedRequest` StartTLS
 * (a genuine TLS 1.3 handshake over the already-open connection),
 * `abandonRequest`, the `controls` envelope field with RFC 2696 paged
 * results, and `searchResultReference` for a DN outside this DC's own
 * domain in a multi-domain forest — all against a real `DirectoryTree`
 * over a real `TcpStack`, exactly like `ldap-server-client.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DirectoryTree } from '@/network/devices/windows/server/ad/ldap/DirectoryTree';
import { parseDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';
import { LdapServerHandler, type LdapBindCheck } from '@/network/devices/windows/server/ad/ldap/LdapServer';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { parseFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilter';
import { LdapResultCode } from '@/network/devices/windows/server/ad/ldap/LdapMessage';
import { selfSignedLdapCert } from '@/network/devices/windows/server/ad/ldap/ldapStartTls';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function fixedPasswordAuth(dn: string, password: string): LdapBindCheck {
  return {
    checkBind: (name, pw) => name.toLowerCase() === dn.toLowerCase() && pw === password,
    resolvePrincipal: (name) => name,
  };
}

function buildLan() {
  const srv = new LinuxServer('linux-server', 'DC1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-srv').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  srv.getPorts()[0].configureIP(new IPAddress('192.168.31.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.31.20'), mask);
  return { srv, client };
}

const ADMIN_DN = 'CN=Administrator,DC=lab,DC=local';

describe('modifyDNRequest — rename and move (RFC 4511 §4.9)', () => {
  it('renames an entry in place, deleting the old RDN value', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    tree.addEntry([...parseDN('CN=Alice'), ...tree.getRootDn()], { objectClass: ['top', 'person'], cn: ['Alice'] });
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd') }).register(socket) });

    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    ldap.bind(ADMIN_DN, 'P@ssw0rd');

    const res = ldap.modifyDN('CN=Alice,DC=lab,DC=local', 'CN=Alicia', true);
    expect(res.ok).toBe(true);

    const oldSearch = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(cn=Alice)'));
    expect(oldSearch.entries).toHaveLength(0);
    const newSearch = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(cn=Alicia)'));
    expect(newSearch.entries).toHaveLength(1);
    expect(newSearch.entries[0].dn.toLowerCase()).toBe('cn=alicia,dc=lab,dc=local');
  });

  it('moves an entry under a new superior', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    tree.addEntry([...parseDN('OU=Sales'), ...tree.getRootDn()], { objectClass: ['top', 'organizationalUnit'], ou: ['Sales'] });
    tree.addEntry([...parseDN('OU=Engineering'), ...tree.getRootDn()], { objectClass: ['top', 'organizationalUnit'], ou: ['Engineering'] });
    tree.addEntry(
      [...parseDN('CN=Bob'), ...parseDN('OU=Sales'), ...tree.getRootDn()],
      { objectClass: ['top', 'person'], cn: ['Bob'] },
    );
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd') }).register(socket) });

    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    ldap.bind(ADMIN_DN, 'P@ssw0rd');

    const res = ldap.modifyDN('CN=Bob,OU=Sales,DC=lab,DC=local', 'CN=Bob', false, 'OU=Engineering,DC=lab,DC=local');
    expect(res.ok).toBe(true);

    const moved = ldap.search('OU=Engineering,DC=lab,DC=local', 'sub', parseFilter('(cn=Bob)'));
    expect(moved.entries).toHaveLength(1);
    const stillInSales = ldap.search('OU=Sales,DC=lab,DC=local', 'sub', parseFilter('(cn=Bob)'));
    expect(stillInSales.entries).toHaveLength(0);
  });

  it('fails cleanly renaming a non-existent entry', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd') }).register(socket) });
    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    ldap.bind(ADMIN_DN, 'P@ssw0rd');

    const res = ldap.modifyDN('CN=Ghost,DC=lab,DC=local', 'CN=Nobody', true);
    expect(res.ok).toBe(false);
    expect(res.result.resultCode).toBe(LdapResultCode.noSuchObject);
  });
});

describe('extendedRequest StartTLS — real TLS 1.3 handshake over the open LDAP connection (RFC 4511 §4.14.1)', () => {
  it('negotiates StartTLS then keeps operating normally, encrypted', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    tree.addEntry([...parseDN('CN=Alice'), ...tree.getRootDn()], { objectClass: ['top', 'person'], cn: ['Alice'] });
    const { cert, keyPair } = selfSignedLdapCert('LAB.LOCAL');
    srv.getTcpStack().listen(389, {
      onAccept: (socket) => new LdapServerHandler({
        tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd'),
        startTls: { serverCert: cert, serverPrivateKey: keyPair.privateKey },
      }).register(socket),
    });

    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    const verifier = new CertificateVerifier({ trustAnchors: [cert] });
    const tlsResult = ldap.startTls({ verifier });
    expect(tlsResult.ok).toBe(true);

    const bindRes = ldap.bind(ADMIN_DN, 'P@ssw0rd');
    expect(bindRes.ok).toBe(true);
    const search = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(cn=Alice)'));
    expect(search.ok).toBe(true);
    expect(search.entries).toHaveLength(1);
  });

  it('refuses StartTLS when the server has none configured', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd') }).register(socket) });
    const { cert } = selfSignedLdapCert('LAB.LOCAL');
    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const verifier = new CertificateVerifier({ trustAnchors: [cert] });
    const res = conn.client!.startTls({ verifier });
    expect(res.ok).toBe(false);
  });
});

describe('abandonRequest — fire-and-forget, never answered (RFC 4511 §4.11)', () => {
  it('does not crash the server or the connection, which stays usable afterwards', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    tree.addEntry([...parseDN('CN=Alice'), ...tree.getRootDn()], { objectClass: ['top', 'person'], cn: ['Alice'] });
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd') }).register(socket) });
    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    ldap.bind(ADMIN_DN, 'P@ssw0rd');

    expect(() => ldap.abandon(999)).not.toThrow();

    const search = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(cn=Alice)'));
    expect(search.ok).toBe(true);
    expect(search.entries).toHaveLength(1);
  });
});

describe('Paged results control (RFC 2696) — controls envelope field', () => {
  it('returns complete, non-overlapping pages across a result set larger than one page', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    for (let i = 0; i < 5; i++) {
      tree.addEntry([...parseDN(`CN=User${i}`), ...tree.getRootDn()], { objectClass: ['top', 'person'], cn: [`User${i}`] });
    }
    srv.getTcpStack().listen(389, { onAccept: (socket) => new LdapServerHandler({ tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd') }).register(socket) });
    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    ldap.bind(ADMIN_DN, 'P@ssw0rd');

    const allDns: string[] = [];
    let cookie: Uint8Array | undefined;
    for (let page = 0; page < 10; page++) {
      const result = ldap.search('DC=lab,DC=local', 'sub', parseFilter('(cn=*)'), [], { size: 2, cookie });
      expect(result.ok).toBe(true);
      allDns.push(...result.entries.map(e => e.dn.toLowerCase()));
      cookie = result.nextCookie;
      if (!cookie) break;
    }
    expect(allDns).toHaveLength(5);
    expect(new Set(allDns).size).toBe(5);
  });
});

describe('searchResultReference — a DN outside this domain in a multi-domain forest (RFC 4511 §4.5.2)', () => {
  it('returns a referral instead of an empty success', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    srv.getTcpStack().listen(389, {
      onAccept: (socket) => new LdapServerHandler({
        tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd'),
        otherForestDomainRoots: () => ['DC=child,DC=lab,DC=local'],
      }).register(socket),
    });
    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    ldap.bind(ADMIN_DN, 'P@ssw0rd');

    const result = ldap.search('OU=Users,DC=child,DC=lab,DC=local', 'sub', parseFilter('(cn=*)'));
    expect(result.ok).toBe(false);
    expect(result.result.resultCode).toBe(LdapResultCode.referral);
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.references[0]).toContain('OU=Users,DC=child,DC=lab,DC=local');
  });

  it('an unrelated out-of-tree DN with no matching forest domain still returns a plain (empty) success', () => {
    const { srv, client } = buildLan();
    const tree = new DirectoryTree('DC=lab,DC=local', { objectClass: ['top', 'domain'] });
    srv.getTcpStack().listen(389, {
      onAccept: (socket) => new LdapServerHandler({
        tree, auth: fixedPasswordAuth(ADMIN_DN, 'P@ssw0rd'),
        otherForestDomainRoots: () => ['DC=child,DC=lab,DC=local'],
      }).register(socket),
    });
    const conn = dialLdap(client.getTcpStack(), '192.168.31.10');
    const ldap = conn.client!;
    ldap.bind(ADMIN_DN, 'P@ssw0rd');

    const result = ldap.search('DC=unrelated,DC=example', 'sub', parseFilter('(cn=*)'));
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(0);
    expect(result.references).toHaveLength(0);
  });
});
