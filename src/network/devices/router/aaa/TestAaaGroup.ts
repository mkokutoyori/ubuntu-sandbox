/**
 * `test aaa group <nom> <user> <mot de passe> {legacy | new-code}`
 * (`docs/PRD-Serveur-HTTP-Cisco.md` §5).
 *
 * Ce que la mesure a trouvé, et qui n'est pas ce que le PRD des accès
 * annonçait : le protocole TACACS+ EST implémenté (vrai TCP/49, vrai
 * chiffrement du corps, vrai délai de garde), `AaaAuthenticator
 * .testGroupAuthentication()` était ÉCRITE pour cette commande — son
 * commentaire cite la syntaxe — et `groupKind()` avec elle, « pour rendre
 * la ligne "using TACACS+"/"using radius" de `test aaa` ». Ce qui
 * manquait était la porte, et une seule des deux : la commande existait
 * dans `CiscoTerminalSession` (le terminal graphique) et nulle part dans
 * le shell de l'équipement, si bien que la même machine répondait à la
 * commande par un onglet et l'ignorait par l'autre.
 *
 * Le rendu vit donc ici, lu par les deux portes, plutôt que recopié.
 *
 * **Trois issues, pas deux.** Le verdict du moteur distingue déjà
 * `accept`, `reject` et `continue` — ce dernier voulant dire qu'aucun
 * serveur n'a répondu — et la porte existante rendait `continue` comme un
 * refus. C'est la confusion la plus coûteuse du diagnostic AAA : « le
 * serveur a dit non » envoie vérifier un mot de passe, « aucun serveur
 * n'a répondu » envoie vérifier une route, une clé partagée ou un
 * pare-feu. Les deux ont leur phrase, toutes deux attestées sur IOS.
 */
import type { AaaAuthenticator } from './AaaAuthenticator';

export type TestAaaOutcome = 'accept' | 'reject' | 'continue';

/** La première ligne, émise AVANT l'échange puisqu'elle l'annonce. */
export function testAaaAttemptLine(
  authenticator: Pick<AaaAuthenticator, 'groupKind'>, groupName: string,
): string {
  const kind = authenticator.groupKind(groupName) === 'radius' ? 'radius' : 'TACACS+';
  return `Attempting authentication test to server-group ${groupName} using ${kind}`;
}

/** La ligne de verdict, une fois l'échange terminé. */
export function testAaaVerdictLine(outcome: TestAaaOutcome): string {
  if (outcome === 'accept') return 'User was successfully authenticated.';
  if (outcome === 'reject') return 'User was NOT successfully authenticated.';
  return 'No authoritative response from any server.';
}

/**
 * L'échange complet. `legacy` et `new-code` désignent deux versions du
 * code d'appel interne d'IOS et non deux protocoles : le dialogue sur le
 * fil est le même, donc les deux mots mènent ici. Refuser `new-code`,
 * comme le faisait la porte existante, revenait à refuser la moitié de
 * la syntaxe pour une distinction qui ne change rien à ce qui est émis.
 */
export async function runTestAaaGroup(
  authenticator: AaaAuthenticator,
  groupName: string, username: string, password: string,
): Promise<string[]> {
  const first = testAaaAttemptLine(authenticator, groupName);
  const verdict = await authenticator.testGroupAuthentication(groupName, username, password);
  return [first, testAaaVerdictLine(verdict)];
}
