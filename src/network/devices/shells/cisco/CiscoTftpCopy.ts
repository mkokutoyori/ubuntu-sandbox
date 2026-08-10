/**
 * `copy … tftp:` — un vrai transfert sur le fil.
 *
 * Ce que la commande faisait : `Writing tftp: ... [OK]` sans qu'aucune
 * trame ne quitte la machine. Une sauvegarde hors de l'équipement qui
 * annonce avoir réussi et n'a rien transmis est le pire défaut de ce
 * chapitre — on ne le découvre qu'au moment de restaurer, et il n'y a
 * alors plus rien à restaurer.
 *
 * Le client TFTP existait déjà (`src/network/tftp/`, RFC 1350 §4-5) et
 * n'avait qu'un test pour appelant : il était typé contre `EndHost`, ce
 * qu'un routeur n'est pas. `TftpEndpoint` est le port qui l'en dégage,
 * et `RouterUdpEndpoint` ce que le routeur et le commutateur remplissent
 * tous les deux — un Catalyst copie vers un serveur TFTP exactement
 * comme un ISR, donc les deux passent par ici plutôt que par deux
 * implémentations qui finiraient par diverger.
 *
 * L'adresse est écrite dans l'URL (`tftp://10.0.0.10/R1.cfg`). Un vrai
 * IOS la demande aussi par un dialogue (`Address or name of remote host
 * []?`), que ce simulateur exécute commande par commande ; la forme URL
 * est celle qu'IOS accepte également, et c'est la seule qui tienne en
 * une ligne.
 */
import { TftpClientSession } from '@/network/tftp/TftpSession';
import type { TftpEndpoint } from '@/network/tftp/types';
import { IPAddress } from '@/network/core/types';

/**
 * Le budget de retransmission de CE chemin, et pourquoi il n'est pas
 * celui de la RFC (5 s, 5 essais).
 *
 * `TransferIo` arme un `setTimeout` d'horloge REELLE, pas un minuteur du
 * `Scheduler` que le reste du simulateur avance a volonte. Un serveur
 * injoignable figerait donc le terminal de l'operateur pendant vingt-cinq
 * secondes sans une ligne de sortie — ce transcript ne montre pas les
 * points d'attente d'IOS au fur et a mesure, il rend le resultat d'un
 * coup. Le protocole est inchange : ce sont deux constantes de session,
 * ecrites ici plutot que subies.
 */
const COPY_TIMEOUT_MS = 1_000;
const COPY_MAX_RETRIES = 2;

export interface TftpUrl {
  readonly host: string;
  readonly file: string;
}

/**
 * `tftp://10.0.0.10/dir/R1.cfg` → hôte et fichier. Rend `null` quand
 * l'URL ne porte pas d'hôte : IOS le demanderait, et une URL sans
 * adresse ne désigne aucun serveur.
 */
export function parseTftpUrl(brut: string): TftpUrl | null {
  const m = /^tftp:\/\/([^/]+)(?:\/(.*))?$/i.exec(brut.trim());
  if (!m) return null;
  const host = m[1];
  if (!host) return null;
  return { host, file: (m[2] ?? '').replace(/^\/+/, '') };
}

/** Le message d'IOS quand l'URL ne nomme pas de serveur. */
export const TFTP_NO_HOST =
  '%Error: no remote host in the destination URL '
  + '(write it as tftp://<address>/<filename>).';

function erreurTftp(url: TftpUrl, raison: string): string {
  return `%Error opening tftp://${url.host}/${url.file} (${raison})`;
}

/**
 * IOS trace le transfert par un point par bloc, puis compte les octets.
 * Le débit n'est pas rapporté : la remise est synchrone ici, donc toute
 * durée serait inventée — et une mesure fausse vaut moins que son
 * absence.
 */
function traceTransfert(octets: number): string {
  const blocs = Math.max(1, Math.ceil(octets / 512));
  return '!'.repeat(Math.min(blocs, 50));
}

export async function tftpPut(
  endpoint: TftpEndpoint, url: TftpUrl, contenu: string,
): Promise<string> {
  if (!url.file) return erreurTftp(url, 'No such file or directory');
  let adresse: IPAddress;
  try { adresse = new IPAddress(url.host); }
  catch { return erreurTftp(url, 'Unknown host'); }

  const client = new TftpClientSession(endpoint, adresse, undefined, COPY_TIMEOUT_MS, COPY_MAX_RETRIES);
  const res = await client.put(url.file, contenu);
  if (!res.ok) return erreurTftp(url, res.error ?? 'Timed out');
  return `Address or name of remote host [${url.host}]?\n`
    + `Destination filename [${url.file}]?\n`
    + `${traceTransfert(contenu.length)}\n`
    + `${contenu.length} bytes copied`;
}

export async function tftpGet(
  endpoint: TftpEndpoint, url: TftpUrl,
): Promise<{ texte: string; trace: string } | { erreur: string }> {
  if (!url.file) return { erreur: erreurTftp(url, 'No such file or directory') };
  let adresse: IPAddress;
  try { adresse = new IPAddress(url.host); }
  catch { return { erreur: erreurTftp(url, 'Unknown host') }; }

  const client = new TftpClientSession(endpoint, adresse, undefined, COPY_TIMEOUT_MS, COPY_MAX_RETRIES);
  const res = await client.get(url.file);
  if (!res.ok || res.content === undefined) {
    return { erreur: erreurTftp(url, res.error ?? 'Timed out') };
  }
  return {
    texte: res.content,
    trace: `Accessing tftp://${url.host}/${url.file}...\n`
      + `${traceTransfert(res.content.length)}\n`,
  };
}
