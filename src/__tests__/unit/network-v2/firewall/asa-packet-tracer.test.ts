/**
 * `packet-tracer` — le rendu ASA de la simulation du socle.
 *
 * BRD-Firewall, invariant I-F3. La commande la plus utilisee d'un ASA en
 * exploitation, et celle ou la tentation de tricher est la plus forte :
 * il serait facile de rendre un texte plausible sans jamais consulter le
 * moteur. Ce fichier l'interdit, et pas seulement en lisant le code — il
 * CHANGE la politique et verifie que le rendu change avec elle, ce qu'un
 * texte fabrique ne pourrait pas faire.
 *
 * La forme est celle du vrai : une suite de `Phase: N` portant `Type:`,
 * `Subtype:`, `Result: ALLOW|DROP`, `Config:` et `Additional Information:`,
 * puis un bloc `Result:` final donnant l'interface d'entree et de sortie et
 * l'`Action:`. Le nom des phases est celui d'IOS (`ACCESS-LIST`, `NAT`,
 * `ROUTE-LOOKUP`, `FLOW-CREATION`) et non celui de nos etapes internes :
 * un operateur cherche `ACCESS-LIST` dans sa sortie, pas `policy-lookup`.
 *
 * Cinq cas passaient DEJA avant le correctif, et ils sont nommes ici plutot
 * que laisses a decouvrir : ce sont les cinq refus de grammaire, qui
 * passaient parce que la commande ENTIERE etait inconnue. Ils gardent
 * l'analyseur, ils ne prouvent rien du moteur — les quatorze autres, si.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { AsaShell } from '@/network/devices/firewall/vendors/asa/AsaShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function lab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
  const shell = new AsaShell(fw);

  run(shell, 'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'nameif inside',
    'ip address 192.168.1.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'nameif outside',
    'ip address 203.0.113.1 255.255.255.0', 'exit');

  return { fw, shell };
}

function run(shell: AsaShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = shell.execute(line);
  return last;
}

const TRACE = 'packet-tracer input inside tcp 192.168.1.10 44001 203.0.113.10 443';

beforeEach(() => { Logger.reset(); });

describe('packet-tracer — la forme du vrai', () => {
  it('rend des phases numerotees', () => {
    const { shell } = lab();

    expect(run(shell, TRACE)).toContain('Phase: 1');
  });

  it('chaque phase porte un Type et un Result', () => {
    const { shell } = lab();

    const out = run(shell, TRACE);

    expect(out).toContain('Type: ');
    expect(out).toMatch(/Result: (ALLOW|DROP)/);
  });

  it('nomme les phases comme IOS, pas comme nos etapes internes', () => {
    const { shell } = lab();

    const out = run(shell, TRACE);

    expect(out).toContain('ACCESS-LIST');
    expect(out).toContain('ROUTE-LOOKUP');
    expect(out).not.toContain('policy-lookup');
  });

  it('termine par un bloc Result nommant entree, sortie et action', () => {
    const { shell } = lab();

    const out = run(shell, TRACE);

    expect(out).toContain('input-interface: inside');
    expect(out).toContain('output-interface: outside');
    expect(out).toMatch(/Action: (allow|drop)/);
  });

  it('cree une phase FLOW-CREATION quand le paquet passe', () => {
    const { shell } = lab();

    expect(run(shell, TRACE)).toContain('FLOW-CREATION');
  });
});

describe('packet-tracer — il LIT le moteur, il ne recite pas', () => {
  it('inside vers outside passe par les niveaux de securite', () => {
    const { shell } = lab();

    expect(run(shell, TRACE)).toContain('Action: allow');
  });

  it('outside vers inside NE passe pas — et le rendu suit', () => {
    const { shell } = lab();

    const out = run(shell,
      'packet-tracer input outside tcp 203.0.113.10 44001 192.168.1.10 443');

    expect(out).toContain('Action: drop');
  });

  it('une regle de refus ajoutee CHANGE le verdict rendu', () => {
    const { fw, shell } = lab();
    const avant = run(shell, TRACE);
    fw.getPolicyStore().append({
      id: 'NON', from: ['GigabitEthernet0/0'], to: ['GigabitEthernet0/1'], action: 'deny',
    });
    fw.accessGroup('BLOQUE', 'GigabitEthernet0/0');

    const apres = run(shell, TRACE);

    expect(avant).toContain('Action: allow');
    expect(apres).toContain('Action: drop');
  });

  it('le refus NOMME la regle qui a tranche', () => {
    const { fw, shell } = lab();
    fw.getPolicyStore().append({
      id: 'ACL_NON', from: ['GigabitEthernet0/0'], to: ['GigabitEthernet0/1'], action: 'deny',
    });
    fw.accessGroup('BLOQUE', 'GigabitEthernet0/0');

    expect(run(shell, TRACE)).toContain('ACL_NON');
  });

  it('une destination sans route s\'arrete a ROUTE-LOOKUP', () => {
    const { shell } = lab();

    const out = run(shell,
      'packet-tracer input inside tcp 192.168.1.10 44001 198.51.100.7 443');

    expect(out).toContain('Action: drop');
    expect(out).toContain('ROUTE-LOOKUP');
  });

  it('le NAT configure apparait en phase NAT', () => {
    const { fw, shell } = lab();
    fw.getNatPolicy().append({
      id: 'N1',
      fromZone: ['inside'], toZone: ['outside'],
      type: 'dynamic-pat',
      sourceTranslation: { kind: 'dynamic-ip-and-port', translatedAddress: ['203.0.113.1'] },
    });

    const out = run(shell, TRACE);

    expect(out).toContain('NAT');
    expect(out).toContain('203.0.113.1');
  });
});

describe('packet-tracer — il ne laisse rien derriere lui', () => {
  it('n\'ajoute aucune connexion a `show conn`', () => {
    const { shell } = lab();

    run(shell, TRACE);

    expect(run(shell, 'show conn')).toContain('0 in use');
  });

  it('dix passages laissent la table intacte', () => {
    const { fw, shell } = lab();

    for (let index = 0; index < 10; index++) run(shell, TRACE);

    expect(fw.getSessionTable().count()).toBe(0);
  });
});

describe('packet-tracer — la grammaire', () => {
  it('refuse une interface inconnue', () => {
    const { shell } = lab();

    expect(run(shell, 'packet-tracer input fantome tcp 1.1.1.1 1 2.2.2.2 2'))
      .toContain('Invalid input');
  });

  it('refuse un protocole inconnu', () => {
    const { shell } = lab();

    expect(run(shell, 'packet-tracer input inside zorglub 1.1.1.1 1 2.2.2.2 2'))
      .toContain('Invalid input');
  });

  it('refuse une ligne incomplete', () => {
    const { shell } = lab();

    expect(run(shell, 'packet-tracer input inside tcp')).toContain('Invalid input');
  });

  it('accepte l\'icmp avec type et code', () => {
    const { shell } = lab();

    const out = run(shell, 'packet-tracer input inside icmp 192.168.1.10 8 0 203.0.113.10');

    expect(out).toContain('Phase: 1');
    expect(out).not.toContain('Invalid input');
  });

  it('`detailed` est accepte', () => {
    const { shell } = lab();

    expect(run(shell, `${TRACE} detailed`)).not.toContain('Invalid input');
  });

  it('la commande n\'existe qu\'en EXEC privilegie', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const shell = new AsaShell(new AsaFirewall('firewall-cisco', 'ASA2', 0, 0));

    expect(shell.execute(TRACE)).toContain('Invalid input');
  });
});
