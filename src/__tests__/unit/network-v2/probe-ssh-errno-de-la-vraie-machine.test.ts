/**
 * OpenSSH distingue ENETUNREACH d'EHOSTUNREACH, et le simulateur rendait
 * le second pour les deux (BRD-Modele-TCP-IP.md phase 8, lot 6).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `ssh admin@203.0.113.9` depuis un hote Linux — adresse qu'AUCUNE route
 * ne dessert — rendait
 * `ssh: connect to host 203.0.113.9 port 22: No route to host`.
 * C'est le texte d'EHOSTUNREACH, c'est-a-dire d'un tout autre echec.
 *
 * ── L'autorite, lue et non citee de memoire ─────────────────────────
 *
 * `include/uapi/asm-generic/errno.h` :
 *
 *     #define ENETUNREACH   101  /* Network is unreachable *\/
 *     #define EHOSTUNREACH  113  /* No route to host      *\/
 *
 * et `sshconnect.c:554` d'openssh-portable ecrit
 * `error("ssh: connect to host %s port %s: %s", host, strport,
 * strerror(errno))` — donc le client rend le texte de l'errno TEL QUEL,
 * sans en choisir un.
 *
 * Les deux echecs ne se diagnostiquent pas pareil, et c'est pour cela que
 * les confondre coute : ENETUNREACH dit que la machine n'a AUCUN chemin —
 * on va regarder sa table de routage et sa passerelle ; EHOSTUNREACH dit
 * qu'un chemin existe et que personne ne repond au bout — l'ARP echoue
 * sur le lien, ou une erreur ICMP est revenue —, donc on va regarder la
 * machine d'en face. Rendre le second pour le premier envoie chercher un
 * hote eteint quand c'est la route qui manque.
 *
 * ── Une seule ecriture, et la bonne plateforme ──────────────────────
 *
 * `sshUnreachableReason` porte la regle une fois et les deux chemins la
 * lisent — l'interactif (`wireSshLogin`, partage par les sessions Cisco,
 * Windows et le lanceur) et le scripte (`LinuxSshClient`, celui que
 * `executeCommand` emprunte). Le fait est lu sur la PILE
 * (`TcpStack.hasEgressTo`), donc sur la vraie table de routage, et non
 * sur la topologie.
 *
 * **Verifie plutot que suppose** : ces phrases sont celles d'OpenSSH, et
 * elles sont JUSTES sous Linux comme sous Windows — le `ssh.exe` de
 * Windows EST le portage d'OpenSSH (documentation Microsoft, « OpenSSH
 * for Windows overview »). Ce qui reste faux est qu'une session CLI Cisco
 * ou Huawei les rende aussi ; c'est un autre defaut, inscrit au
 * `TODO.md`, et que ce lot ne touche pas faute d'une capture attestant ce
 * qu'un client SSH d'IOS ecrit dans ce cas.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * UN cas sur trois tombe. Les deux autres sont nommes plutot que laisses
 * a decouvrir : le cas EHOSTUNREACH passe des DEUX cotes et le doit —
 * c'est celui qui etait deja juste, et c'est justement parce qu'il l'etait
 * que le defaut se voyait mal ; et le TEMOIN de la connexion qui aboutit
 * garde qu'on n'a pas rendu tout le monde injoignable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function deuxMachines() {
  const poste = new LinuxPC('PC');
  const serveur = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c1').connect(poste.getPorts()[0], serveur.getPorts()[0]);
  await poste.executeCommand('sudo ip addr add 10.0.0.1/24 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');
  await serveur.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await serveur.executeCommand('sudo ip link set eth0 up');
  return { poste, serveur };
}

describe('ssh rend l\'errno de la vraie machine', () => {
  it('aucune route : ENETUNREACH, donc « Network is unreachable »', async () => {
    const { poste } = await deuxMachines();
    const sortie = await poste.executeCommand('ssh admin@203.0.113.9');
    expect(sortie).toContain('Network is unreachable');
    expect(sortie).not.toContain('No route to host');
  });

  it('une route mais personne au bout : EHOSTUNREACH, donc « No route to host »', async () => {
    const { poste } = await deuxMachines();
    const sortie = await poste.executeCommand('ssh admin@10.0.0.99');
    expect(sortie).toContain('No route to host');
  });

  it('TEMOIN : un pair joignable qui ecoute reste joignable', async () => {
    const { poste, serveur } = await deuxMachines();
    await serveur.executeCommand('sudo systemctl start ssh');
    const sortie = await poste.executeCommand('ssh admin@10.0.0.2 whoami');
    expect(sortie).not.toContain('Network is unreachable');
    expect(sortie).not.toContain('No route to host');
  });
});
