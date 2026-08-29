import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { TcpWireOutcome } from '@/network/tcp/types';
/**
 * docs/PRD-OpenSSL.md §6 — le port étroit que la plateforme remplit.
 *
 * Le moteur `openssl` est séparé du `LinuxCommand` pour la même raison
 * que celui de `curl` : le jour où une seconde porte en a besoin (un
 * script de service, un test, un rôle Windows qui exporterait vers le
 * même format), elle doit pouvoir appeler le moteur sans passer par un
 * terminal.
 *
 * `randomBytes` passe par ce port plutôt que d'appeler `Math.random`
 * directement : sans cela `openssl rand` n'est pas testable et `genrsa`
 * rend une clé différente à chaque exécution du même scénario.
 */

export type TlsPeerProbe =
  | { readonly ok: true; readonly certificate: X509Certificate | null;
      readonly cipherSuite: string | null; readonly verified: boolean }
  | { readonly ok: false; readonly reason: string };

export interface OpenSslHost {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): boolean;
  fileExists(path: string): boolean;
  /** Millisecondes depuis l'époque — l'horloge de la machine simulée. */
  now(): number;
  randomBytes(n: number): Uint8Array;
  /** L'entrée standard, quand la commande est au bout d'un tube. */
  stdin(): string | null;

  /**
   * Le verdict d'une VRAIE connexion TCP — `s_client` (§P7).
   *
   * Synchrone, et ce n'est pas une simplification : dans ce simulateur la
   * livraison de trames l'est de bout en bout, ce dont
   * `EndHost.tcpConnectOutcome` tire déjà parti pour `nc` et `nmap`. La
   * rendre asynchrone ici aurait un coût réel et invisible : le runner
   * réseau teste `runWithStatusSync` AVANT `runWithStatus`, si bien
   * qu'une commande qui déclare les deux ne verrait jamais sa version
   * asynchrone appelée — et n'en déclarer qu'une casserait
   * `sudo openssl`, qui reste sur le chemin synchrone.
   */
  tcpConnect(ip: string, port: number): TcpWireOutcome;

  /**
   * La chaine REELLEMENT presentee par le pair, obtenue en deroulant la
   * poignee de main que `HttpsClientSession` deroule deja — meme pilote
   * (`runTlsHandshakeOverSocket`), donc `s_client` et `curl` ne peuvent pas
   * decrire deux certificats differents pour le meme serveur.
   */
  tlsPeerCertificate?(
    ip: string, port: number, servername?: string,
  ): TlsPeerProbe;

  /** Résolution par `/etc/hosts` — synchrone, pour la même raison. */
  resolveHost(nom: string): string | null;
}

export interface OpenSslResult {
  output: string;
  stderr: string;
  exitCode: number;
}

export function ok(output = ''): OpenSslResult {
  return { output, stderr: '', exitCode: 0 };
}

export function fail(stderr: string, exitCode = 1): OpenSslResult {
  return { output: '', stderr, exitCode };
}
