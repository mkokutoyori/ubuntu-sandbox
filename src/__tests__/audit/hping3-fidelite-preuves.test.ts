/**
 * Sonde — `hping3` imprime ce que la REPONSE dit, et chaque mode pose sur
 * le fil le paquet qu'il annonce.
 *
 * AUTORITE. Le depot amont a ete CLONE et lu pour ce lot :
 * `github.com/antirez/hping`, `RELEASE_VERSION "3.0.0-alpha-1"`,
 * `Makefile.in` construit bien `hping3` — c'est donc hping3 lui-meme, et
 * non un ancetre. L'en-tete du test `unit/network-v2/hping3.test.ts`
 * affirmait le contraire (« hping3's own source is not reachable from
 * here ») : cette phrase etait fausse et elle est corrigee la-bas.
 *
 * Ce que la lecture du source a FIXE, fichier et ligne :
 *  - banniere : `main.c:348`, « HPING %s (%s %s): %s set, %d headers +
 *    %d data bytes » ; tailles d'en-tete IPHDR/TCPHDR/UDPHDR/ICMPHDR
 *    (`main.c:326-345`) ; ordre des lettres R,S,A,F,P,U (`main.c:336-341`).
 *  - ligne de reponse TCP : `log_ip` (`waitpacket.c:160-183`) imprime
 *    « len=%d ip=%s ttl=%d %sid%s%d » ou `ttl` est celui de la REPONSE
 *    et `ip` son emetteur, puis `waitpacket.c:389` « sport=%d flags=%s
 *    seq=%d win=%d rtt=%.1f ms » ou `flags` vient de `tcp.th_flags` RECU
 *    (`waitpacket.c:377-386`) et `win` de `ntohs(tcp.th_win)` RECU.
 *  - ligne de reponse ICMP : `waitpacket.c:257`, « icmp_seq=%d rtt=%.1f
 *    ms » — une FORME DIFFERENTE de celle de TCP.
 *  - `-p` : `parseoptions.c:267-279` — un `+` demande l'increment du port
 *    de destination a chaque REPONSE (`waitpacket.c:404`), deux `++`
 *    l'increment a chaque ENVOI (`sendtcp.c:99`).
 *  - `-k`/`--keep` : `sendtcp.c:96-97`, le port source cesse d'avancer.
 *  - `-w`/`--win` : `sendtcp.c:64`, la fenetre EMISE (defaut 512,
 *    `hping2.h:116`).
 *  - `--flood` : `main.c:371`, « hping in flood mode, no replies will be
 *    shown », et aucune ligne par paquet.
 *  - pertes : `statistics.c:24-34`, arithmetique ENTIERE
 *    `100 - (recv*100)/sent`, et 100 quand rien n'est recu.
 *
 * UNE DIVERGENCE ASSUMEE, et pourquoi : le source amont ecrit « %d
 * packets tramitted » (la coquille est dans `statistics.c:33`). Les
 * binaires distribues l'ont corrigee — les transcriptions reelles
 * montrent « transmitted ». La regle 8 fait primer la transcription que
 * l'apprenant compare a sa propre sortie : le simulateur garde donc
 * « transmitted », et ce choix est ecrit ici plutot que devine.
 *
 * CE QUI ETAIT MESURE AVANT (banc `debug/net/hping3-releve`) :
 *  - un port OUVERT et un port FERME imprimaient la MEME ligne,
 *    « flags=RA ... win=0 » : le verdict de la sonde etait connu puis
 *    jete (regle 6) ;
 *  - le `ttl=` imprime etait celui de MA requete (`-t 5` -> « ttl=5 »),
 *    ce qu'aucune reponse ne peut porter ;
 *  - le mode ICMP empruntait la ligne de TCP, « flags=RA win=0 » ;
 *  - `-2` (udp) et `-0` (rawip) passaient par le chemin TCP : la
 *    banniere annoncait « udp mode » et le fil portait un segment TCP
 *    (regle 4). Les deux repondaient « 0% packet loss » comme TCP ;
 *  - `-p ++80`, `-k`, `--flood`, `-w` : « unknown option ».
 *
 * `-N`/`--id`, `-M`/`--setseq`, `-L`/`--setack` etaient refusees quand ce
 * fichier a ete ecrit : le simulateur ne savait pas poser ces champs sur
 * le fil, et les accepter pour les ignorer aurait ete le defaut de la
 * regle 6. LE LOT SUIVANT LES A RENDUS POSABLES
 * (`ScanProbeShape.sequence`/`acknowledgement`/`tos`/`identification`,
 * `IPv4HeaderOptions.identification`), donc deux cas d'ici ont ete
 * corriges plutot que gardes : celui qui epinglait « unknown option -N »
 * verifie desormais que l'option est honoree et nomme `-O`/`--tcpoff`,
 * qui reste vraiment refuse ; et celui du mode ICMP n'epingle plus
 * « id=0 », puisque `id=` est passe du COMPTEUR de paquets a
 * l'identification de la reponse. Les deux epinglaient un etat que le
 * lot suivant a corrige : c'est le test qui avait tort, pas le moteur.
 *
 * Discrimination par `git stash push -- src/network` : 8 cas sur 10
 * tombent avant (mesure). Le cas UDP a du etre RENFORCE pour y arriver :
 * mesurer la perte ne suffisait pas, parce que le segment TCP SANS
 * DRAPEAU qu'emettait ce mode avant le lot ne tirait aucune reponse non
 * plus — les deux donnaient « 100% packet loss ». Ce qui distingue le
 * vrai datagramme, c'est que la CIBLE y repond (ICMP unreachable) : le
 * cas compte donc les trames que la cible emet en retour.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — la banniere garde sa forme » : non-regression du format
 *    deja conforme a `main.c:348`.
 *  - « TEMOIN — un SYN vers un port ouvert est repondu » : TEMOIN du
 *    laboratoire. Sans lui, les pertes mesurees plus bas pourraient
 *    venir d'une route morte et non de la lecture de hping3 (regle 7).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

interface Lab { pc: LinuxPC; srv: LinuxServer }

async function directLink(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'web', 0, 0);
  pc.powerOn();
  srv.powerOn();
  new Cable('c').connect(pc.getPort('eth0') as never, srv.getPort('eth0') as never);
  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) {
    await pc.executeCommand(c);
  }
  for (const c of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'systemctl start nginx']) {
    await srv.executeCommand(c);
  }
  return { pc, srv };
}

function framesOut(device: LinuxPC | LinuxServer): number {
  const port = device.getPort('eth0') as unknown as { getCounters(): { framesOut: number } };
  return port.getCounters().framesOut;
}

const replyLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('len='));

describe('hping3 : la ligne de reponse dit ce que la reponse porte', () => {
  it('un port OUVERT repond SA avec sa fenetre, un port FERME repond RA win=0', async () => {
    const { pc } = await directLink();
    const ouvert = replyLines(await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2'))[0];
    const ferme = replyLines(await pc.executeCommand('hping3 -S -p 81 -c 1 10.0.0.2'))[0];
    expect(ouvert).toMatch(/sport=80 flags=SA seq=0 win=(\d+) rtt=/);
    expect(Number(/win=(\d+)/.exec(ouvert)?.[1])).toBeGreaterThan(0);
    expect(ferme).toMatch(/sport=81 flags=RA seq=0 win=0 rtt=/);
  });

  it('le ttl imprime est celui de la REPONSE, pas celui de ma requete', async () => {
    const { pc } = await directLink();
    const ligne = replyLines(await pc.executeCommand('hping3 -S -p 80 -t 5 -c 1 10.0.0.2'))[0];
    expect(ligne).toContain('ttl=64');
    expect(ligne).not.toContain('ttl=5');
  });

  it('le mode ICMP a SA PROPRE ligne (icmp_seq), pas celle de TCP', async () => {
    const { pc } = await directLink();
    const lignes = replyLines(await pc.executeCommand('hping3 -1 -c 2 10.0.0.2'));
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatch(/^len=28 ip=10\.0\.0\.2 ttl=\d+ id=\d+ icmp_seq=0 rtt=\d+\.\d ms$/);
    expect(lignes[1]).toContain('icmp_seq=1');
    for (const l of lignes) {
      expect(l).not.toContain('flags=');
      expect(l).not.toContain('win=');
    }
  });
});

describe('hping3 : chaque mode pose sur le fil le paquet qu il annonce', () => {
  it('-2 pose de VRAIS datagrammes UDP : la cible repond un ICMP unreachable', async () => {
    const { pc, srv } = await directLink();
    await pc.executeCommand('ping -c 1 10.0.0.2');
    const emisesParLeClient = framesOut(pc);
    const emisesParLaCible = framesOut(srv);
    const out = await pc.executeCommand('hping3 -2 -p 9999 -c 2 10.0.0.2');
    expect(out).toContain('udp mode set, 28 headers + 0 data bytes');
    expect(framesOut(pc) - emisesParLeClient).toBeGreaterThanOrEqual(2);
    // Un datagramme UDP vers un port ferme fait repondre la pile de la
    // cible ; le segment TCP sans drapeau qu'emettait ce mode avant le
    // lot ne lui tirait AUCUNE trame.
    expect(framesOut(srv) - emisesParLaCible).toBeGreaterThanOrEqual(2);
    expect(out).toContain('2 packets transmitted, 0 packets received, 100% packet loss');
  });

  it('-0 pose un paquet IP BRUT, dont le protocole est celui demande', async () => {
    const { pc } = await directLink();
    const avant = framesOut(pc);
    const out = await pc.executeCommand('hping3 -0 --ipproto 47 -c 2 10.0.0.2');
    const apres = framesOut(pc);
    expect(out).toContain('raw IP mode set, 20 headers + 0 data bytes');
    expect(apres - avant).toBeGreaterThanOrEqual(2);
    expect(out).toContain('2 packets transmitted, 0 packets received, 100% packet loss');
  });
});

describe('hping3 : les options que le source definit', () => {
  it('-p ++N incremente le port de destination a chaque ENVOI', async () => {
    const { pc } = await directLink();
    const lignes = replyLines(await pc.executeCommand('hping3 -S -p ++79 -c 3 10.0.0.2'));
    expect(lignes.map((l) => /sport=(\d+)/.exec(l)?.[1])).toEqual(['79', '80', '81']);
    expect(lignes[0]).toContain('flags=RA');
    expect(lignes[1]).toContain('flags=SA');
    expect(lignes[2]).toContain('flags=RA');
  });

  it('-k garde le port fixe, et --flood tait les reponses', async () => {
    const { pc } = await directLink();
    const garde = replyLines(await pc.executeCommand('hping3 -S -p 80 -k -c 2 10.0.0.2'));
    expect(garde.map((l) => /sport=(\d+)/.exec(l)?.[1])).toEqual(['80', '80']);

    const flood = await pc.executeCommand('hping3 -S -p 80 --flood -c 2 10.0.0.2');
    expect(flood).toContain('hping in flood mode, no replies will be shown');
    expect(replyLines(flood)).toHaveLength(0);
    expect(flood).toContain('2 packets transmitted, 2 packets received, 0% packet loss');
  });

  it('-w passe la fenetre EMISE, et un champ non posable reste refuse', async () => {
    const { pc } = await directLink();
    const out = await pc.executeCommand('hping3 -S -p 80 -w 1024 -c 1 10.0.0.2');
    expect(out).toContain('flags=SA');
    expect(await pc.executeCommand('hping3 -S -p 80 -N 42 -c 1 10.0.0.2'))
      .toContain('flags=SA');
    expect(await pc.executeCommand('hping3 -S -p 80 -O 6 -c 1 10.0.0.2'))
      .toBe('hping3: unknown option -O');
  });
});

describe('temoins', () => {
  it('TEMOIN — la banniere garde sa forme', async () => {
    const { pc } = await directLink();
    const out = await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2');
    expect(out).toContain('HPING 10.0.0.2 (eth0 10.0.0.2): S set, 40 headers + 0 data bytes');
    expect(out).toContain('--- 10.0.0.2 hping statistic ---');
    expect(out).toContain('round-trip min/avg/max = 0.0/0.0/0.0 ms');
  });

  it('TEMOIN — un SYN vers un port ouvert est repondu', async () => {
    const { pc } = await directLink();
    expect(await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2'))
      .toContain('1 packets transmitted, 1 packets received, 0% packet loss');
  });
});
