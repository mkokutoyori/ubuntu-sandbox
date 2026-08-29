/**
 * Une connexion TCP originee par un ROUTEUR suit sa table de routage.
 *
 * ── Le defaut, mesure ───────────────────────────────────────────────
 *
 * `TcpStack.resolveEgress` consulte `host.resolveRoute` — la vraie
 * table — puis, a defaut, parcourt les ports a la recherche d'un
 * sous-reseau correspondant, et retombe enfin sur « le premier port
 * adresse, up et cable ». Or le `tcpHost` que `Router` construit
 * NE FOURNISSAIT PAS `resolveRoute`, alors que la methode existe
 * (`resolveRouteForHost`) et que tous les autres hotes la fournissent.
 * TCP sur un routeur n'a donc jamais consulte sa table.
 *
 * La consequence est double, et la seconde moitie est la pire. Sur un
 * routeur a deux liaisons montantes, une connexion vers un reseau
 * joignable par une ROUTE STATIQUE :
 *
 *   1. sort par le mauvais port — celui qui vient en premier ;
 *   2. resout en ARP l'adresse de DESTINATION au lieu du SAUT SUIVANT,
 *      parce que le parcours de repli pose `nextHopIp: targetIp`,
 *      c'est-a-dire qu'il traite une destination hors lien comme si elle
 *      etait sur le lien.
 *
 * Mesure avant correctif, sur le laboratoire ci-dessous : la table dit
 * `10.0.1.0/24 via GigabitEthernet0/1`, et la machine emet
 * `ARP GigabitEthernet0/0 -> 10.0.1.2`. Aucun segment TCP ne part
 * jamais : il reste en file derriere un ARP que personne n'entend, et
 * `tcpConnect` ne rend jamais la main. **Un routeur ne pouvait donc
 * ouvrir aucune connexion TCP hors de ses sous-reseaux directs** — ni
 * SSH, ni telnet, ni HTTP vers un hote distant.
 *
 * ── Le correctif ───────────────────────────────────────────────────
 *
 * Le `tcpHost` fournit `resolveRoute`, comme les autres. Et le repli
 * « premier port up » est SUPPRIME plutot que corrige : un chemin de
 * sortie qu'on ne sait pas decider doit echouer, pas etre devine — c'est
 * la regle de refus fermé que ce depot applique deja a ses moteurs de
 * filtrage. Le parcours par sous-reseau demeure : c'est un vrai test
 * « sur le lien », utile a un hote sans table.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur trois tombent contre l'etat d'avant : la connexion qui
 * aboutit, et l'ARP emis sur le bon port pour le bon saut. Le TEMOIN sur
 * lien direct passe des deux cotes et le doit — c'est le cas qui marchait
 * deja, et qui rendait le defaut invisible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, type IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Emis { port: string; kind: 'tcp' | 'arp'; target: string }

function emissions(r: CiscoRouter): Emis[] {
  const seen: Emis[] = [];
  for (const p of r.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'out') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type === 'ipv4' && packet.protocol === 6) {
        seen.push({ port: p.getName(), kind: 'tcp', target: packet.destinationIP.toString() });
        return;
      }
      const arp = frame.payload as { type?: string; targetIP?: { toString(): string } } | undefined;
      if (arp?.type === 'arp' && arp.targetIP) {
        seen.push({ port: p.getName(), kind: 'arp', target: arp.targetIP.toString() });
      }
    });
  }
  return seen;
}

/**
 * Deux liaisons montantes, et le reseau vise n'est joignable que par la
 * SECONDE. Avec une seule, le repli donnait la bonne reponse par
 * accident — le laboratoire doit donc en avoir deux pour discriminer.
 */
async function deuxUplinks() {
  const local = new CiscoRouter('LOCAL');
  const impasse = new CiscoRouter('DEAD');
  const relais = new CiscoRouter('MID');
  const distant = new CiscoRouter('FAR');

  new Cable('c0').connect(
    local.getPort('GigabitEthernet0/0')!, impasse.getPort('GigabitEthernet0/0')!);
  new Cable('c1').connect(
    local.getPort('GigabitEthernet0/1')!, relais.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(
    relais.getPort('GigabitEthernet0/1')!, distant.getPort('GigabitEthernet0/0')!);

  const monter = async (r: CiscoRouter, lignes: string[]) => {
    for (const c of ['enable', 'configure terminal', ...lignes, 'end']) await r.executeCommand(c);
  };
  await monter(local, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 172.16.9.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'no shutdown', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip route 10.0.1.0 255.255.255.0 10.0.0.2',
  ]);
  await monter(impasse, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 172.16.9.2 255.255.255.0']);
  await monter(relais, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'no shutdown', 'ip address 10.0.1.1 255.255.255.0']);
  await monter(distant, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 10.0.1.2 255.255.255.0', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.1.1']);
  return { local, impasse, relais, distant };
}

describe('TCP originé par un routeur suit la table de routage', () => {
  it('la connexion vers un reseau joignable par route statique ABOUTIT', async () => {
    const { local, distant } = await deuxUplinks();
    let accepte = false;
    distant.getTcpStack().listen(9000, { onAccept: () => { accepte = true; } });

    const socket = await local.tcpConnect('10.0.1.2', 9000);
    expect(socket).not.toBeNull();
    expect(accepte).toBe(true);
  });

  it('l\'ARP part sur le port ROUTE et vise le SAUT SUIVANT', async () => {
    const { local, distant } = await deuxUplinks();
    distant.getTcpStack().listen(9000, { onAccept: () => undefined });
    const vus = emissions(local);

    await local.tcpConnect('10.0.1.2', 9000);

    const arps = vus.filter((e) => e.kind === 'arp');
    expect(arps.length).toBeGreaterThan(0);
    for (const a of arps) {
      expect(a.port).toBe('GigabitEthernet0/1');
      expect(a.target).toBe('10.0.0.2');
    }
    const tcp = vus.filter((e) => e.kind === 'tcp');
    expect(tcp.length).toBeGreaterThan(0);
    for (const t of tcp) expect(t.port).toBe('GigabitEthernet0/1');
  });

  it('TEMOIN — une connexion sur un lien DIRECT marchait deja', async () => {
    const { local, relais } = await deuxUplinks();
    let accepte = false;
    relais.getTcpStack().listen(9100, { onAccept: () => { accepte = true; } });

    const socket = await local.tcpConnect('10.0.0.2', 9100);
    expect(socket).not.toBeNull();
    expect(accepte).toBe(true);
  });
});
