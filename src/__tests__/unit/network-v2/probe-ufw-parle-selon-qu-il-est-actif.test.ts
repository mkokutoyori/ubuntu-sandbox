/**
 * `ufw' annoncait « Rule added » pare-feu ETEINT, la ou il dit « Rules updated ».
 *
 * MESURE DE DEPART sur `a40d2430', sur un serveur Linux neuf :
 *
 *   ufw allow 22/tcp                   -> Rule added
 *   ufw deny  22/tcp                   -> Rule updated
 *   ufw prepend deny from 10.9.9.9     -> Rule prepended
 *   ufw insert 1 allow 9090/tcp        -> Rule inserted
 *   ufw delete allow 9090/tcp          -> Rule deleted
 *   ufw delete 99                      -> ERROR: could not find a rule matching that number
 *   ufw default deny incoming          -> Default incoming policy changed to 'deny'
 *   ufw logging on                     -> Logging enabled (low)
 *   ufw app info Nope                  -> ERROR: Could not find a profile matching 'Nope'
 *   ufw app default skip               -> ERROR: invalid app command
 *   ufw reload                         -> Firewall reloaded
 *
 * AUTORITE. Le vrai `ufw' 0.36.2, installe sur l'Ubuntu 24.04.4 hote de
 * cette session, et sa source `/usr/lib/python3/dist-packages/ufw/'.
 * Transcriptions capturees, pare-feu ETEINT :
 *
 *   $ ufw allow 22/tcp                 -> Rules updated
 *   $ ufw allow 22/tcp                 -> Skipping adding existing rule
 *   $ ufw deny 22/tcp                  -> Rules updated
 *   $ ufw prepend deny from 10.9.9.9   -> Rules updated
 *   $ ufw insert 1 allow 9090/tcp      -> Rules updated
 *   $ ufw delete allow 9090/tcp        -> Rules updated
 *   $ ufw delete 99                    -> ERROR: Could not find rule '99'
 *   $ ufw default deny incoming        -> Default incoming policy changed to 'deny'
 *                                         (be sure to update your rules accordingly)
 *   $ ufw logging on                   -> Logging enabled
 *   $ ufw app info Nope                -> ERROR: Could not find profile 'Nope'
 *   $ ufw app default allow            -> Default application policy changed to 'allow'
 *   $ ufw reload                       -> Firewall not enabled (skipping reload)
 *
 * et pare-feu ALLUME (meme ufw, dans un netns pour ne pas couper l'hote) :
 *
 *   # ufw allow 2222/tcp               -> Rule added
 *   # ufw allow 2222/tcp               -> Skipping adding existing rule
 *   # ufw deny  2222/tcp               -> Rule updated
 *   # ufw insert 1 allow 3333/tcp      -> Rule inserted
 *   # ufw prepend deny from 10.1.1.1   -> Rule inserted
 *   # ufw delete allow 3333/tcp        -> Rule deleted
 *   # ufw delete allow 4444/tcp        -> Could not delete non-existent rule
 *   # ufw reload                       -> Firewall reloaded
 *
 * La regle est dans `backend_iptables.py:set_rule' l. 1099-1143 : le
 * message est d'abord « Rules updated », et il n'est remplace par
 * « Rule added/updated/inserted/deleted » que sous
 * `if self.is_enabled() and not self.dryrun'. Trois messages echappent a
 * cette bascule parce qu'ils sortent AVANT l'ecriture du fichier :
 * « Skipping adding existing rule », « Skipping inserting existing rule »
 * et « Could not delete non-existent rule » (l. 1072-1082).
 *
 * `prepend' n'a pas de message a lui : `frontend.py' le traite comme une
 * insertion en position 0, et le vrai ufw repond « Rule inserted ».
 *
 * La machine ecrivait cette table de messages a CINQ endroits — ajout,
 * ajout route, suppression par numero, suppression par specification,
 * insertion, prepend — chacun avec sa propre duplication « (v6) » ecrite
 * a la main. Un seul ecrivain la porte maintenant.
 *
 * MESURE : 15 cas tombent sur 20 (`git stash' sur LinuxFirewallManager.ts).
 * Les cinq cas qui passent des deux cotes sont nommes :
 *   - TEMOIN : « Skipping adding existing rule » ne bascule pas, et c'est
 *     lui qui prouve que le lab ecrit bien des regles ;
 *   - TEMOIN : pare-feu ALLUME, « Rule added » reste « Rule added » ;
 *   - NON-REGRESSION : la regle refusee reste refusee (`ufw status' la
 *     montre bien en DENY) ;
 *   - NON-REGRESSION : `ufw app list' garde son format ;
 *   - TEMOIN, pare-feu ALLUME : un remplacement d'action dit bien
 *     « Rule updated » — c'est la bascule que le lot ne doit pas casser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const serveur = (): LinuxServer => new LinuxServer('linux-server', 'SRV1');

describe('ufw eteint : toute ecriture repond « Rules updated »', () => {
  it('TEMOIN : une regle deja presente est signalee, pas reecrite', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw allow 22/tcp');
    expect(await srv.executeCommand('ufw allow 22/tcp')).toContain('Skipping adding existing rule');
  });

  it('un ajout repond « Rules updated »', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw allow 22/tcp')).toContain('Rules updated');
  });

  it('un ajout ne dit jamais « Rule added » pare-feu eteint', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw allow 22/tcp')).not.toContain('Rule added');
  });

  it('un remplacement d action repond « Rules updated »', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw allow 22/tcp');
    const out = await srv.executeCommand('ufw deny 22/tcp');
    expect(out).toContain('Rules updated');
    expect(out).not.toContain('Rule updated');
  });

  it('une insertion repond « Rules updated »', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw allow 22/tcp');
    const out = await srv.executeCommand('ufw insert 1 allow 9090/tcp');
    expect(out).toContain('Rules updated');
    expect(out).not.toContain('Rule inserted');
  });

  it('un prepend repond « Rules updated »', async () => {
    const srv = serveur();
    const out = await srv.executeCommand('ufw prepend deny from 10.9.9.9');
    expect(out).toContain('Rules updated');
    expect(out).not.toContain('Rule prepended');
  });

  it('une suppression repond « Rules updated »', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw allow 9090/tcp');
    const out = await srv.executeCommand('ufw delete allow 9090/tcp');
    expect(out).toContain('Rules updated');
    expect(out).not.toContain('Rule deleted');
  });

  it('NON-REGRESSION : la regle refusee est bien refusee dans le status', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw allow 22/tcp');
    await srv.executeCommand('ufw deny 22/tcp');
    await srv.executeCommand('ufw enable');
    const status = await srv.executeCommand('ufw status');
    expect(status).toMatch(/22\/tcp\s+DENY/);
    expect(status).not.toMatch(/22\/tcp\s+ALLOW/);
  });
});

describe('ufw allume : la table des messages vivants', () => {
  it('TEMOIN : un ajout repond « Rule added »', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw enable');
    expect(await srv.executeCommand('ufw allow 2222/tcp')).toContain('Rule added');
  });

  it('un remplacement d action repond « Rule updated »', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw enable');
    await srv.executeCommand('ufw allow 2222/tcp');
    expect(await srv.executeCommand('ufw deny 2222/tcp')).toContain('Rule updated');
  });

  it('un prepend repond « Rule inserted », comme une insertion', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw enable');
    const out = await srv.executeCommand('ufw prepend deny from 10.1.1.1');
    expect(out).toContain('Rule inserted');
    expect(out).not.toContain('Rule prepended');
  });
});

describe('les phrases que ufw emploie ailleurs', () => {
  it('un numero de regle inconnu est cite entre apostrophes', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw delete 99')).toBe("ERROR: Could not find rule '99'");
  });

  it('changer une politique par defaut rappelle de revoir ses regles', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw default deny incoming'))
      .toBe("Default incoming policy changed to 'deny'\n(be sure to update your rules accordingly)");
  });

  it('activer la journalisation n annonce pas son niveau', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw logging on')).toBe('Logging enabled');
  });

  it('un rechargement pare-feu eteint le dit', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw reload')).toBe('Firewall not enabled (skipping reload)');
  });

  it('un profil applicatif inconnu est cite sans « matching »', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw app info Nope')).toBe("ERROR: Could not find profile 'Nope'");
  });

  it('la politique applicative par defaut se change', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw app default allow'))
      .toBe("Default application policy changed to 'allow'");
  });

  it('NON-REGRESSION : `app list` garde son format', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw app list')).toContain('Available applications:');
  });

  it('la politique applicative se lit dans `status verbose` comme dans le fichier', async () => {
    const srv = serveur();
    await srv.executeCommand('ufw app default allow');
    await srv.executeCommand('ufw enable');
    expect(await srv.executeCommand('ufw status verbose')).toContain('New profiles: allow');
    expect(await srv.executeCommand('cat /etc/default/ufw'))
      .toContain('DEFAULT_APPLICATION_POLICY="ALLOW"');
  });

  it('un profil applicatif inconnu ne se met pas a jour', async () => {
    const srv = serveur();
    expect(await srv.executeCommand('ufw app update Nope'))
      .toBe("ERROR: Could not find profile 'Nope'");
  });
});
