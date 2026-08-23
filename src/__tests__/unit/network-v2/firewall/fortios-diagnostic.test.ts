/**
 * Phase 4 : le diagnostic et les journaux — et les laboratoires L5 et L6.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait, verifie contre
 * la documentation Fortinet et une transcription reelle du renifleur
 * avant d'ecrire une ligne de produit.
 *
 * Quatre points ne sont pas cosmetiques :
 *
 *   1. **`diagnose debug flow` lit la trace que le paquet a SUIVIE.**
 *      C'est la meme source que `packet-tracer` de l'ASA : `ctx.trace`.
 *      Une seconde trace ecrite pour l'affichage serait une trace qui
 *      peut mentir, et c'est precisement ce que le socle a prevu
 *      d'eviter (OT-6).
 *   2. **`policy 0` est la regle implicite.** Un apprenant qui voit
 *      cette ligne sait qu'AUCUNE politique ne correspond, et c'est
 *      90 % des diagnostics. La confondre avec la politique 1 enverrait
 *      chercher une erreur de configuration la ou il manque une regle.
 *   3. **`logtraffic all` journalise a la FERMETURE**, avec les octets
 *      et la duree ; `logtraffic-start enable` ajoute une ligne a
 *      l'ouverture. Deux lignes pour une session, et c'est mesurable.
 *      `utm` — le defaut — ne journalise que ce qu'un profil a
 *      declenche, donc rien tant qu'aucun profil n'existe.
 *   4. **`diagnose sys session clear` SANS filtre purge tout.** C'est
 *      l'erreur d'exploitation classique et elle doit se reproduire.
 *
 * Discriminee par `git stash push -- src/network/` : 40 des 44 cas
 * tombent avant correctif. Les 4 restants sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve le mecanisme :
 *
 *   - « sans traduction, la session est `act=noop` » passait parce que
 *     l'ancien rendu ecrivait `act=noop` en dur, pour toutes les
 *     sessions y compris traduites ;
 *   - « `filter clear` rend la table entiere » et « `clear` avec filtre
 *     ne purge que ce qui correspond » passaient parce qu'aucun filtre
 *     n'existait et qu'aucune purge n'avait lieu ;
 *   - « `get system status` suit le nom d'hote » passait parce que
 *     l'ancienne vue a quatre lignes lisait deja le nom.
 *
 * Deux affirmations ecrites a l'aveugle ont ete RENVERSEES par la
 * mesure, et les deux fois c'est la sonde qui avait tort :
 *
 *   - les champs d'un journal FortiOS sont **entre guillemets**
 *     (`type="traffic"`), mais la regle est PAR CHAMP et non par forme de
 *     valeur : `logid="0000000015"` est entre guillemets bien qu'il ne
 *     contienne que des chiffres, et `srcip=192.168.1.10` n'y est pas ;
 *   - la regle implicite ne journalise **PAS** par defaut : il faut
 *     `config log setting` / `set fwpolicy-implicit-log enable`, que
 *     Fortinet laisse desactive pour ne pas noyer le collecteur.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FORTIOS_PROFILE } from '@/network/devices/firewall/vendors/fortios/FortiProfile';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

async function laboratoire() {
  const { fw, sh } = shell();
  const poste = new LinuxPC('linux-pc', 'POSTE', -100, 0);
  const internet = new LinuxPC('linux-pc', 'INTERNET', 100, 0);

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, internet.getPort('eth0')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1',
    'set dst 0.0.0.0 0.0.0.0', 'set gateway 203.0.113.10', 'set device "port2"',
    'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(internet, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, sh, poste, internet };
}

function politique(sh: FortiShell, ...extra: string[]): void {
  run(sh,
    'config firewall policy', 'edit 1',
    'set name "SORTIE"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set nat enable', ...extra, 'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('diagnose sys session', () => {
  it('rend le format complet, lu depuis la table reelle', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, 'diagnose sys session list');

    expect(vu).toMatch(/^session info: proto=1 proto_state=00 duration=\d+ expire=\d+ timeout=\d+$/m);
    expect(vu).toContain('statistic(bytes/packets/allow_err):');
    expect(vu).toMatch(/^orgin->sink: org pre->post, reply pre->post dev=\d+->\d+\/\d+->\d+$/m);
    expect(vu).toMatch(/^misc=0 policy_id=1 auth_info=0 chk_client_info=0 vd=0$/m);
    expect(vu).toMatch(/^total session \d+$/m);
  });

  it('la traduction de source apparait en `act=snat`', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, 'diagnose sys session list');

    expect(vu).toContain('hook=post dir=org act=snat');
    expect(vu).toContain('192.168.1.10');
    expect(vu).toContain('203.0.113.1');
  });

  it('sans traduction, la session est `act=noop`', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    run(sh, 'config firewall policy', 'edit 1', 'set nat disable', 'next', 'end');
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, 'diagnose sys session list');

    expect(vu).toContain('act=noop');
    expect(vu).not.toContain('act=snat');
  });

  it('un filtre restreint la liste', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const retenu = run(sh, 'diagnose sys session filter src 192.168.1.10',
      'diagnose sys session list');
    const ecarte = run(sh, 'diagnose sys session filter src 10.0.0.1',
      'diagnose sys session list');

    expect(retenu).toContain('session info:');
    expect(ecarte).toContain('total session 0');
  });

  it('`filter clear` rend la table entiere', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    run(sh, 'diagnose sys session filter src 10.0.0.1');
    const vu = run(sh, 'diagnose sys session filter clear', 'diagnose sys session list');

    expect(vu).toContain('session info:');
  });

  it('un critere de filtre inconnu est refuse', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'diagnose sys session filter nimportequoi 1');

    expect(vu).toContain('command parse error');
  });

  it('`clear` sans filtre purge TOUTE la table, et le dit', async () => {
    const { fw, sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    expect(fw.getSessionTable().count()).toBeGreaterThan(0);

    const vu = run(sh, 'diagnose sys session clear');

    expect(fw.getSessionTable().count()).toBe(0);
    expect(vu).toContain('no filter set');
  });

  it('`clear` avec filtre ne purge que ce qui correspond', async () => {
    const { fw, sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const avant = fw.getSessionTable().count();

    run(sh, 'diagnose sys session filter src 10.99.99.99',
      'diagnose sys session clear');

    expect(fw.getSessionTable().count()).toBe(avant);
  });

  it('`stat` compte ce que la table porte', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, 'diagnose sys session stat');

    expect(vu).toMatch(/session_count=\d+/);
    expect(vu).toMatch(/sessions created=[1-9]/);
  });
});

describe('diagnose debug flow', () => {
  it('L5 : un refus designe la regle implicite par `policy 0`', async () => {
    const { sh, poste } = await laboratoire();

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh,
      'diagnose debug reset',
      'diagnose debug flow filter addr 192.168.1.10',
      'diagnose debug flow show function-name enable',
      'diagnose debug flow trace start 10',
      'diagnose debug enable');

    expect(vu).toContain('Denied by forward policy check (policy 0)');
  });

  it('une session permise nomme la politique et la traduction', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh,
      'diagnose debug flow filter addr 192.168.1.10',
      'diagnose debug flow trace start 10',
      'diagnose debug enable');

    expect(vu).toContain('Allowed by Policy-1');
    expect(vu).toContain('SNAT 192.168.1.10->203.0.113.1');
  });

  it('la premiere ligne decrit le paquet recu et son interface', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh,
      'diagnose debug flow trace start 10', 'diagnose debug enable');

    expect(vu).toMatch(/received a packet\(proto=1, 192\.168\.1\.10->203\.0\.113\.10\)/);
    expect(vu).toContain('from port1.');
  });

  it('`show function-name enable` ajoute le nom de fonction et sa ligne', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const sans = run(sh, 'diagnose debug reset',
      'diagnose debug flow trace start 10', 'diagnose debug enable');
    const avec = run(sh, 'diagnose debug reset',
      'diagnose debug flow show function-name enable',
      'diagnose debug flow trace start 10', 'diagnose debug enable');

    expect(sans).not.toContain('func=');
    expect(avec).toContain('func=print_pkt_detail line=5590');
  });

  it('le filtre ecarte ce qui ne le concerne pas', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh,
      'diagnose debug flow filter addr 10.99.99.99',
      'diagnose debug flow trace start 10', 'diagnose debug enable');

    expect(vu).toBe('');
  });

  it('`diagnose debug reset` oublie le filtre', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    run(sh, 'diagnose debug flow filter addr 10.99.99.99');
    const vu = run(sh, 'diagnose debug reset',
      'diagnose debug flow trace start 10', 'diagnose debug enable');

    expect(vu).toContain('received a packet');
  });
});

describe('diagnose firewall iprope', () => {
  it('liste les politiques compilees avec leurs compteurs', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, 'diagnose firewall iprope list');

    expect(vu).toContain('policy group: 00100004');
    expect(vu).toMatch(/policy index=\d+ policy id=1 action=allow/);
    expect(vu).toMatch(/hit count:[1-9]/);
  });

  it('`show` rend une seule politique', async () => {
    const { sh } = await laboratoire();
    politique(sh);

    const vu = run(sh, 'diagnose firewall iprope show 00100004 1');

    expect(vu).toContain('policy id=1');
  });

  it('un index inconnu est refuse', async () => {
    const { sh } = await laboratoire();
    politique(sh);

    const vu = run(sh, 'diagnose firewall iprope show 00100004 99');

    expect(vu).toContain('entry not found in datasource');
  });
});

describe('les vues `get`', () => {
  it('`get system status` lit le nom, le mode et le VDOM de la machine', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'get system status');

    expect(vu).toContain('Hostname: FGT1');
    expect(vu).toContain('Operation Mode: NAT');
    expect(vu).toContain('Current virtual domain: root');
    expect(vu).toMatch(/^Serial-Number: FGVMEV\d{10}$/m);
  });

  it('`get system status` suit le mode d\'exploitation configure', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config system settings', 'set opmode transparent', 'end');
    const vu = run(sh, 'get system status');

    expect(vu).toContain('Operation Mode: Transparent');
    expect(vu).toContain('1 in TP mode');
  });

  it('`get system status` suit le nom d\'hote configure', async () => {
    const { fw, sh } = await laboratoire();

    fw.setName('PARIS-FW');
    const vu = run(sh, 'get system status');

    expect(vu).toContain('Hostname: PARIS-FW');
  });

  it('`get system arp` rend la table ARP reelle', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, 'get system arp');

    expect(vu).toContain('192.168.1.10');
    expect(vu).toContain('port1');
  });

  it('`get system interface` rend les interfaces et leur etat', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'get system interface');

    expect(vu).toMatch(/== \[port1\]\n\tmode: static\n\tip: 192\.168\.1\.1 255\.255\.255\.0/);
    expect(vu).toMatch(/== \[port2\]\n\tmode: static\n\tip: 203\.0\.113\.1 255\.255\.255\.0/);
    expect(vu).toMatch(/\tstatus: up/);
  });

  it('`get router info routing-table all` rend la route par defaut', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'get router info routing-table all');

    expect(vu).toContain('Codes: K - kernel, C - connected, S - static');
    expect(vu).toMatch(/S\*\s+0\.0\.0\.0\/0 \[10\/0\] via 203\.0\.113\.10, port2/);
    expect(vu).toMatch(/C\s+192\.168\.1\.0\/24 is directly connected, port1/);
  });

  it('`get system performance status` compte les sessions et l\'uptime', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, 'get system performance status');

    expect(vu).toMatch(/Average sessions: \d+ sessions in 1 minute/);
    expect(vu).toMatch(/Average session setup rate: \d+ sessions per second/);
    expect(vu).toMatch(/Uptime: \d+ days, \d+ hours, \d+ minutes/);
    expect(vu).not.toContain('Current sessions:');
  });
});

describe('diagnose sniffer packet', () => {
  it('rend l\'en-tete du vrai renifleur', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, "diagnose sniffer packet any 'host 192.168.1.10' 4 10");

    expect(vu).toContain('interfaces=[any]');
    expect(vu).toContain("filters=[host 192.168.1.10]");
    expect(vu).toMatch(/\d+ packets received by filter/);
  });

  it('la verbosite 4 nomme l\'interface, la verbosite 1 non', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const quatre = run(sh, "diagnose sniffer packet any 'host 192.168.1.10' 4 10");
    const un = run(sh, "diagnose sniffer packet any 'host 192.168.1.10' 1 10");

    expect(quatre).toMatch(/port1 -- 192\.168\.1\.10 -> 203\.0\.113\.10: icmp/);
    expect(un).not.toContain(' -- ');
    expect(un).toMatch(/192\.168\.1\.10 -> 203\.0\.113\.10: icmp/);
  });

  it('le filtre ecarte ce qui ne le concerne pas', async () => {
    const { sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const vu = run(sh, "diagnose sniffer packet any 'host 10.99.99.99' 4 10");

    expect(vu).toContain('0 packets received by filter');
  });

  it('une interface qui n\'existe pas est refusee', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, "diagnose sniffer packet port99 'none' 4 10");

    expect(vu).toContain('entry not found in datasource');
  });

  it('une expression de filtre inconnue est refusee', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, "diagnose sniffer packet any 'nimportequoi 1' 4 10");

    expect(vu).toContain('value parse error');
  });
});

describe('les journaux', () => {
  it('L6 : `logtraffic all` journalise a la FERMETURE, avec octets et duree', async () => {
    const { fw, sh, poste } = await laboratoire();
    politique(sh, 'set logtraffic all');
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    expect(run(sh, 'execute log display')).toBe('No matching log data.');
    fw.clearTranslations();

    const vu = run(sh, 'execute log display');
    expect(vu).toContain('type="traffic"');
    expect(vu).toContain('subtype="forward"');
    expect(vu).toMatch(/sentbyte=\d+/);
    expect(vu).toMatch(/duration=\d+/);
  });

  it('`logtraffic utm` — le defaut — ne journalise rien sans profil', async () => {
    const { fw, sh, poste } = await laboratoire();
    politique(sh);
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    fw.clearTranslations();

    expect(run(sh, 'execute log display')).toBe('No matching log data.');
  });

  it('`logtraffic-start enable` ajoute une ligne a l\'OUVERTURE', async () => {
    const { fw, sh, poste } = await laboratoire();
    politique(sh, 'set logtraffic all', 'set logtraffic-start enable');
    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    const ouverture = run(sh, 'execute log display');
    expect(ouverture).toContain('action="start"');

    fw.clearTranslations();
    const deux = run(sh, 'execute log display');
    expect(deux.split('\n')).toHaveLength(2);
  });

  it('un refus par la politique implicite se TAIT par defaut', async () => {
    const { sh, poste } = await laboratoire();

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');

    expect(run(sh, 'execute log display')).toBe('No matching log data.');
  });

  it('`fwpolicy-implicit-log enable` le fait journaliser, avec `policyid=0`', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh, 'execute log display');

    expect(vu).toContain('action="deny"');
    expect(vu).toContain('policyid=0');
  });

  it('le format est en couples cle=valeur', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh, 'execute log display');

    expect(vu).toMatch(/^date=\d{4}-\d{2}-\d{2} time=\d{2}:\d{2}:\d{2} /);
    expect(vu).toContain('devname="FGT1"');
    expect(vu).toContain('logid="0000000015"');
    expect(vu).toContain('srcip=192.168.1.10');
    expect(vu).not.toContain('srcip="192.168.1.10"');
  });

  it('`set format csv` change la mise en forme', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');
    run(sh, 'config log syslogd setting', 'set format csv', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh, 'execute log display');

    expect(vu).toMatch(/^"\d{4}-\d{2}-\d{2}","\d{2}:\d{2}:\d{2}",/);
  });

  it('`set format cef` rend un en-tete CEF', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');
    run(sh, 'config log syslogd setting', 'set format cef', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh, 'execute log display');

    expect(vu).toMatch(
      new RegExp(`^CEF:0\\|Fortinet\\|Fortigate\\|${FORTIOS_PROFILE.defaultVersion}\\|`),
    );
    expect(vu).toContain('|traffic:forward|');
  });

  it('`set format rfc5424` rend une priorite et un horodatage', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');
    run(sh, 'config log syslogd setting', 'set format rfc5424', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const vu = run(sh, 'execute log display');

    expect(vu).toMatch(/^<\d+>1 \d{4}-\d{2}-\d{2}T/);
    expect(vu).toContain('[FTNTFGT@12356 ');
  });

  it('`execute log filter field` filtre sur un champ reel', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const retenu = run(sh, 'execute log filter field srcip 192.168.1.10',
      'execute log display');
    const ecarte = run(sh, 'execute log filter field srcip 10.99.99.99',
      'execute log display');

    expect(retenu).toContain('srcip=192.168.1.10');
    expect(ecarte).toBe('No matching log data.');
  });

  it('`execute log filter view-lines` borne l\'affichage', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 3 203.0.113.10');
    const vu = run(sh, 'execute log filter view-lines 1', 'execute log display');

    expect(vu.split('\n')).toHaveLength(1);
  });

  it('`execute log delete-all` vide le magasin', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config log setting', 'set fwpolicy-implicit-log enable', 'end');

    await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10');
    const efface = run(sh, 'execute log delete-all');

    expect(efface).toMatch(/[1-9]\d* log entries deleted/);
    expect(run(sh, 'execute log display')).toBe('No matching log data.');
  });

  it('le journal memoire est circulaire et borne', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config log memory global-setting', 'set max-size 4096', 'end');

    expect(fw.getLogStore().getMaxBytes()).toBe(4096);
  });

  it('une categorie inconnue est refusee', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'execute log filter category nimportequoi');

    expect(vu).toContain('value parse error');
  });
});
