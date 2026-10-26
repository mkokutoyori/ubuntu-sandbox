/**
 * Mesure : LinuxLastlogRegistry.record relisait tout /var/log/lastlog en octets puis le reconvertissait en texte caractere par caractere pour modifier un
 * enregistrement de 292 octets. Le fichier mesure 292 octets x uid : 292 Ko pour l'utilisateur 1000, 14,6 Mo pour l'uid 50000. Dans Chromium, 200 postes
 * Linux passaient 1,7 s dans cette conversion a la creation.
 *
 * L'enregistrement est maintenant remplace par decoupe du texte ; la lecture ne convertit que ses 292 octets.
 *
 * Discrimine par `git stash push -- src/network/devices/linux/LinuxLastlogRegistry.ts` : le cas de la duree tombe (30 enregistrements sur l'uid 50000 : plusieurs
 * secondes avant, moins de 1,5 s apres). Passent des deux cotes, TEMOINS : la relecture de l'enregistrement et l'ecrasement de l'enregistrement precedent.
 */
import { describe, it, expect } from 'vitest';
import { LinuxLastlogRegistry } from '@/network/devices/linux/LinuxLastlogRegistry';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function registry(uid: number): LinuxLastlogRegistry {
  const lastlog = new LinuxLastlogRegistry();
  lastlog.bindUidResolver(() => uid);
  lastlog.attachVfs(new VirtualFileSystem());
  return lastlog;
}

describe('lastlog ne reecrit que l enregistrement de l utilisateur', () => {
  it('30 enregistrements sur l uid 50000 tiennent sous 1,5 s', () => {
    const lastlog = registry(50000);
    const startedAt = performance.now();
    for (let login = 0; login < 30; login++) lastlog.record('big', '10.0.0.1', 'pts/0', 1_700_000_000_000 + login * 1000);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  }, 60_000);

  it('TEMOIN — l enregistrement relu est celui qui vient d etre ecrit', () => {
    const lastlog = registry(1000);
    lastlog.record('user', '192.168.1.5', 'pts/3', 1_700_000_005_000);
    expect(lastlog.getCurrent('user')).toEqual({ when: 1_700_000_005_000, sourceHost: '192.168.1.5', tty: 'pts/3' });
  });

  it('TEMOIN — une seconde connexion ecrase la premiere et la rend comme precedente', () => {
    const lastlog = registry(1000);
    lastlog.record('user', '192.168.1.5', 'pts/3', 1_700_000_005_000);
    const before = lastlog.record('user', '10.0.0.9', 'pts/4', 1_700_000_009_000);
    expect(before?.sourceHost).toBe('192.168.1.5');
    expect(lastlog.getCurrent('user')?.sourceHost).toBe('10.0.0.9');
    expect(lastlog.getPrevious('user')?.tty).toBe('pts/3');
  });

  it('TEMOIN — clearUser efface l enregistrement', () => {
    const lastlog = registry(1000);
    lastlog.record('user', '192.168.1.5', 'pts/3', 1_700_000_005_000);
    lastlog.clearUser('user');
    expect(lastlog.getCurrent('user')).toBeUndefined();
  });
});
