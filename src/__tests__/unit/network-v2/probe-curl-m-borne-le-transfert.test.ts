/**
 * curl 8.5.0 (lib/multi.c, multi_handle_timeout / Curl_timeleft) : `-m SECONDS` borne le transfert ENTIER. Un serveur qui accepte la
 * connexion puis se tait donne `curl: (28) Operation timed out after N milliseconds with 0 bytes received` et non `(52) Empty reply`.
 *
 * Mesure de depart : (52) tout de suite, aucun temps ne s'ecoulait (Http1ClientSession.sendAsync comptait des tours de micro-taches).
 * Sans -m, le comportement ne change pas (la boucle de micro-taches reste le contrat des serveurs synchrones).
 * Temoin : un serveur qui repond encore sous -m rend sa page.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { labo, demarrer, ecrireConf } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('curl -m et un serveur muet', () => {
  it('(28) apres le delai demande, pas (52) tout de suite', async () => {
    const lab = labo();
    lab.back.executeCommand('sh -c "nc -l -p 8080 > /dev/null &"');
    const avant = Date.now();
    const sortie = await lab.front.executeCommand('curl -m 1 http://10.0.0.2:8080/');
    expect(sortie).toMatch(/curl: \(28\) Operation timed out after \d+ milliseconds with 0 bytes received/);
    expect(Date.now() - avant).toBeGreaterThanOrEqual(900);
  }, 20_000);

  it('temoin : un serveur qui repond rend sa page sous -m', async () => {
    const lab = labo();
    await demarrer(lab, 'server {\n  listen 80;\n  location / { return 200 "bonjour"; }\n}\n');
    expect(await lab.back.executeCommand('curl -s -m 5 http://10.0.0.1/')).toBe('bonjour');
  });
});
