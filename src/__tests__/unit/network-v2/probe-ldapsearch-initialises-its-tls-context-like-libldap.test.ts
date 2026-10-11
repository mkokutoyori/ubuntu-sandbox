/**
 * Sonde : avant toute poignee de main, `ldapsearch` construit son contexte TLS
 * avec ce que disent `TLS_CACERT`, `TLS_CACERTDIR`, `TLS_CERT`, `TLS_KEY` et
 * `TLS_CRLFILE`, dans l'ordre de `tlsg_ctx_init` ; un echec arrete la connexion
 * avant tout octet TLS et se raconte en lignes `TLS:` sur `-d`. Un poste Linux
 * du laboratoire doit tenir les memes propos, ligne a ligne, que le vrai client.
 *
 * Autorite : un vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3) ; les 41 scenarios de
 * `openldap-tls-context-corpus.json` ont ete executes avec les memes fichiers
 * (chemins identiques sous /tmp/tlslab), chaque variable posee en prefixe de
 * commande, et leurs lignes `TLS:` consignees telles quelles. Source lue :
 * `tlsg_ctx_init`, `tlsg_getfile` et `ldap_pvt_tls_init_def_ctx` de
 * OPENLDAP_REL_ENG_2_6_10. Les textes « Error while reading file. »,
 * « No certificate was found. », « The requested data were not available. »,
 * « The certificate and the given key do not match. » et « Base64 decoding error. »
 * sont ceux de `gnutls_strerror` (mesures avec un petit programme C).
 *
 * Constats qui ont corrige le code : un `TLS_CACERT` introuvable etait pris pour
 * un magasin vide et la connexion continuait (le vrai client renonce, meme avec
 * `TLS_REQCERT never`) ; un `TLS_CACERT` absent retombait sur le magasin de
 * confiance de la machine, que le vrai client n'utilise pas ; `TLS_CERT` seul,
 * une paire cle/certificat qui ne se correspond pas ou un CRL illisible ne
 * faisaient rien ; une valeur vide (`LDAPTLS_CERT=`) valait une chaine vide au
 * lieu de « non defini ».
 *
 * Mesure avant la modification : 31 des 34 cas tombent. Passent avant comme apres,
 * chacun pour sa raison : le temoin du laboratoire ; les valeurs vides, qui
 * n'ont jamais eu d'effet (le contexte n'etait pas construit du tout) ; et le
 * libelle « (unknown error code) » d'un pair non approuve sous StartTLS.
 *
 * Ajout `TLS_CIPHER_SUITE` : `tlsg_ctx_init` juge la chaine de priorites AVANT tout
 * fichier (`tlsg_parse_ciphers`), un echec ecrit « TLS: could not set cipher
 * list <chaine>. » puis « TLS: init_def_ctx: . » (message vide : aucun
 * `gnutls_strerror` n'a encore ete enregistre) et arrete la connexion ; 12
 * scenarios mesures sur le vrai client (mot inconnu, sans protocole, NONE, sans
 * chiffrement, sans echange de cles, modificateur inconnu, espace finale
 * refusee et espace initiale toleree, chaine jugee avant le fichier CA, chaine
 * valide laissant le fichier CA echouer, valeur vide = non definie). Avant
 * l'ajout : 8 des 46 cas tombent (les huit refus) ; les quatre acceptations
 * (espace initiale, chaine valide, valeur vide, chaine valide + CA absent)
 * passent des deux cotes parce que la chaine n'etait alors pas evaluee du tout.
 *
 * Non attestable : le texte exact d'un fichier de cle chiffre (mot de passe
 * absent), non porte ici ; le contenu du magasin de confiance d'une vraie
 * Ubuntu (le simulateur n'en a aucun, la ligne d'avertissement de
 * `/etc/ssl/certs/ca-certificates.crt` vide apparait donc sous `-d`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { DC_ADDRESS, buildLab } from './openldap-lab-support';
import { loadJson } from './openldap-replay-support';

interface Scenario {
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly lines: readonly string[];
  readonly contextFails: boolean;
}

interface ContextCorpus {
  readonly files: Readonly<Record<string, string | null>>;
  readonly scenarios: readonly Scenario[];
}

const corpus = loadJson<ContextCorpus>('openldap-tls-context-corpus.json');
const LAB = '/tmp/tlslab';

function quoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function stage(workstation: LinuxPC): Promise<void> {
  await workstation.executeCommand(`mkdir -p ${LAB}/cadir_ok ${LAB}/emptydir`);
  for (const [name, content] of Object.entries(corpus.files)) {
    if (content !== null) workstation.writeFileFromEditor(`${LAB}/${name}`, content);
  }
}

function traceLines(output: string): string[] {
  return output.split('\n').filter((line) => /^(TLS:|tlsg)/.test(line)
    && !line.includes('peer cert untrusted') && !line.includes("can't connect"));
}

describe('ldapsearch builds its TLS context like libldap', () => {
  let workstation: LinuxPC;

  beforeAll(async () => {
    workstation = (await buildLab()).workstation;
    await stage(workstation);
  }, 120000);

  async function run(env: Readonly<Record<string, string>>, mode = `-H ldaps://${DC_ADDRESS}`): Promise<string> {
    const assignments = Object.entries(env).map(([name, value]) => `${name}=${quoted(value)}`).join(' ');
    return workstation.executeCommand(
      `LDAPCONF=${LAB}/empty.conf ${assignments} ldapsearch -d -1 -x ${mode} -b '' -s base -LLL dn 2>&1`,
    );
  }

  it('the lab is sound: the files of the corpus are in place', async () => {
    expect(await workstation.executeCommand(`ls ${LAB}`)).toContain('san_ok.pem');
    expect(await workstation.executeCommand(`ls ${LAB}/cadir_ok`)).toContain('ca.pem');
  });

  for (const scenario of corpus.scenarios) {
    it(`${scenario.name}: the TLS lines of -d are those of the real client`, async () => {
      const output = await run(scenario.env);
      expect(traceLines(output)).toEqual(scenario.lines);
      if (scenario.contextFails) expect(output).toContain("Can't contact LDAP server (-1)");
    });
  }

  it('a context failure under StartTLS reports a connect error with no additional information', async () => {
    const output = await run({ LDAPTLS_CACERT: `${LAB}/nonexistent.pem` }, `-H ldap://${DC_ADDRESS} -ZZ`);
    expect(output).toContain('ldap_start_tls: Connect error (-11)');
    expect(output).not.toContain('additional info');
  });

  it('an untrusted peer under StartTLS reports the TLS library wording as additional information', async () => {
    const output = await run({ LDAPTLS_CACERT: `${LAB}/san_ok.pem` }, `-H ldap://${DC_ADDRESS} -ZZ`);
    expect(output).toContain('ldap_start_tls: Connect error (-11)');
    expect(output).toContain('additional info: (unknown error code)');
  });

  it('TLS_REQCERT never does not rescue a context that cannot be built', async () => {
    const output = await run({ LDAPTLS_CACERT: `${LAB}/nonexistent.pem`, LDAPTLS_REQCERT: 'never' });
    expect(output).toContain("Can't contact LDAP server (-1)");
  });

  it('an unset TLS_CACERT trusts nothing, while the default bundle is the trust store of the machine', async () => {
    const lab = await buildLab();
    await stage(lab.workstation);
    await lab.workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' >> /etc/hosts`);
    await lab.workstation.executeCommand(`LDAPTLS_REQCERT=never ldapsearch -x -H ldaps://${DC_ADDRESS} -b '' -s base -LLL dn`);
    const identity = (lab.controller as unknown as { ldapStartTlsIdentity: { cert: X509Certificate } }).ldapStartTlsIdentity;
    expect(await lab.workstation.executeCommand('cat /etc/ssl/certs/ca-certificates.crt')).toBe('');
    lab.workstation.addTrustedCertificateAuthority(identity.cert);
    expect(await lab.workstation.executeCommand('cat /etc/ssl/certs/ca-certificates.crt')).toContain('BEGIN CERTIFICATE');
    const search = `ldapsearch -x -H ldaps://dc01.corp.local -b '' -s base -LLL dn 2>&1`;
    expect(await lab.workstation.executeCommand(search)).toContain('dn:');
    expect(await lab.workstation.executeCommand(`LDAPTLS_CACERT= ${search}`)).toContain("Can't contact LDAP server (-1)");
  }, 120000);
});
