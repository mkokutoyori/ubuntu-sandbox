/**
 * Sonde : `ldapsearch -Y` / `-U` / `-w` / `-X` / `-R` / `-O` / `-I` / `-Q`
 * rejoue 116 executions du vrai client OpenLDAP (clone du depot officiel,
 * branche 2.5, compile ici avec Cyrus SASL 2.1.28 d'Ubuntu 24.04) face a un
 * vrai slapd dont les mecanismes viennent de libsasl2 et dont les mots de
 * passe sont lus par l'auxprop `slapd` : memes octets sur le fil, meme sortie
 * standard, meme sortie d'erreur, meme code de sortie.
 *
 * Le corpus (`openldap-ldapsearch-sasl-corpus.json`) a ete capture a travers
 * un relais qui enregistre chaque PDU. Il couvre PLAIN, LOGIN, ANONYMOUS,
 * EXTERNAL, CRAM-MD5, NTLM, DIGEST-MD5 (qualite de protection auth, auth-int
 * et auth-conf avec rc4-40, rc4-56, rc4, des et 3des, ce dernier refuse par
 * Ubuntu faute de cle a parite impaire), SCRAM-SHA-1/224/256/384/512, le choix
 * automatique du mecanisme annonce par le serveur, les proprietes `-O`
 * (none, minssf, maxssf, maxbufsize), les invites sur l'entree standard
 * (-U/-w absents, fin de fichier, -I), `-X u:` et `dn:`, `-R`, `-y`, `-P 2`,
 * et la couche de securite : 150 000 octets lus et un filtre de 70 000
 * octets ecrit traversent la couche chiffree en un ou plusieurs paquets. Les
 * nonces du client sont relus dans la capture (le generateur aleatoire du
 * simulateur rend les memes octets), le reste est calcule.
 *
 * Mesure avant la creation du module (port sans libsasl2) : 114 des 118 cas
 * tombent. Passent avant et apres : le decompte du corpus et les trois
 * scenarios `-P 2` (sasl-v2, scram-v2, digest-v2), que le client refuse avant
 * toute connexion (non-regression : le refus d'un bind SASL en LDAPv2 ne
 * depend pas du module).
 *
 * Temoin du laboratoire : « the replay refuses a request that differs from
 * the recorded one » change le mot de passe d'un scenario SCRAM et exige un
 * probleme de requete, preuve que la preuve client est bien comparee.
 *
 * Exclus, et pourquoi : GSSAPI et GS2-KRB5 (aucun KDC dans ce corpus), et les
 * lignes GnuTLS de `-d` avec `-ZZ`, que le binaire de reference ne produit
 * pas dans cette configuration. Non attestable ici : l'ensemble des greffons
 * du paquet Ubuntu 22.04 simule (libsasl2 2.1.27) face au 2.1.28 d'Ubuntu
 * 24.04 qui sert de reference.
 */
import { describe, it, expect } from 'vitest';
import {
  type Corpus, loadJson, replay, compareWithRecording,
} from './openldap-replay-support';

const corpus = loadJson<Corpus>('openldap-ldapsearch-sasl-corpus.json');

async function problemsOf(scenario: Corpus['scenarios'][number], args: readonly string[]): Promise<string[]> {
  const outcome = await replay(scenario, { args, files: corpus.files });
  return compareWithRecording(outcome, scenario, false);
}

describe('ldapsearch SASL replays the real OpenLDAP client', () => {
  it('the corpus carries the recorded scenarios', () => {
    expect(corpus.scenarios.length).toBe(116);
  });

  it('the replay refuses a request that differs from the recorded one', async () => {
    const scenario = corpus.scenarios.find((candidate) => candidate.name === 'scram-256-ok');
    expect(scenario).toBeDefined();
    const altered = scenario!.args.map((arg) => (arg === 'alicepw' ? 'bobpw' : arg));
    const problems = await problemsOf(scenario!, altered);
    expect(problems.some((problem) => problem.startsWith('request mismatch'))).toBe(true);
  });

  for (const scenario of corpus.scenarios) {
    it(`scenario ${scenario.name} matches the real client byte for byte`, async () => {
      expect(await problemsOf(scenario, scenario.args)).toEqual([]);
    });
  }
});
