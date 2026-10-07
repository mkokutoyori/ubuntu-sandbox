/**
 * Sonde : `ldapsearch -Y GSSAPI` depend du paquet libsasl2-modules-gssapi-mit
 * (le plugin libgssapiv2 de Cyrus SASL) et d'un cache d'identifiants
 * Kerberos, comme le client reel.
 *
 * Autorite : le vrai `ldapsearch` d'OpenLDAP 2.5 lie a Cyrus SASL 2.1.28 et a
 * MIT Kerberos 1.20.1, execute ici face a un vrai slapd (voir la sonde de
 * rejeu `probe-ldapsearch-gssapi-replays-the-real-client`). Sans plugin la
 * liste des mecanismes est vide (« No worthy mechs found ») ; avec le plugin
 * et sans cache, libgssapi_krb5 refuse avec le nom du cache par defaut.
 *
 * Mesure avant correction : le paquet n'existait pas dans la base
 * (`apt install` repondait « Unable to locate package ») et le plugin n'etait
 * pas charge : les 6 cas tombent. Le temoin « the lab is sound » (le poste lit
 * le rootDSE du DC) passe avant et apres.
 *
 * Non attestable ici : la version du paquet Ubuntu 22.04
 * (2.1.27+dfsg2-3ubuntu1.2), donnee de memoire ; le reel qui sert de reference
 * est le paquet 2.1.28 d'Ubuntu 24.04.
 */
import { describe, it, expect } from 'vitest';
import { DC_ADDRESS, buildLab } from './openldap-lab-support';

const PLUGIN_DIRECTORY = '/usr/lib/x86_64-linux-gnu/sasl2';
const GSSAPI_SEARCH = `ldapsearch -H ldap://${DC_ADDRESS} -Y GSSAPI -b dc=corp,dc=local -s base dn`;

describe('ldapsearch -Y GSSAPI needs its package and a credentials cache', () => {
  it('the lab is sound', async () => {
    const { workstation } = await buildLab();
    const rootDse = await workstation.executeCommand(`ldapsearch -x -H ldap://${DC_ADDRESS} -s base -b '' -LLL defaultNamingContext`);
    expect(rootDse).toContain('defaultNamingContext: DC=corp,DC=local');
  });

  it('without the package no mechanism is worthy', async () => {
    const { workstation } = await buildLab();
    const listing = await workstation.executeCommand(`ls ${PLUGIN_DIRECTORY}`);
    expect(listing).not.toContain('libgssapiv2.so');
    const out = await workstation.executeCommand(`${GSSAPI_SEARCH}; echo "exit=$?"`);
    expect(out).toContain('SASL(-4): no mechanism available: No worthy mechs found');
    expect(out).toContain('exit=250');
  });

  it('the package ships the GSSAPI and GS2 plugins and dpkg lists it', async () => {
    const { workstation } = await buildLab();
    await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
    const listing = await workstation.executeCommand(`ls ${PLUGIN_DIRECTORY}`);
    for (const name of ['libgssapiv2.so', 'libgssapiv2.so.2', 'libgssapiv2.so.2.0.25', 'libgs2.so', 'libgs2.so.2', 'libgs2.so.2.0.25']) {
      expect(listing).toContain(name);
    }
    expect(await workstation.executeCommand('dpkg -l libsasl2-modules-gssapi-mit')).toMatch(/^ii\s+libsasl2-modules-gssapi-mit\s+2\.1\.27\+dfsg2-3ubuntu1\.2/m);
  });

  it('with the package and no cache the credentials are reported missing, naming the default cache', async () => {
    const { workstation } = await buildLab();
    await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
    const uid = (await workstation.executeCommand('id -u')).trim();
    const out = await workstation.executeCommand(`${GSSAPI_SEARCH}; echo "exit=$?"`);
    expect(out).toContain('SASL/GSSAPI authentication started');
    expect(out).toContain('ldap_sasl_interactive_bind: Local error (-2)');
    expect(out).toContain(`GSSAPI Error: No credentials were supplied, or the credentials were unavailable or inaccessible (No Kerberos credentials available (default cache: FILE:/tmp/krb5cc_${uid}))`);
    expect(out).toContain('exit=254');
  });

  it('the cache named by KRB5CCNAME is the one reported', async () => {
    const { workstation } = await buildLab();
    await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
    const out = await workstation.executeCommand(`KRB5CCNAME=/tmp/elsewhere ${GSSAPI_SEARCH}`);
    expect(out).toContain('(No Kerberos credentials available (default cache: /tmp/elsewhere))');
  });

  it('removing the package removes the plugin again', async () => {
    const { workstation } = await buildLab();
    await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
    await workstation.executeCommand('apt remove -y libsasl2-modules-gssapi-mit');
    expect(await workstation.executeCommand(`ls ${PLUGIN_DIRECTORY}`)).not.toContain('libgssapiv2.so');
    expect(await workstation.executeCommand(GSSAPI_SEARCH)).toContain('No worthy mechs found');
  });
});
