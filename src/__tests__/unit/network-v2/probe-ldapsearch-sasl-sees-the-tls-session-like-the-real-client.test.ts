/**
 * Sonde : quand la connexion LDAP est protegee par TLS (`ldaps://` ou `-ZZ`),
 * le client `ldapsearch` donne a SASL la force de la session TLS comme SSF
 * externe et, si `SASL_CBINDING` le demande, la liaison de canal ; le DC
 * compare cette liaison a celle de son propre certificat. Un poste Linux
 * obtient un TGT du KDC du DC, puis interroge le DC et les lignes `SASL SSF`
 * et `SASL data security layer installed.` doivent etre celles du vrai client.
 *
 * Autorite : un vrai `ldapsearch` (OpenLDAP 2.6.10, GnuTLS 3.8.3, Cyrus SASL, MIT
 * Kerberos 1.20.1) face a un vrai slapd en TLS 1.3, AES-256-GCM, avec
 * `-O maxssf=N` pour N dans {0, 1, 255, 256, 257, 300, 511, 512, 513} ; le meme
 * jeu sans TLS pour {0, 1, 255, 256}. Constat : sous TLS la couche SASL n'est
 * choisie que si N depasse la force externe (256), integrite entre 257 et 511,
 * confidentialite a partir de 512 (= 256 + 256) ; sans TLS le seuil est N lui-meme.
 * La meme mesure avec une session AES-128-GCM (TLS_CIPHER_SUITE du vrai client)
 * place les seuils a 128 / 384 : le simulateur ne sait pas encore restreindre
 * ses suites (`TLS_CIPHER_SUITE` n'est pas encore evalue), la force 128 n'est donc
 * pas rejouee ici ; la table des tailles de cle par suite est epinglee dans
 * `probe-tls-channel-binding-matches-the-real-stack`.
 * Non attestable : ce que repond un controleur Active Directory a une liaison de
 * canal differente de la sienne (le simulateur applique la regle de l'accepteur
 * MIT : refus seulement si les deux cotes en fournissent et qu'elles different).
 *
 * Mesure avant la modification : sous TLS le simulateur annoncait une force
 * externe nulle — 7 des 20 cas tombent (maxssf = 1, 255, 256, 257, 300 et 511 sous
 * ldaps, et la meme chose sous StartTLS). Passent avant comme apres, chacun pour sa
 * raison : le temoin du laboratoire ; `maxssf=0`, qui supprime la couche dans les
 * deux modeles ; `maxssf=512` et `513` et la politique par defaut, ou la marge
 * 512 - 0 depasse deja 256 sans la force externe ; les quatre seuils sans TLS, qui
 * ne dependent pas du canal ; et les quatre cas de liaison, dont le serveur ne
 * verifiait aucune liaison avant : ils attestent la coherence client/serveur.
 */
import { describe, it, expect } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { ADMIN_PASSWORD, DC_ADDRESS, buildLab } from './openldap-lab-support';

const KRB5 = 'KRB5_CONFIG=/tmp/krb5.conf';
const SEARCH = `${KRB5} ldapsearch -Y GSSAPI -b dc=corp,dc=local -s base -LLL dn`;
const TLS_URL = 'ldaps://dc01.corp.local';
const PLAIN_URL = 'ldap://dc01.corp.local';

async function workstationWithTgt(): Promise<LinuxPC> {
  const { workstation } = await buildLab();
  await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
  await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' | sudo tee -a /etc/hosts > /dev/null`);
  await workstation.executeCommand(
    `printf '[libdefaults]\\n default_realm = CORP.LOCAL\\n dns_lookup_kdc = false\\n[realms]\\n CORP.LOCAL = {\\n  kdc = ${DC_ADDRESS}\\n }\\n' > /tmp/krb5.conf`,
  );
  await workstation.executeCommand(`echo '${ADMIN_PASSWORD}' | ${KRB5} kinit Administrator`);
  await workstation.executeCommand(`printf 'TLS_REQCERT never\\n' > /tmp/ldap.conf`);
  return workstation;
}

interface SaslLines { ssf: string | null; layer: boolean; found: boolean }

async function saslLines(workstation: LinuxPC, url: string, extra: string, conf = ''): Promise<SaslLines> {
  const environment = conf === '' ? 'LDAPCONF=/tmp/ldap.conf' : `LDAPCONF=${conf}`;
  const output = await workstation.executeCommand(`${environment} ${SEARCH} -H ${url} ${extra}`);
  return {
    ssf: /SASL SSF: (\d+)/.exec(output)?.[1] ?? null,
    layer: output.includes('SASL data security layer installed.'),
    found: output.includes('dn: DC=corp,DC=local'),
  };
}

const UNDER_TLS: readonly (readonly [number, string, boolean])[] = [
  [0, '0', false], [1, '0', false], [255, '0', false], [256, '0', false],
  [257, '1', true], [300, '1', true], [511, '1', true], [512, '256', true], [513, '256', true],
];

const WITHOUT_TLS: readonly (readonly [number, string, boolean])[] = [
  [0, '0', false], [1, '1', true], [255, '1', true], [256, '256', true],
];

describe('ldapsearch -Y GSSAPI over TLS to the domain controller', () => {
  it('the lab is sound', async () => {
    const workstation = await workstationWithTgt();
    expect((await saslLines(workstation, PLAIN_URL, '')).found).toBe(true);
  });

  for (const [maxssf, ssf, layer] of UNDER_TLS) {
    it(`ldaps with maxssf=${maxssf} reports SSF ${ssf}${layer ? ' with a layer' : ' and no layer'}`, async () => {
      const workstation = await workstationWithTgt();
      expect(await saslLines(workstation, TLS_URL, `-O maxssf=${maxssf}`)).toEqual({ ssf, layer, found: true });
    });
  }

  it('the default policy over ldaps still negotiates the confidentiality layer, as the real client does', async () => {
    const workstation = await workstationWithTgt();
    expect(await saslLines(workstation, TLS_URL, '')).toEqual({ ssf: '256', layer: true, found: true });
  });

  it('StartTLS gives the same strength to SASL as ldaps', async () => {
    const workstation = await workstationWithTgt();
    expect(await saslLines(workstation, PLAIN_URL, '-ZZ -O maxssf=256')).toEqual({ ssf: '0', layer: false, found: true });
    expect(await saslLines(workstation, PLAIN_URL, '-ZZ -O maxssf=300')).toEqual({ ssf: '1', layer: true, found: true });
  });

  for (const [maxssf, ssf, layer] of WITHOUT_TLS) {
    it(`without TLS maxssf=${maxssf} reports SSF ${ssf}${layer ? ' with a layer' : ' and no layer'}`, async () => {
      const workstation = await workstationWithTgt();
      expect(await saslLines(workstation, PLAIN_URL, `-O maxssf=${maxssf}`)).toEqual({ ssf, layer, found: true });
    });
  }
});

describe('SASL_CBINDING between ldapsearch and the domain controller', () => {
  async function withCbinding(workstation: LinuxPC, value: string): Promise<string> {
    await workstation.executeCommand(`printf 'TLS_REQCERT never\\nSASL_CBINDING ${value}\\n' > /tmp/cb.conf`);
    return '/tmp/cb.conf';
  }

  it('tls-endpoint over ldaps binds, which proves both ends compute the same end point', async () => {
    const workstation = await workstationWithTgt();
    const conf = await withCbinding(workstation, 'tls-endpoint');
    expect(await saslLines(workstation, TLS_URL, '', conf)).toEqual({ ssf: '256', layer: true, found: true });
  });

  it('tls-unique over TLS 1.3 sends no binding, as GnuTLS gives none there, and binds', async () => {
    const workstation = await workstationWithTgt();
    const conf = await withCbinding(workstation, 'tls-unique');
    expect(await saslLines(workstation, TLS_URL, '', conf)).toEqual({ ssf: '256', layer: true, found: true });
  });

  it('a value libldap does not know is ignored, and the bind goes through', async () => {
    const workstation = await workstationWithTgt();
    const conf = await withCbinding(workstation, 'bogus');
    expect(await saslLines(workstation, TLS_URL, '', conf)).toEqual({ ssf: '256', layer: true, found: true });
  });

  it('tls-endpoint without TLS has nothing to bind to, and binds', async () => {
    const workstation = await workstationWithTgt();
    const conf = await withCbinding(workstation, 'tls-endpoint');
    expect(await saslLines(workstation, PLAIN_URL, '', conf)).toEqual({ ssf: '256', layer: true, found: true });
  });
});
