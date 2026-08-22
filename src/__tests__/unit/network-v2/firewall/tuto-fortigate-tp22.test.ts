/**
 * TP 22 — rendre le pare-feu bavard, rejoue etape par etape.
 *
 * Ecrit A L'AVEUGLE contre le tutoriel. Huit des dix-sept cas tombent.
 *
 * Ce que la mesure a trouve :
 *
 *   1. **`set max-size` etait refuse** : la table portait un `max-lines`
 *      qui n'existe sur AUCUNE version de FortiOS — la vraie borne le
 *      tampon en OCTETS. Le nom invente rendait la commande du tutoriel
 *      intapable, et la borne compte desormais vraiment des octets.
 *   2. **Aucune modification de configuration n'etait journalisee.**
 *      L'etape 7 enseigne « un pare-feu journalise qui l'a modifie », et
 *      la categorie 1 ne contenait rien : seul le portail
 *      d'authentification ecrivait un evenement. Chaque objet commis
 *      ecrit maintenant l'evenement de FortiOS — `logid="0100044547"`,
 *      `cfgpath`, `cfgobj`, `cfgattr`, `action`, `user`, `msg`.
 *   3. **Le format d'un journal quotait les mauvais champs.** La regle
 *      etait « tout ce qui n'est pas un nombre passe entre guillemets »,
 *      ce qui donnait `srcip="192.168.10.10"` et `logid=0000000020`. La
 *      vraie regle est PAR CHAMP : l'echantillon publie par Fortinet ecrit
 *      `srcip=10.1.100.11` sans guillemets et `logid="0000000013"` avec.
 *   4. **`diagnose hardware sysinfo conserve` n'existait pas**, alors que
 *      le §23.6 fait du conserve mode « une panne silencieuse » a
 *      reconnaitre.
 *
 * Deux affirmations du tutoriel sont FAUSSES et le test suit la machine
 * plutot que le texte, plutot que de forcer le produit a mentir :
 *
 *   - l'etape 5 attend le refus implicite dans le journal sans rien
 *     activer ; un vrai FortiGate ne le journalise pas non plus tant que
 *     `config log setting` / `set fwpolicy-implicit-log enable` n'est pas
 *     pose, et le laboratoire le pose ;
 *   - l'etape 8 lit les compteurs dans `get firewall policy`, qui rend la
 *     liste des cles sur une vraie machine ; les compteurs se lisent par
 *     `diagnose firewall iprope show`, et c'est ce que le cas verifie —
 *     la regle empruntee compte, celle qui ne l'est jamais reste a zero.
 *
 * Le « Resultat attendu » du tutoriel se contredit lui-meme (il annonce
 * le blocage web en categorie 1 et les modifications en categorie 2,
 * alors que ses propres etapes ecrivent 3 et 1). Les etapes ont raison.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const lan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const dmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(lan.getPort('eth0')!, fgt.getPort('port1')!);
  new Cable('dmz').connect(dmz.getPort('eth0')!, fgt.getPort('port2')!);

  await taper(fgt, [
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall policy',
    'edit 1', 'set name "LAN-vers-DMZ-web"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "HTTP"',
    'set action accept', 'next',
    'edit 2', 'set name "Jamais-utilisee"',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end',
  ]);

  await taper(lan, [
    'ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(dmz, [
    'ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
    'ip route add default via 192.168.20.1',
  ]);
  await dmz.executeCommand('systemctl start nginx');

  return { fgt, lan, dmz };
}

async function journalisation(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config log memory setting', 'set status enable', 'end',
    'config log memory global-setting', 'set max-size 98304', 'end',
    'config log setting', 'set fwpolicy-implicit-log enable', 'end',
    'config firewall policy',
    'edit 1', 'set logtraffic all', 'set logtraffic-start enable', 'next',
    'edit 2', 'set logtraffic all', 'next', 'end',
  ]);
}

describe('TP 22 — Rendre ton pare-feu bavard', () => {
  it('etape 1 : la journalisation memoire se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config log memory setting', 'set status enable', 'end',
      'config log memory global-setting', 'set max-size 98304', 'end',
    ]));

    const conf = await fgt.executeCommand('show log memory setting');
    expect(conf).toContain('set status enable');
    expect(await fgt.executeCommand('show log memory global-setting'))
      .toContain('set max-size 98304');
  });

  it('etape 2 : `logtraffic all` et `logtraffic-start` se declarent', async () => {
    const { fgt } = await laboratoire();
    propre(await journalisation(fgt));

    const conf = await fgt.executeCommand('show firewall policy');
    expect(conf).toContain('set logtraffic all');
    expect(conf).toContain('set logtraffic-start enable');
  });

  it('etape 4 : le trafic AUTORISE se retrouve en categorie 0', async () => {
    const { fgt, lan } = await laboratoire();
    await journalisation(fgt);
    await lan.executeCommand('curl -sS http://192.168.20.10/');

    await taper(fgt, [
      'execute log filter reset',
      'execute log filter category 0',
      'execute log filter field srcip 192.168.10.10',
      'execute log filter view-lines 20',
    ]);
    const vue = await fgt.executeCommand('execute log display');

    expect(vue).not.toBe('No matching log data.');
    expect(vue).toContain('srcip=192.168.10.10');
    expect(vue).toContain('logid="0000000020"');
    expect(vue).toContain('type="traffic"');
    expect(vue).toMatch(/action="(accept|start|close)"/);
  });

  it('etape 5 : le trafic REFUSE porte `policyid=0`', async () => {
    const { fgt, lan } = await laboratoire();
    await journalisation(fgt);
    await lan.executeCommand('ping -c 2 192.168.20.10');

    await taper(fgt, [
      'execute log filter reset',
      'execute log filter category 0',
      'execute log filter field action deny',
    ]);
    const vue = await fgt.executeCommand('execute log display');

    expect(vue).not.toBe('No matching log data.');
    expect(vue).toContain('action="deny"');
    expect(vue).toContain('policyid=0');
    expect(vue).toContain('proto=1');
  });

  it('etape 4/5 : le FILTRE persiste, et `reset` le vide vraiment', async () => {
    const { fgt, lan } = await laboratoire();
    await journalisation(fgt);
    await lan.executeCommand('curl -sS http://192.168.20.10/');
    await lan.executeCommand('ping -c 1 192.168.20.10');

    await taper(fgt, [
      'execute log filter reset',
      'execute log filter category 0',
      'execute log filter field action deny',
    ]);
    const refuse = await fgt.executeCommand('execute log display');
    expect(refuse).not.toMatch(/action="(accept|start|close)"/);

    await taper(fgt, ['execute log filter reset', 'execute log filter category 0']);
    const tout = await fgt.executeCommand('execute log display');
    expect(tout).toContain('action="deny"');
    expect(tout).toMatch(/action="(accept|start|close)"/);
  });

  it('etape 6 : le blocage web se retrouve en categorie 3, PAS en 0', async () => {
    const { fgt, lan } = await laboratoire();
    await journalisation(fgt);
    await taper(fgt, [
      'config webfilter urlfilter',
      'edit 1', 'set name "Interdits"',
      'config entries',
      'edit 1', 'set url "example.com"', 'set type simple', 'set action block',
      'next', 'end', 'next', 'end',
      'config firewall policy', 'edit 1', 'set service "ALL"', 'next', 'end',
      'config webfilter profile',
      'edit "Filtre-Web"',
      'config web', 'set urlfilter-table 1', 'end',
      'next', 'end',
      'config firewall policy',
      'edit 1', 'set utm-status enable',
      'set webfilter-profile "Filtre-Web"', 'set inspection-mode flow',
      'next', 'end',
    ]);
    await lan.executeCommand(
      'curl -sS -H "Host: example.com" http://192.168.20.10/');

    await taper(fgt, ['execute log filter reset', 'execute log filter category 3']);
    const web = await fgt.executeCommand('execute log display');
    expect(web).not.toBe('No matching log data.');
    expect(web).toContain('type="utm"');
    expect(web).toContain('subtype="webfilter"');

    await taper(fgt, ['execute log filter reset', 'execute log filter category 0']);
    expect(await fgt.executeCommand('execute log display'))
      .not.toContain('subtype="webfilter"');
  });

  it('etape 7 : les evenements systeme sont en categorie 1', async () => {
    const { fgt } = await laboratoire();
    await journalisation(fgt);
    await taper(fgt, [
      'config firewall address',
      'edit "TRACE"', 'set subnet 10.1.2.3 255.255.255.255', 'next', 'end',
    ]);

    await taper(fgt, ['execute log filter reset', 'execute log filter category 1']);
    const vue = await fgt.executeCommand('execute log display');

    expect(vue).not.toBe('No matching log data.');
    expect(vue).toContain('type="event"');
    expect(vue).toContain('subtype="system"');
    expect(vue).toContain('logid="0100044547"');
    expect(vue).toContain('cfgpath="firewall.address"');
    expect(vue).toContain('cfgobj="TRACE"');
    expect(vue).toContain('action="Add"');
    expect(vue).toContain('msg="Add firewall.address TRACE"');
  });

  it('etape 7 : le journal nomme QUI a modifie', async () => {
    const { fgt } = await laboratoire();
    await journalisation(fgt);
    await taper(fgt, [
      'config system admin',
      'edit "operateur"', 'set password "MotDePasse1!"',
      'set accprofile "super_admin"', 'next', 'end',
    ]);

    await taper(fgt, ['execute log filter reset', 'execute log filter category 1']);
    expect(await fgt.executeCommand('execute log display')).toMatch(/user="\S+"/);
  });

  it('etape 7 : une MODIFICATION dit ce qui a change, une SUPPRESSION le dit aussi',
    async () => {
      const { fgt } = await laboratoire();
      await journalisation(fgt);
      await taper(fgt, [
        'config firewall address',
        'edit "MUABLE"', 'set subnet 10.1.2.3 255.255.255.255', 'next', 'end',
      ]);
      await taper(fgt, ['execute log delete-all']);

      await taper(fgt, [
        'config firewall address',
        'edit "MUABLE"', 'set comment "revue 2026"', 'next', 'end',
      ]);
      await taper(fgt, ['execute log filter reset', 'execute log filter category 1']);
      const edition = await fgt.executeCommand('execute log display');
      expect(edition).toContain('action="Edit"');
      expect(edition).toContain('cfgattr="comment"');

      await taper(fgt, ['execute log delete-all']);
      await taper(fgt, ['config firewall address', 'delete "MUABLE"', 'end']);
      await taper(fgt, ['execute log filter reset', 'execute log filter category 1']);
      const suppression = await fgt.executeCommand('execute log display');
      expect(suppression).toContain('action="Delete"');
      expect(suppression).toContain('msg="Delete firewall.address MUABLE"');
    });

  it('etape 7 : une commande qui ne change RIEN ne journalise rien', async () => {
    const { fgt } = await laboratoire();
    await journalisation(fgt);
    await taper(fgt, [
      'config firewall address',
      'edit "STABLE"', 'set subnet 10.4.5.6 255.255.255.255', 'next', 'end',
    ]);
    await taper(fgt, ['execute log delete-all']);

    await taper(fgt, [
      'config firewall address', 'edit "STABLE"', 'next', 'end',
    ]);

    await taper(fgt, ['execute log filter reset', 'execute log filter category 1']);
    expect(await fgt.executeCommand('execute log display'))
      .toBe('No matching log data.');
  });

  it('etape 1 : `max-size` BORNE vraiment le tampon memoire', async () => {
    const { fgt, lan } = await laboratoire();
    await journalisation(fgt);
    await taper(fgt, [
      'config log memory global-setting', 'set max-size 400', 'end',
    ]);

    for (let tour = 0; tour < 6; tour++) {
      await lan.executeCommand('ping -c 1 192.168.20.10');
    }

    const magasin = fgt.getLogStore();
    expect(magasin.getMaxBytes()).toBe(400);
    expect(magasin.usedBytes()).toBeLessThanOrEqual(400);
    expect(magasin.all().length).toBeGreaterThan(0);
  });

  it('etape 7 : `execute log filter category ?` liste les categories', async () => {
    const { fgt } = await laboratoire();
    const aide = await fgt.executeCommand('execute log filter category ?');
    expect(aide).toContain('traffic');
    expect(aide).toContain('event');
    expect(aide).toMatch(/webfilter/);
  });

  it('etape 8 : `get firewall policy` rend la LISTE des cles, pas des compteurs',
    async () => {
      const { fgt } = await laboratoire();
      const vue = await fgt.executeCommand('get firewall policy');
      expect(vue).toContain('== [ 1 ]');
      expect(vue).toContain('policyid: 1');
      expect(vue).not.toMatch(/bytes/);
    });

  it('etape 8 : une regle jamais empruntee reste a ZERO, et ca se COMPTE',
    async () => {
      const { fgt, lan } = await laboratoire();
      await journalisation(fgt);
      await lan.executeCommand('curl -sS http://192.168.20.10/');

      const empruntee = await fgt.executeCommand(
        'diagnose firewall iprope show 100004 1');
      const inutile = await fgt.executeCommand(
        'diagnose firewall iprope show 100004 2');

      expect(empruntee).toMatch(/hit count:\s*[1-9]/);
      expect(inutile).toMatch(/hit count:\s*0/);
    });

  it('etape 9 : les indicateurs systeme repondent', async () => {
    const { fgt } = await laboratoire();
    for (const commande of [
      'get system performance status',
      'get system session status',
      'diagnose hardware sysinfo conserve',
      'diagnose autoupdate versions',
    ]) {
      expect(await fgt.executeCommand(commande))
        .not.toMatch(/Unknown action|unknown path|unknown command/i);
    }
  });

  it('etape 10 : le collecteur syslog externe recoit vraiment', async () => {
    const { fgt, lan } = await laboratoire();
    const collecteur = new LinuxPC('linux-pc', 'COLLECTEUR', -200, 100);
    new Cable('col').connect(collecteur.getPort('eth0')!, fgt.getPort('port3')!);
    await taper(fgt, [
      'config system interface', 'edit "port3"', 'set mode static',
      'set ip 192.168.30.1 255.255.255.0', 'next', 'end',
    ]);
    await taper(collecteur, [
      'ip link set eth0 up', 'ip addr add 192.168.30.60/24 dev eth0',
      'ip route add default via 192.168.30.1',
    ]);
    await journalisation(fgt);

    propre(await taper(fgt, [
      'config log syslogd setting',
      'set status enable',
      'set server "192.168.30.60"',
      'set port 514',
      'set facility local7',
      'end',
    ]));

    const avant = collecteur.getPort('eth0')!.getCounters().framesIn;
    await lan.executeCommand('curl -sS http://192.168.20.10/');
    expect(collecteur.getPort('eth0')!.getCounters().framesIn).toBeGreaterThan(avant);
  });

  it('les journaux memoire DISPARAISSENT quand on les efface', async () => {
    const { fgt, lan } = await laboratoire();
    await journalisation(fgt);
    await lan.executeCommand('curl -sS http://192.168.20.10/');

    await taper(fgt, ['execute log filter reset', 'execute log filter category 0']);
    expect(await fgt.executeCommand('execute log display'))
      .not.toBe('No matching log data.');

    expect(await fgt.executeCommand('execute log delete-all'))
      .toMatch(/log entries deleted/);
    expect(await fgt.executeCommand('execute log display'))
      .toBe('No matching log data.');
  });
});
