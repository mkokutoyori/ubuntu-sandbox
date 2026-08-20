/**
 * Scénario 10 — Investigation réseau post-incident par corrélation de
 * captures tcpdump et logs système natifs.
 *
 * Divergences assumées entre le pseudocode du scénario et la plateforme
 * réelle (« conserver ce qui correspond à la réalité ») :
 *  - `mauvais_user@cible` ne produit pas de RST : le handshake TCP aboutit
 *    (sshd tourne), l'échec se joue à la couche SSH/PAM (utilisateur
 *    inconnu) — comme un vrai sshd. Le "RST" du pseudocode ne s'applique
 *    donc jamais ici ; seul le SYN de tentative est attendu.
 *  - un `ip addr add` ou un `iptables -A` en direct n'émettent, sur un
 *    vrai Linux, ni ligne syslog ni entrée `journalctl -u networking` —
 *    seul `netplan apply` (déjà couvert ailleurs) en génère une. La preuve
 *    de ces deux phases est donc relevée par inspection d'état
 *    (`ip addr show`, `iptables -L`), exactement comme le fait la propre
 *    section « Rapport d'incident final » du scénario.
 *  - `comm` n'est pas implémenté par la plateforme ; la corrélation
 *    d'ensemble IP réseau/auth.log est reproduite avec `awk` seul
 *    (idiome `NR==FNR{seen[$0]=1;next} seen[$0]`), strictement équivalent
 *    à `comm -12` sur des listes déjà uniques.
 *  - une substitution de commande `$(... | grep "motif")` avec un motif
 *    entre guillemets doubles, imbriquée dans le corps d'un heredoc, n'est
 *    pas correctement ré-analysée par l'interpréteur bash de la plateforme
 *    (les guillemets survivent littéralement au lieu d'être consommés) ;
 *    les motifs `grep` du rapport ci-dessous restent donc non quotés
 *    (mots simples, sans espace) pour rester dans le sous-ensemble bash
 *    que le heredoc gère correctement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ATTACKER_IP = '192.168.10.101';
const TARGET_IP = '192.168.10.102';

interface Lab { attacker: LinuxPC; target: LinuxServer }

function buildLab(): Lab {
  const attacker = new LinuxPC('linux-pc', 'ATTACKER', 0, 0);
  const target = new LinuxServer('linux-server', 'TARGET', 0, 0);
  new Cable('c1').connect(attacker.getPort('eth0')!, target.getPort('eth0')!);
  attacker.getPort('eth0')!.configureIP(new IPAddress(ATTACKER_IP), new SubnetMask('255.255.255.0'));
  target.getPort('eth0')!.configureIP(new IPAddress(TARGET_IP), new SubnetMask('255.255.255.0'));
  return { attacker, target };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

/** Drives the composite incident: phase 1 (SSH) from ATTACKER, phases 2-3 on TARGET. */
async function runIncident(lab: Lab, captureFlags: string): Promise<void> {
  const pending = lab.target.executeCommand(
    `tcpdump -i eth0 -nn ${captureFlags} 'tcp port 22 or icmp or arp' -w /tmp/incident.pcap`,
  );
  await new Promise((r) => setTimeout(r, 20));

  for (let i = 0; i < 6; i++) {
    await lab.attacker.executeCommand(
      `ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no mauvais_user@${TARGET_IP}`,
    );
  }
  await lab.target.executeCommand('ip addr add 192.168.10.200/24 dev eth0');
  await lab.target.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j ACCEPT');

  await new Promise((r) => setTimeout(r, 40));
  await pending;
}

describe('Scénario 10 — Investigation post-incident par corrélation tcpdump + logs natifs', () => {
  it('la capture réseau pendant l\'incident composite réussit sans erreur', async () => {
    const lab = buildLab();
    await runIncident(lab, '-vvv');
    const out = await lab.target.executeCommand('tcpdump -nn -r /tmp/incident.pcap');
    expect(out).not.toMatch(/tcpdump: error/);
    expect(out).toMatch(/packets captured/);
    expect(Number(/(\d+) packets captured/.exec(out)?.[1] ?? 0)).toBeGreaterThan(0);
  });

  describe('extraction de la chronologie réseau depuis le pcap', () => {
    it('chaque tentative SSH se traduit par un SYN vers le port 22, extrait et horodaté', async () => {
      const lab = buildLab();
      await runIncident(lab, '');

      const timeline = await lab.target.executeCommand(
        `tcpdump -nn -r /tmp/incident.pcap | awk '{
          time=$1
          if ($0 ~ /Flags \\[S\\]/ && $5 ~ /\\.22:$/)
            print time, "RÉSEAU: Tentative connexion SSH vers", $5
        }' | sort`,
      );
      const lines = timeline.split('\n').filter((l) => l.includes('RÉSEAU:'));
      expect(lines.length).toBeGreaterThanOrEqual(5);
      for (const l of lines) expect(l).toMatch(new RegExp(`${TARGET_IP}\\.22:`));
    });
  });

  describe('extraction de la chronologie système depuis les logs natifs', () => {
    it('les tentatives échouées sont journalisées côté sshd dans auth.log', async () => {
      const lab = buildLab();
      await runIncident(lab, '');

      const authTimeline = await lab.target.executeCommand(
        `grep 'sshd' /var/log/auth.log | awk '{print $1, $2, $3, "AUTH:", $0}' | tail -20`,
      );
      const lines = authTimeline.split('\n').filter((l) => l.includes('AUTH:'));
      expect(lines.length).toBeGreaterThan(0);
      expect(authTimeline).toMatch(new RegExp(`mauvais_user from ${ATTACKER_IP}`));
    });

    it('les modifications réseau et la règle iptables sont vérifiables par état — sans trace syslog pour un changement live', async () => {
      const lab = buildLab();
      await runIncident(lab, '');

      // Real Linux: a raw `ip addr add`/`iptables -A` produce no syslog
      // line — verified by state, exactly like the scenario's own final
      // report does.
      const ipShow = await lab.target.executeCommand('ip addr show eth0');
      expect(ipShow).toMatch(/192\.168\.10\.200\/24/);
      const iptablesL = await lab.target.executeCommand('iptables -L INPUT -n');
      expect(iptablesL).toMatch(/ACCEPT.*dpt:8080/);
    });
  });

  describe('fusion et reconstruction chronologique', () => {
    it('la fusion des sources réseau + auth.log produit une chronologie numérotée, cohérente et sans lacune', async () => {
      const lab = buildLab();
      await runIncident(lab, '');

      await lab.target.executeCommand(
        `tcpdump -nn -r /tmp/incident.pcap | awk '{
          time=$1
          if ($0 ~ /Flags \\[S\\]/ && $5 ~ /\\.22:$/)
            print time, "RÉSEAU: Tentative connexion SSH vers", $5
        }' | sort > /tmp/timeline-reseau.txt`,
      );
      await lab.target.executeCommand(
        `grep 'sshd' /var/log/auth.log | awk '{print $1, $2, $3, "AUTH:", $0}' | tail -20 > /tmp/timeline-auth.txt`,
      );

      const merged = await lab.target.executeCommand(
        `cat /tmp/timeline-reseau.txt /tmp/timeline-auth.txt | sort | awk '
          BEGIN {print "=== CHRONOLOGIE INCIDENT ==="}
          {print NR".", $0}
        '`,
      );
      expect(merged).toMatch(/=== CHRONOLOGIE INCIDENT ===/);
      const numbered = merged.split('\n').filter((l) => /^\d+\./.test(l));
      expect(numbered.length).toBeGreaterThan(0);
      // Sans lacune : la numérotation est continue de 1 à N.
      const numbers = numbered.map((l) => Number(/^(\d+)\./.exec(l)?.[1]));
      for (let i = 0; i < numbers.length; i++) expect(numbers[i]).toBe(i + 1);
      expect(merged).toMatch(/RÉSEAU: Tentative connexion SSH/);
      expect(merged).toMatch(/AUTH:.*sshd/);
    });
  });

  describe('corrélation IP source entre capture réseau et auth.log', () => {
    it('les IPs sources des tentatives SSH sont identiques dans le pcap et dans auth.log', async () => {
      const lab = buildLab();
      await runIncident(lab, '');

      await lab.target.executeCommand(
        `tcpdump -nn -r /tmp/incident.pcap 'tcp port 22 and tcp[tcpflags] == tcp-syn' | \
          awk '{print $3}' | cut -d. -f1-4 | sort | uniq -c | sort -rn > /tmp/ssh-sources-reseau.txt`,
      );
      await lab.target.executeCommand(
        `grep 'Failed\\|Invalid\\|Connection refused' /var/log/auth.log | \
          grep -oP 'from \\K[\\d.]+' | sort | uniq -c | sort -rn > /tmp/ssh-sources-auth.txt`,
      );

      const reseauSrc = await lab.target.executeCommand('cat /tmp/ssh-sources-reseau.txt');
      const authSrc = await lab.target.executeCommand('cat /tmp/ssh-sources-auth.txt');
      expect(reseauSrc).toMatch(new RegExp(ATTACKER_IP.replace(/\./g, '\\.')));
      expect(authSrc).toMatch(new RegExp(ATTACKER_IP.replace(/\./g, '\\.')));

      // `comm -12` n'est pas disponible : équivalent awk (intersection de
      // deux listes déjà dédupliquées par `uniq`).
      const common = await lab.target.executeCommand(
        `awk '{print $2}' /tmp/ssh-sources-reseau.txt | sort > /tmp/ips-reseau.txt
         awk '{print $2}' /tmp/ssh-sources-auth.txt | sort > /tmp/ips-auth.txt
         awk 'NR==FNR{seen[$0]=1; next} seen[$0]' /tmp/ips-reseau.txt /tmp/ips-auth.txt`,
      );
      expect(common.trim()).toBe(ATTACKER_IP);
    });
  });

  describe('rapport d\'incident final', () => {
    it('le rapport généré documente cause racine, chronologie et artefacts, exploitable sans accès interactif', async () => {
      const lab = buildLab();
      await runIncident(lab, '');

      await lab.target.executeCommand(
        `tcpdump -nn -r /tmp/incident.pcap 'tcp port 22 and tcp[tcpflags] == tcp-syn' | \
          awk '{print $3}' | cut -d. -f1-4 | sort | uniq -c | sort -rn > /tmp/ssh-sources-reseau.txt`,
      );

      const report = await lab.target.executeCommand(
        `cat << EOF2 > /tmp/rapport-incident.txt
=== RAPPORT D'INCIDENT RÉSEAU ===
Machine analysée : $(hostname)

--- RÉSUMÉ ---
Paquets capturés :
$(tcpdump -nn -r /tmp/incident.pcap 2>&1 | grep captured)

Tentatives SSH échouées :
$(grep -c 'Failed\\|Invalid' /var/log/auth.log || echo 0)

IPs sources suspectes :
$(cat /tmp/ssh-sources-reseau.txt)

Modifications réseau détectées :
$(ip addr show | grep 192.168.10.200)

Règles iptables ajoutées :
$(iptables -L INPUT -n | grep 8080)
EOF2
cat /tmp/rapport-incident.txt`,
      );

      expect(report).toMatch(/=== RAPPORT D'INCIDENT RÉSEAU ===/);
      expect(report).toMatch(/captured/);
      expect(report).toMatch(/Tentatives SSH échouées :\s*\n\s*\d+/);
      expect(report).toMatch(new RegExp(ATTACKER_IP.replace(/\./g, '\\.')));
      expect(report).toMatch(/192\.168\.10\.200\/24/);
      expect(report).toMatch(/ACCEPT.*dpt:8080/);
    });
  });

  describe('critère de réussite', () => {
    it('chronologie cohérente sans lacune, corrélation IP parfaite, rapport exploitable', async () => {
      const lab = buildLab();
      await runIncident(lab, '');

      const reseauTimeline = await lab.target.executeCommand(
        `tcpdump -nn -r /tmp/incident.pcap | awk '{
          time=$1
          if ($0 ~ /Flags \\[S\\]/ && $5 ~ /\\.22:$/)
            print time, "RÉSEAU: Tentative connexion SSH vers", $5
        }' | sort`,
      );
      const authTimeline = await lab.target.executeCommand(
        `grep 'sshd' /var/log/auth.log | awk '{print $1, $2, $3, "AUTH:", $0}' | tail -20`,
      );
      expect(reseauTimeline.split('\n').filter((l) => l.includes('RÉSEAU:')).length).toBeGreaterThan(0);
      expect(authTimeline.split('\n').filter((l) => l.includes('AUTH:')).length).toBeGreaterThan(0);

      await lab.target.executeCommand(
        `tcpdump -nn -r /tmp/incident.pcap 'tcp port 22 and tcp[tcpflags] == tcp-syn' | \
          awk '{print $3}' | cut -d. -f1-4 | sort -u > /tmp/ips-reseau2.txt`,
      );
      await lab.target.executeCommand(
        `grep 'Failed\\|Invalid' /var/log/auth.log | grep -oP 'from \\K[\\d.]+' | sort -u > /tmp/ips-auth2.txt`,
      );
      const reseauIps = (await lab.target.executeCommand('cat /tmp/ips-reseau2.txt')).trim().split('\n').filter(Boolean);
      const authIps = (await lab.target.executeCommand('cat /tmp/ips-auth2.txt')).trim().split('\n').filter(Boolean);
      expect(reseauIps).toEqual(authIps);
      expect(reseauIps).toEqual([ATTACKER_IP]);

      const report = await lab.target.executeCommand(
        `cat << EOF2 > /tmp/rapport2.txt
Machine analysée : $(hostname)
Cause racine : tentatives de connexion SSH avec utilisateur invalide depuis ${ATTACKER_IP}
Chronologie : $(cat /tmp/ips-reseau2.txt | wc -l) source(s) réseau distincte(s)
Artefacts résiduels : $(ip addr show | grep 192.168.10.200 | wc -l) adresse(s) secondaire(s), $(iptables -L INPUT -n | grep -c 8080) règle(s) iptables port 8080
EOF2
cat /tmp/rapport2.txt`,
      );
      expect(report).toMatch(/Cause racine/);
      expect(report).toMatch(/Chronologie/);
      expect(report).toMatch(/Artefacts résiduels/);
      expect(report).not.toMatch(/undefined|NaN/);
    });
  });
});
