/**
 * L'enregistrement NHRP d'un client DMVPN ne se DIFFUSE pas.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * `NhrpEngine.transmit` batissait sa trame et choisissait son adresse de
 * destination ainsi :
 *
 *     const cached = this.host.getArpEntry(destNbma);
 *     const dstMAC = cached ? cached.mac : MACAddress.broadcast();
 *
 * `getArpEntry` LIT le cache ARP, il ne resout pas — et contrairement aux
 * retombees que la phase 8 a retirees de RADIUS, NTP et BFD, celle-ci
 * n'avait AUCUNE garde : sur cache froid, c'est-a-dire au PREMIER paquet,
 * elle diffusait. Or NHRP (protocole 54) porte precisement
 * l'enregistrement d'un client DMVPN aupres de son concentrateur —
 * adresse de superposition, adresse NBMA reelle, duree de bail — et le
 * premier paquet d'un client est justement son enregistrement. Le
 * diffuser le donne a tout le segment.
 *
 * Le correctif est celui des autres : `sendIpv4Packet`, qui route et
 * resout, met en file sur cache froid au lieu d'inonder.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur trois tombent contre l'etat d'avant : le tiers qui
 * recevait l'enregistrement, et l'adresse de destination de la trame. Le
 * TEMOIN passe des deux cotes et le doit — sans lui, « le tiers ne
 * recoit rien » serait satisfait par un client qui n'emet pas du tout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask, type IPv4Packet,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_NHRP } from '@/network/nhrp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Vu { dstMAC: string; packet: IPv4Packet }

function nhrpInto(device: { getPorts(): Array<{ attachTap(t: (f: {
  direction: string; frame: { dstMAC: { toString(): string }; payload: unknown };
}) => void): unknown }> }): Vu[] {
  const seen: Vu[] = [];
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type === 'ipv4' && packet.protocol === IP_PROTO_NHRP) {
        seen.push({ dstMAC: frame.dstMAC.toString(), packet });
      }
    });
  }
  return seen;
}

async function segment() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const spoke = new CiscoRouter('SPOKE');
  const hub = new CiscoRouter('HUB');
  const bystander = new LinuxPC('PC');

  new Cable('c1').connect(spoke.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(hub.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(bystander.getPorts()[0], sw.getPort('FastEthernet0/3')!);

  for (const [r, ip] of [[spoke, '10.0.0.1'], [hub, '10.0.0.2']] as const) {
    r.getPort('GigabitEthernet0/0')!
      .configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'end']) await r.executeCommand(c);
  }
  // Cache ARP froid : l'etat du PREMIER paquet, celui ou la retombee
  // diffusait — et l'enregistrement EST le premier paquet d'un client.
  spoke._clearArpEntry('10.0.0.2');
  return { sw, spoke, hub, bystander };
}

function registerWithHub(spoke: CiscoRouter): boolean {
  return spoke.getNhrpEngine()
    .sendRegistrationRequest('GigabitEthernet0/0', 'Tunnel0', '172.16.0.1', '10.0.0.2');
}

describe('un enregistrement NHRP ne part pas en diffusion', () => {
  it('le tiers du segment ne recoit AUCUN paquet NHRP', async () => {
    const { spoke, bystander } = await segment();
    const chezLeTiers = nhrpInto(bystander);
    registerWithHub(spoke);
    expect(chezLeTiers).toEqual([]);
  });

  it('TEMOIN — le concentrateur, lui, le recoit', async () => {
    const { spoke, hub } = await segment();
    const chezLeHub = nhrpInto(hub);
    expect(registerWithHub(spoke)).toBe(true);
    expect(chezLeHub.length).toBeGreaterThan(0);
  });

  it('la trame porte l\'adresse du CONCENTRATEUR et non la diffusion', async () => {
    const { spoke, hub } = await segment();
    const chezLeHub = nhrpInto(hub);
    const macDuHub = hub.getPort('GigabitEthernet0/0')!.getMAC().toString();
    registerWithHub(spoke);

    expect(chezLeHub.length).toBeGreaterThan(0);
    for (const f of chezLeHub) {
      expect(f.dstMAC).toBe(macDuHub);
      expect(f.dstMAC).not.toBe(MACAddress.broadcast().toString());
    }
  });
});
