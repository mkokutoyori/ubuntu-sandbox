/**
 * TCP n'a plus de retombee en diffusion, et `resolveMac` a disparu du
 * depot (BRD §5.3).
 *
 * ── Ce que la mesure a trouve, et ce qu'elle N'A PAS trouve ────────
 *
 * `TcpStack.shipSegment` portait la meme forme que RADIUS, NTP, BFD et
 * NHRP :
 *
 *     if (this.host.sendIpv4FrameArpAware) { ...; return; }
 *     const resolvedMac = this.host.resolveMac?.(dstIp) ?? null;
 *     dstMAC: resolvedMac ?? MACAddress.broadcast()
 *
 * Il faut dire tout de suite ce que la mesure etablit : cette retombee
 * n'etait ATTEIGNABLE nulle part. Les TROIS hotes qui construisent une
 * pile TCP — `Router`, `EndHost`, `Firewall` — fournissent tous
 * `sendIpv4FrameArpAware`, donc la branche du dessus prend toujours. Du
 * cote IPv6, `Router` et `Firewall` ne fournissent NI
 * `sendIpv6FrameNdpAware` NI `resolveRoute6` — et `resolveEgress6` rend
 * `null` sans eux, donc l'emission s'arrete avant la retombee. Sur
 * `EndHost`, qui fournit les deux, c'est la branche NDP qui prend.
 *
 * Ce n'est donc pas un defaut corrige mais un PIEGE retire, et le dire
 * ainsi evite de le compter pour ce qu'il n'est pas. Ce qui aurait
 * transite par la, si un hote avait manque a l'appel, est un SEGMENT
 * TCP — c'est-a-dire la charge applicative — diffuse au segment entier.
 *
 * ── Ce que le retrait a permis de fermer ────────────────────────────
 *
 * `resolveMac` LIT le cache ARP sans resoudre : il n'existait que pour
 * nourrir ces retombees. Une fois la derniere retiree, il n'avait plus
 * AUCUN lecteur dans tout `src/network`, et ses sept fournisseurs
 * l'alimentaient pour personne. Il est supprime — declaration et
 * fournisseurs — donc la forme « lire le cache et esperer » n'est plus
 * disponible pour etre reintroduite.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur trois tombent contre l'etat d'avant, et ce sont les deux
 * cas de STRUCTURE : aucun laboratoire ne peut montrer une retombee
 * inatteignable. Le TEMOIN passe des deux cotes et le doit — il verifie
 * que la poignee de main TCP fonctionne toujours, ce qui est la seule
 * chose qu'un retrait de code mort pouvait casser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function typescriptFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('la retombee en diffusion a disparu de TCP', () => {
  it('TcpStack ne batit plus de trame et n\'a plus de retombee', () => {
    const texte = readFileSync('src/network/tcp/TcpStack.ts', 'utf8');
    const fautes: string[] = [];
    if (texte.includes('MACAddress.broadcast()')) fautes.push('retombee en diffusion');
    if (texte.includes('resolveMac')) fautes.push('lit encore le cache ARP');
    if (texte.includes('etherType: ETHERTYPE_IPV4')) fautes.push('batit encore une trame IPv4');
    expect(fautes).toEqual([]);
  });

  it('`resolveMac` n\'a plus aucun lecteur ni fournisseur dans src/network', () => {
    const porteurs = typescriptFiles('src/network')
      .filter((path) => /\bresolveMac6?\b/.test(readFileSync(path, 'utf8')));
    expect(porteurs).toEqual([]);
  });
});

describe('TEMOIN — la poignee de main TCP fonctionne toujours', () => {
  it('un client atteint un serveur a travers un commutateur', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const client = new CiscoRouter('C');
    const serveur = new CiscoRouter('S');
    new Cable('c1').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(serveur.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);

    for (const [r, ip] of [[client, '10.0.0.1'], [serveur, '10.0.0.2']] as const) {
      r.getPort('GigabitEthernet0/0')!
        .configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
      for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
        'no shutdown', 'end']) await r.executeCommand(c);
    }

    let accepte = false;
    serveur.getTcpStack().listen(9000, { onAccept: () => { accepte = true; } });
    client._clearArpEntry('10.0.0.2');

    const socket = await client.tcpConnect('10.0.0.2', 9000);
    expect(socket).not.toBeNull();
    expect(accepte).toBe(true);
  });
});
