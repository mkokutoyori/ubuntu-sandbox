import type { NameServiceSwitch } from '../nss/NameServiceSwitch';
import type { INssSource } from '../nss/INssSource';
import type { NssHostEntry, NssResult } from '../nss/types';

/**
 * Le nom d'une adresse, tel que `getnameinfo` le rend : la chaine
 * `/etc/nsswitch.conf` est parcourue en entier, donc `/etc/hosts` puis le
 * DNS, et non l'une des deux. `traceroute` et `nmap` posent la meme
 * question et lisent desormais la meme reponse — deux resolutions
 * inverses finiraient par nommer un routeur ici et pas la.
 *
 * Comme la base `hosts` de `getent`, c'est la seule qui puisse partir sur
 * le reseau, donc la seule a exister en deux versions. Ce qui DECIDE — la
 * recherche faite, ce qui compte comme trouve — vit ici une fois, et les
 * deux pilotes ne different que par le droit d'attendre.
 */
const lookupSpec = (ip: string) => ({
  invoke: (s: INssSource) => s.gethostbyaddr?.(ip),
  invokeAsync: (s: INssSource) => s.gethostbyaddrAsync?.(ip),
});

function readName(result: NssResult<NssHostEntry>): string | null {
  if (result.status !== 'SUCCESS') return null;
  const name = result.entry?.canonicalName;
  return name ? name : null;
}

export function reverseNameOf(nss: NameServiceSwitch, ip: string): string | null {
  try {
    return readName(nss.lookup<NssHostEntry>('hosts', lookupSpec(ip).invoke));
  } catch {
    return null;
  }
}

/** L'autre sens, par la meme chaine : ce que `getaddrinfo` repond. */
export async function forwardAddressOfAsync(
  nss: NameServiceSwitch, name: string,
): Promise<string | null> {
  try {
    const r = await nss.lookupAsync<NssHostEntry[]>(
      'hosts',
      (s) => s.gethostbynameAsync?.(name, 2) ?? s.gethostbyname?.(name, 2),
    );
    if (r.status !== 'SUCCESS') return null;
    return r.entry?.[0]?.address ?? null;
  } catch {
    return null;
  }
}

export async function reverseNameOfAsync(
  nss: NameServiceSwitch, ip: string,
): Promise<string | null> {
  const spec = lookupSpec(ip);
  try {
    // La regle de `getent` : une source sans jumeau asynchrone est
    // interrogee par sa methode synchrone — `files` lit le VFS et n'a
    // rien a attendre. L'oublier faisait sauter `/etc/hosts` entier.
    return readName(await nss.lookupAsync<NssHostEntry>(
      'hosts', (s) => spec.invokeAsync(s) ?? spec.invoke(s)));
  } catch {
    return null;
  }
}
