/**
 * L'inspection lit un FLUX, pas un segment.
 *
 * §6.7 du carnet nomme le point de loin : « le filtrage de fichiers lit le
 * nombre magique en tete de corps, donc ne voit pas un fichier reparti sur
 * plusieurs segments ». La mesure montre que le defaut est plus large, et
 * qu'il n'est pas cosmetique : `inspectedFlowOf` construit son flux depuis
 * la charge utile d'UN paquet, donc TOUTE detection se contourne en
 * coupant l'envoi en deux. Un controle de securite qui tombe devant un
 * decoupage est un controle qui n'existe pas.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. Une signature EICAR coupee entre DEUX segments est DETECTEE. C'est
 *      le cas central : sans lui, les autres ne sont que du confort.
 *   2. Un fichier dont le nombre magique arrive APRES la frontiere de
 *      segment est type. Sur un vrai telechargement, le premier segment
 *      porte les en-tetes HTTP et le corps commence dans le suivant.
 *   3. Le tampon est BORNE par `oversize-limit` (megaoctets, defaut 10,
 *      minimum 1), le reglage que FortiOS porte exactement pour cela.
 *   4. Au-dela de la borne, le comportement est celui de FortiOS et il
 *      est LAXISTE : le fichier passe SANS etre analyse. `set options
 *      oversize` demande de le bloquer. La valeur par defaut est celle de
 *      Fortinet ; la durcir « pour etre plus sur » ferait mentir le
 *      simulateur sur ce que fait la vraie machine.
 *   5. Les deux SENS d'une connexion ne se melangent pas : une signature
 *      dont la moitie monte et l'autre moitie descend n'est pas une
 *      signature, et la recoller en serait une invention.
 *   6. Deux CONNEXIONS distinctes ne se melangent pas davantage.
 *   7. UDP n'est PAS reassemble : deux datagrammes DNS colles produiraient
 *      un message que personne n'a envoye.
 *   8. Le tampon d'une session disparait quand la session se ferme, sinon
 *      le pare-feu fuit de la memoire a chaque connexion.
 *
 * Le decoupage est fait au niveau du FIL — deux `socket.write` sur une
 * meme connexion TCP a travers le pare-feu — parce que c'est exactement
 * le geste qu'on veut eprouver. `curl` enverrait tout d'un bloc et ne
 * prouverait rien.
 *
 * Le serveur du laboratoire ECOUTE sans repondre, et ce n'est pas un
 * detail : monte d'abord sur `nginx`, le laboratoire ne prouvait RIEN —
 * le serveur repondait `400 Bad Request` et fermait la connexion avant
 * le second `write`, donc un seul segment traversait et le cas aurait pu
 * passer ou echouer sans rien dire du reassemblage. Il ecoute sur le
 * port 80 parce que c'est le port que `profile-protocol-options` declare
 * comme HTTP : sur un autre port le flux n'est pas classe `http` et le
 * profil antivirus ne s'applique pas — ce qui est le comportement d'un
 * vrai FortiGate, et non un contournement.
 *
 * Discrimination (`git stash push -- src/network/`) : 6 des 14 cas
 * tombent avant correctif. Les 8 autres sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve le mecanisme :
 *   - les CINQ cas de modele (`new StreamAssembler(...)`) passent des
 *     deux cotes parce que `git stash` ne touche pas un fichier NEUF non
 *     suivi : l'assembleur n'est pas revenu en arriere, seul son cablage
 *     l'est. Ils eprouvent la regle, pas l'equipement ;
 *   - les deux TEMOINS (signature d'un bloc, envoi propre coupe en deux)
 *     passent des deux cotes, et c'est leur objet : sans eux, un
 *     laboratoire mal bati et un defaut du produit seraient
 *     indiscernables — c'est exactement le piege dans lequel la premiere
 *     version de ce fichier est tombee ;
 *   - « un seuil hors bornes est refuse » passait parce que le mot-cle
 *     entier etait refuse, faute d'exister.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  EICAR_SIGNATURE,
} from '@/network/devices/firewall/inspection/ContentInspector';
import {
  StreamAssembler,
} from '@/network/devices/firewall/inspection/StreamAssembler';
import { makeFlowKey } from '@/network/devices/firewall/session/FlowKey';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const CLIENT_IP = '192.168.1.10';
const SERVER_IP = '203.0.113.10';

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  const sh = new FortiShell(fw);
  const poste = new LinuxPC('linux-pc', 'POSTE', -100, 0);
  const serveur = new LinuxServer('linux-server', 'WEB', 100, 0);

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, serveur.getPort('eth0')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', `ip addr add ${CLIENT_IP}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(serveur, ['ip link set eth0 up', `ip addr add ${SERVER_IP}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);
  serveur.getTcpStack().listen(80, { onAccept: () => undefined });

  return { fw, sh, poste, serveur };
}

function politique(sh: FortiShell, ...extra: string[]): string {
  return run(sh,
    'config firewall policy', 'edit 1',
    'set name "SORTIE"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    ...extra, 'next', 'end');
}

function profilAntivirus(sh: FortiShell): void {
  run(sh, 'config antivirus profile', 'edit "AV"',
    'config http', 'set av-scan block', 'end', 'next', 'end');
}

function profilFichiers(sh: FortiShell, type: string): void {
  run(sh, 'config file-filter profile', 'edit "FF"',
    'config rules', 'edit "bloque"',
    `set file-type "${type}"`, 'set action block',
    'next', 'end', 'next', 'end');
}

async function envoyerEnDeuxTemps(
  poste: LinuxPC, premier: string, second: string,
): Promise<void> {
  const socket = await poste.tcpConnect(SERVER_IP, 80);
  expect(socket, 'la connexion TCP n a pas abouti').not.toBeNull();
  socket?.write(premier);
  socket?.write(second);
}

function bloquees(fw: FortiGate, raison: string): number {
  return fw.recentTraces()
    .filter(trace => trace.verdict?.reason === raison).length;
}

beforeEach(() => { Logger.reset(); });

describe('le flux est reassemble avant d etre inspecte', () => {
  it('une signature coupee entre DEUX segments est detectee', async () => {
    const { fw, sh, poste } = await laboratoire();
    profilAntivirus(sh);
    politique(sh, 'set utm-status enable', 'set av-profile "AV"');

    const coupe = Math.floor(EICAR_SIGNATURE.length / 2);
    await envoyerEnDeuxTemps(poste,
      `POST / HTTP/1.0\r\nHost: cible\r\n\r\n${EICAR_SIGNATURE.slice(0, coupe)}`,
      EICAR_SIGNATURE.slice(coupe));

    expect(bloquees(fw, 'utm-virus')).toBeGreaterThan(0);
  });

  it('temoin — la meme signature envoyee d un bloc est detectee aussi',
    async () => {
      const { fw, sh, poste } = await laboratoire();
      profilAntivirus(sh);
      politique(sh, 'set utm-status enable', 'set av-profile "AV"');

      await envoyerEnDeuxTemps(poste,
        `POST / HTTP/1.0\r\nHost: cible\r\n\r\n${EICAR_SIGNATURE}`, 'fin');

      expect(bloquees(fw, 'utm-virus')).toBeGreaterThan(0);
    });

  it('temoin — un envoi propre coupe en deux passe', async () => {
    const { fw, sh, poste } = await laboratoire();
    profilAntivirus(sh);
    politique(sh, 'set utm-status enable', 'set av-profile "AV"');

    await envoyerEnDeuxTemps(poste,
      'POST / HTTP/1.0\r\nHost: cible\r\n\r\nbonjour ', 'tout le monde');

    expect(bloquees(fw, 'utm-virus')).toBe(0);
  });

  it('un nombre magique COUPE par la frontiere de segment est type',
    async () => {
      const { fw, sh, poste } = await laboratoire();
      profilFichiers(sh, 'pdf');
      politique(sh, 'set utm-status enable', 'set file-filter-profile "FF"');

      const corps = '%PDF-1.7 contenu du document';
      await envoyerEnDeuxTemps(poste,
        `POST / HTTP/1.0\r\nHost: cible\r\nContent-Length: ${corps.length}\r\n\r\n`
        + corps.slice(0, 3),
        corps.slice(3));

      expect(bloquees(fw, 'utm-file-type')).toBeGreaterThan(0);
    });
});

describe('le tampon d un flux est borne, et la borne est celle de FortiOS', () => {
  it('`oversize-limit` se regle et se relit', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
    const sh = new FortiShell(fw);

    run(sh, 'config firewall profile-protocol-options', 'edit "PPO"',
      'config http', 'set oversize-limit 3', 'end', 'next', 'end');

    expect(run(sh, 'show firewall profile-protocol-options "PPO"'))
      .toContain('set oversize-limit 3');
  });

  it('sa valeur par defaut est 10 megaoctets', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
    const sh = new FortiShell(fw);

    run(sh, 'config firewall profile-protocol-options', 'edit "PPO"',
      'next', 'end');

    expect(run(sh,
      'show full-configuration firewall profile-protocol-options "PPO"'))
      .toContain('set oversize-limit 10');
  });

  it('un seuil hors bornes est REFUSE', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
    const sh = new FortiShell(fw);

    run(sh, 'config firewall profile-protocol-options', 'edit "PPO"',
      'config http');
    const refus = run(sh, 'set oversize-limit 0');
    run(sh, 'end', 'next', 'end');

    expect(refus).not.toBe('');
  });

  it('au-dela de la borne, le flux passe SANS etre analyse — le defaut'
    + ' de FortiOS', () => {
    const assembleur = new StreamAssembler({ limitBytes: 32 });
    const cle = makeFlowKey('10.0.0.1', 1000, '10.0.0.2', 80, 6);

    assembleur.append(cle, 'a'.repeat(30));
    const flux = assembleur.append(cle, `xx${EICAR_SIGNATURE}`);

    expect(flux.oversize).toBe(true);
    expect(flux.payload.length).toBeLessThanOrEqual(32);
    expect(flux.payload).not.toContain(EICAR_SIGNATURE);
  });

  it('`set options oversize` BLOQUE au lieu de laisser passer', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
    const sh = new FortiShell(fw);

    run(sh, 'config firewall profile-protocol-options', 'edit "PPO"',
      'config http', 'set options oversize', 'end', 'next', 'end');

    expect(run(sh, 'show firewall profile-protocol-options "PPO"'))
      .toContain('set options oversize');
    expect(fw.getUtmProfiles().getProtocolOptions('PPO').blockOversize).toBe(true);
  });
});

describe('un flux appartient a UNE connexion et a UN sens', () => {
  it('les deux SENS ne se melangent pas', () => {
    const assembleur = new StreamAssembler({ limitBytes: 4096 });
    const coupe = Math.floor(EICAR_SIGNATURE.length / 2);
    const montant = makeFlowKey('10.0.0.1', 1000, '10.0.0.2', 80, 6);
    const descendant = makeFlowKey('10.0.0.2', 80, '10.0.0.1', 1000, 6);

    assembleur.append(montant, EICAR_SIGNATURE.slice(0, coupe));
    const retour = assembleur.append(descendant, EICAR_SIGNATURE.slice(coupe));

    expect(retour.payload).not.toContain(EICAR_SIGNATURE);
  });

  it('deux CONNEXIONS ne se melangent pas', () => {
    const assembleur = new StreamAssembler({ limitBytes: 4096 });
    const coupe = Math.floor(EICAR_SIGNATURE.length / 2);
    const premiere = makeFlowKey('10.0.0.1', 1000, '10.0.0.2', 80, 6);
    const seconde = makeFlowKey('10.0.0.1', 1001, '10.0.0.2', 80, 6);

    assembleur.append(premiere, EICAR_SIGNATURE.slice(0, coupe));
    const autre = assembleur.append(seconde, EICAR_SIGNATURE.slice(coupe));

    expect(autre.payload).not.toContain(EICAR_SIGNATURE);
  });

  it('UDP n est PAS reassemble', () => {
    const assembleur = new StreamAssembler({ limitBytes: 4096 });
    const cle = makeFlowKey('10.0.0.1', 40000, '10.0.0.2', 53, 17);

    assembleur.append(cle, 'premier');
    const second = assembleur.append(cle, 'second');

    expect(second.payload).toBe('second');
  });

  it('le tampon disparait quand la session se ferme', () => {
    const assembleur = new StreamAssembler({ limitBytes: 4096 });
    const cle = makeFlowKey('10.0.0.1', 1000, '10.0.0.2', 80, 6);

    assembleur.append(cle, 'debut ');
    expect(assembleur.size()).toBe(1);

    assembleur.forget(cle);
    expect(assembleur.size()).toBe(0);
    expect(assembleur.append(cle, 'suite').payload).toBe('suite');
  });

  it('une session fermee par le pare-feu libere son tampon', async () => {
    const { fw, sh, poste } = await laboratoire();
    profilAntivirus(sh);
    politique(sh, 'set utm-status enable', 'set av-profile "AV"');

    await envoyerEnDeuxTemps(poste,
      'POST / HTTP/1.0\r\nHost: cible\r\n\r\nbonjour ', 'tout le monde');
    expect(fw.getStreamAssembler().size()).toBeGreaterThan(0);

    for (const session of fw.getSessionTable().view().all()) {
      fw.getSessionTable().close(session, 'clear');
    }
    expect(fw.getStreamAssembler().size()).toBe(0);
  });
});
