import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetCounters, IPAddress, SubnetMask, MACAddress, createIPv4Packet,
  ETHERTYPE_IPV4, IP_PROTO_UDP, type UDPPacket,
} from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { DHCPPacket, DHCP_OPTION } from '@/network/dhcp/DHCPPacket';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { parseZoneFile } from '@/network/dns/zone/ZoneFile';
import { RRType } from '@/network/dns/wire/RRType';
import {
  dhcidIdentityFromChaddr, computeDhcidDigest, dhcidToPresentation,
  dhcidFromPresentation, makeDhcidForClient,
} from '@/network/dns/wire/Dhcid';
import type { DhcidRecordData } from '@/network/dns/wire/ResourceRecord';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, line: string) =>
  (await sh.processLine(line)).output.join('\n');

const REVERSE_ZONE = '40.168.192.in-addr.arpa';

function buildLab() {
  const srv = new WindowsServer('SRV-DHCP');
  const winClient = new WindowsPC('windows-pc', 'PC-WIN');
  const other = new LinuxPC('linux-pc', 'PC-LNX');
  const intruder = new LinuxPC('linux-pc', 'PC-INT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(winClient.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(other.getPorts()[0], sw.getPorts()[2]);
  new Cable('c4').connect(intruder.getPorts()[0], sw.getPorts()[3]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.40.5'), new SubnetMask('255.255.255.0'));
  srv.setCurrentUser('Administrator');
  return { srv, winClient, other, intruder, sw };
}

async function labWithZones(reverseZone: string | null = REVERSE_ZONE) {
  const { srv, winClient, other, intruder } = buildLab();
  const sh = ps(srv);
  await run(sh, 'Install-WindowsFeature -Name DNS -IncludeManagementTools');
  await run(sh, 'Install-WindowsFeature -Name DHCP -IncludeManagementTools');
  await run(sh, 'Add-DnsServerPrimaryZone -Name "lab.local"');
  if (reverseZone) await run(sh, `Add-DnsServerPrimaryZone -Name "${reverseZone}"`);
  await run(sh, 'Add-DhcpServerv4Scope -Name "LAN-40" -StartRange 192.168.40.10 '
    + '-EndRange 192.168.40.200 -SubnetMask 255.255.255.0 -State Active');
  await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -Router 192.168.40.1');
  await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 '
    + '-DnsServer 192.168.40.5 -DnsDomain "lab.local"');
  return { srv, winClient, other, intruder, sh };
}

async function lease(client: WindowsPC) {
  const cli = ps(client);
  await run(cli, 'ipconfig /release');
  return run(cli, 'ipconfig /renew');
}

function dhcpFrame(srcMac: string, pkt: DHCPPacket) {
  const udp: UDPPacket = {
    type: 'udp', sourcePort: 68, destinationPort: 67,
    length: 8 + 300, checksum: 0, payload: pkt,
  };
  return {
    srcMAC: new MACAddress(srcMac),
    dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(
      new IPAddress('0.0.0.0'), new IPAddress('255.255.255.255'),
      IP_PROTO_UDP, 64, udp, 8 + 300),
  };
}

/**
 * Un client ETRANGER : le client Windows de ce simulateur pose S=0 et
 * enregistre son A lui-meme (RFC 2136), le client Linux pose S=1 et le
 * demande au serveur ; les autres formes du drapeau ne peuvent venir que
 * d'une machine fabriquee ici. C'est aussi ce qui permet d'eprouver le
 * chemin SERVEUR sans qu'un client s'enregistre par-dessus. La
 * trame part du port de la machine, donc par le vrai cable — c'est la
 * meme trame que `EndHost` emet, un client sans adresse ne pouvant pas
 * passer par une route.
 */
async function foreignLease(
  host: LinuxPC, name: string, fqdnFlags: number | null, wanted = '192.168.40.10',
): Promise<void> {
  const port = host.getPorts()[0];
  const mac = port.getMAC().toString();
  const stamp = (pkt: DHCPPacket) => {
    pkt.setOption(DHCP_OPTION.HOST_NAME, name);
    if (fqdnFlags !== null) {
      pkt.setOption(DHCP_OPTION.CLIENT_FQDN, { flags: fqdnFlags, name });
    }
    return pkt;
  };
  port.sendFrame(dhcpFrame(mac, stamp(DHCPPacket.createDiscover(mac, 0x4242))));
  await Promise.resolve();
  port.sendFrame(dhcpFrame(
    mac, stamp(DHCPPacket.createRequest(mac, 0x4242, wanted, '192.168.40.5'))));
  await Promise.resolve();
}

describe('DHCP -> DNS : la zone inverse recoit le PTR', () => {
  it('un bail accorde ECRIT le PTR, pas seulement le A', async () => {
    const { winClient, sh } = await labWithZones();

    await lease(winClient);

    const direct = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(direct.toLowerCase()).toContain('pc-win');
    const inverse = await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`);
    expect(inverse.toLowerCase()).toContain('pc-win.lab.local');
    expect(inverse).toContain('PTR');
  });

  it('le nom du PTR est celui de RFC 1035 : les octets a l envers', async () => {
    const { winClient, sh } = await labWithZones();

    const renew = await lease(winClient);
    const adresse = /IPv4 Address[. ]*: (192\.168\.40\.\d+)/.exec(renew)?.[1];
    expect(adresse).toBeDefined();

    const inverse = await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`);
    const dernierOctet = adresse!.split('.')[3];
    expect(inverse).toContain(`${dernierOctet}.${REVERSE_ZONE}`);
  });

  it('la zone inverse est trouvee par SUFFIXE, pas par egalite', async () => {
    const { winClient, sh } = await labWithZones('168.192.in-addr.arpa');

    await lease(winClient);

    const inverse = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "168.192.in-addr.arpa"');
    expect(inverse.toLowerCase()).toContain('pc-win.lab.local');
  });

  it('sans zone inverse, le bail et le A sont accordes quand meme', async () => {
    const { winClient, sh } = await labWithZones(null);

    const renew = await lease(winClient);

    expect(renew).toMatch(/192\.168\.40\./);
    const direct = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(direct.toLowerCase()).toContain('pc-win');
  });

  it('DynamicUpdates Never ne touche NI le A NI le PTR du client qui le lui demande', async () => {
    const { other, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Never');

    await foreignLease(other, 'poste-never', 0x01);

    const direct = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(direct.toLowerCase()).not.toContain('poste-never');
    const inverse = await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`);
    expect(inverse.toLowerCase()).not.toContain('poste-never');
  });

  it('Never ne peut rien contre un client qui s enregistre LUI-MEME', async () => {
    const { winClient, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Never');

    await lease(winClient);

    const direct = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(direct.toLowerCase()).toContain('pc-win');
    const inverse = await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`);
    expect(inverse.toLowerCase()).not.toContain('pc-win');
  });

  it('la liberation du bail retire les DEUX enregistrements', async () => {
    const { winClient, sh } = await labWithZones();
    const cli = ps(winClient);
    await run(cli, 'ipconfig /release');
    await run(cli, 'ipconfig /renew');
    expect((await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`))
      .toLowerCase()).toContain('pc-win');

    await run(cli, 'ipconfig /release');

    const direct = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(direct.toLowerCase()).not.toContain('pc-win');
    const inverse = await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`);
    expect(inverse.toLowerCase()).not.toContain('pc-win');
  });
});

describe('RFC 4702 : le drapeau S decide du A, jamais du PTR', () => {
  it('S=0 : le serveur pose le PTR et LAISSE le A au client', async () => {
    const { other, sh } = await labWithZones();

    await foreignLease(other, 'poste-s0', 0x00);

    const direct = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(direct.toLowerCase()).not.toContain('poste-s0');
    const inverse = await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`);
    expect(inverse.toLowerCase()).toContain('poste-s0.lab.local');
  });

  it('S=1 : le serveur pose les deux', async () => {
    const { other, sh } = await labWithZones();

    await foreignLease(other, 'poste-s1', 0x01);

    expect((await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"')).toLowerCase())
      .toContain('poste-s1');
    expect((await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`)).toLowerCase())
      .toContain('poste-s1.lab.local');
  });

  it('N=1 : le serveur ne pose RIEN, meme en Always', async () => {
    const { other, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Always');

    await foreignLease(other, 'poste-n1', 0x08);

    expect((await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"')).toLowerCase())
      .not.toContain('poste-n1');
    expect((await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`)).toLowerCase())
      .not.toContain('poste-n1');
  });

  it('Always passe outre S=0 et pose le A', async () => {
    const { other, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Always');

    await foreignLease(other, 'poste-always', 0x00);

    expect((await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"')).toLowerCase())
      .toContain('poste-always');
  });

  it('un client SANS option 81 est ignore tant qu on ne l a pas demande', async () => {
    const { other, sh } = await labWithZones();

    await foreignLease(other, 'poste-ancien', null);

    expect((await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"')).toLowerCase())
      .not.toContain('poste-ancien');
    expect((await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`)).toLowerCase())
      .not.toContain('poste-ancien');
  });

  it('UpdateDnsRRForOlderClients le prend en charge', async () => {
    const { other, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -UpdateDnsRRForOlderClients $true');

    await foreignLease(other, 'poste-ancien', null);

    expect((await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"')).toLowerCase())
      .toContain('poste-ancien');
    expect((await run(sh, `Get-DnsServerResourceRecord -ZoneName "${REVERSE_ZONE}"`)).toLowerCase())
      .toContain('poste-ancien.lab.local');
  });
});

describe('RFC 4701 : NameProtection tient le nom par un DHCID', () => {
  it('sans NameProtection, aucun DHCID n est ecrit', async () => {
    const { winClient, sh } = await labWithZones();

    await lease(winClient);

    expect(await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"'))
      .not.toContain('DHCID');
  });

  it('avec NameProtection, le DHCID accompagne le A', async () => {
    const { other, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -NameProtection $true');

    await foreignLease(other, 'poste-np', 0x01);

    const records = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(records).toContain('DHCID');
  });

  it('sans NameProtection, un autre client PREND le nom — le temoin', async () => {
    const { other, intruder, sh } = await labWithZones();
    await foreignLease(other, 'poste-np', 0x01);

    await foreignLease(intruder, 'poste-np', 0x01, '192.168.40.77');

    const apres = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(apres).toContain('192.168.40.77');
  });

  it('avec NameProtection, un AUTRE client ne peut pas prendre le nom tenu', async () => {
    const { other, intruder, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -NameProtection $true');
    await foreignLease(other, 'poste-np', 0x01);

    await foreignLease(intruder, 'poste-np', 0x01, '192.168.40.77');

    const apres = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(apres).not.toContain('192.168.40.77');
    expect(apres).toContain('192.168.40.10');
  });

  it('le MEME client garde son nom d un bail a l autre', async () => {
    const { winClient, sh } = await labWithZones();
    await run(sh, 'Set-DhcpServerv4DnsSetting -NameProtection $true');
    await lease(winClient);

    await lease(winClient);

    const records = await run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');
    expect(records.toLowerCase()).toContain('pc-win');
    expect(records).toMatch(/192\.168\.40\./);
  });
});

describe('DHCID : un vrai condense, un vrai enregistrement', () => {
  it('deux clients differents ne donnent pas le meme condense', () => {
    const a = computeDhcidDigest(dhcidIdentityFromChaddr('02:00:00:00:00:05'), 'pc.lab.local');
    const b = computeDhcidDigest(dhcidIdentityFromChaddr('02:00:00:00:00:06'), 'pc.lab.local');

    expect(a).not.toBe(b);
    expect(a.length).toBe(32);
  });

  it('le meme client et le meme nom donnent le meme condense', () => {
    const a = computeDhcidDigest(dhcidIdentityFromChaddr('02:00:00:00:00:05'), 'pc.lab.local');
    const b = computeDhcidDigest(dhcidIdentityFromChaddr('02-00-00-00-00-05'), 'PC.LAB.LOCAL');

    expect(a).toBe(b);
  });

  it('deux noms differents pour le meme client ne donnent pas le meme condense', () => {
    const identity = dhcidIdentityFromChaddr('02:00:00:00:00:05');

    expect(computeDhcidDigest(identity, 'a.lab.local'))
      .not.toBe(computeDhcidDigest(identity, 'b.lab.local'));
  });

  it('la forme de presentation est le base64 de la RDATA entiere', () => {
    const rr = makeDhcidForClient('pc.lab.local', dhcidIdentityFromChaddr('02:00:00:00:00:05'));
    const texte = dhcidToPresentation(rr.data);

    const relu = dhcidFromPresentation(texte);
    expect(relu.identifierType).toBe(rr.data.identifierType);
    expect(relu.digestType).toBe(1);
    expect(relu.digest).toBe(rr.data.digest);
  });

  it('un DHCID traverse le codec DNS sans perdre un octet', () => {
    const rr = makeDhcidForClient('pc.lab.local', dhcidIdentityFromChaddr('02:00:00:00:00:05'));

    const relu = decodeDnsMessage(encodeDnsMessage({
      id: 1, flags: { qr: true, opcode: 0, aa: true, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: 0 },
      questions: [{ qname: 'pc.lab.local', qtype: RRType.DHCID, qclass: 1 }],
      answers: [rr], authorities: [], additionals: [],
    }));

    const data = relu.answers[0].data as DhcidRecordData;
    expect(data.type).toBe(RRType.DHCID);
    expect(data.identifierType).toBe(rr.data.identifierType);
    expect(data.digestType).toBe(1);
    expect(data.digest).toBe(rr.data.digest);
  });

  it('un fichier de zone qui porte un DHCID le relit', () => {
    const rr = makeDhcidForClient('pc.lab.local', dhcidIdentityFromChaddr('02:00:00:00:00:05'));
    const zone = parseZoneFile([
      '$ORIGIN lab.local.',
      '$TTL 3600',
      '@ IN SOA ns.lab.local. admin.lab.local. 1 900 600 86400 3600',
      '@ IN NS ns.lab.local.',
      `pc IN DHCID ${dhcidToPresentation(rr.data)}`,
    ].join('\n'));

    const set = zone.getRRSet('pc.lab.local', RRType.DHCID) ?? [];
    expect(set.length).toBe(1);
    expect((set[0].data as DhcidRecordData).digest).toBe(rr.data.digest);
  });
});
