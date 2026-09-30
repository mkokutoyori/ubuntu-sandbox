/*
 * RFC 2131 (docs/rfc/dhcp/rfc2131.txt), comportement du SERVEUR, mesure au
 * point d'entree que partagent tous les serveurs du projet
 * (buildDhcpServerReply : routeurs Cisco et Huawei, SVI de commutateur,
 * dhcpd Linux, role DHCP de Windows Server, serveur DHCP du FortiGate).
 *
 * Chaque cas cite l'exigence : §4.2 (identifiant du client), §4.3.1 et
 * tableau 3 (champs et options d'un serveur), §4.3.2 (INIT-REBOOT,
 * RENEWING, REBINDING, NAK), §4.3.3 a §4.3.5 (DECLINE, RELEASE, INFORM).
 *
 * Ecrite avant tout correctif : la colonne « avant » de chaque defaut est
 * mesuree ici, puis le moteur est corrige. Les TEMOINS (comportements deja
 * conformes) sont nommes comme tels dans les noms de cas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPPacket, DHCP_OPTION } from '@/network/dhcp/DHCPPacket';
import { buildDhcpServerReply } from '@/network/dhcp/DhcpServerExchange';
import { resetCounters } from '@/network/core/types';

beforeEach(() => resetCounters());

const SERVER = '10.0.0.1';
const MAC_A = 'aa:bb:cc:00:00:01';
const MAC_B = 'aa:bb:cc:00:00:02';

function server(configure: (s: DHCPServer, pool: string) => void = () => undefined): DHCPServer {
  const s = new DHCPServer();
  s.setPingPacketCount(0);
  s.setServerIdentifier(SERVER);
  s.createPool('LAN');
  s.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');
  s.configurePoolLease('LAN', 3600);
  s.addExcludedRange('10.0.0.1', '10.0.0.9');
  configure(s, 'LAN');
  return s;
}

const ask = (s: DHCPServer, packet: DHCPPacket) => buildDhcpServerReply(packet, { server: s, localGatewayIP: SERVER });

function discover(mac: string, extra: (p: DHCPPacket) => void = () => undefined): DHCPPacket {
  const p = DHCPPacket.createDiscover(mac, 1);
  extra(p);
  return p;
}

function selecting(mac: string, ip: string, extra: (p: DHCPPacket) => void = () => undefined): DHCPPacket {
  const p = DHCPPacket.createRequest(mac, 2, ip, SERVER);
  extra(p);
  return p;
}

function initReboot(mac: string, ip: string, extra: (p: DHCPPacket) => void = () => undefined): DHCPPacket {
  const p = DHCPPacket.createRequest(mac, 3, ip, SERVER);
  p.removeOption(DHCP_OPTION.SERVER_IDENTIFIER);
  extra(p);
  return p;
}

function renewing(mac: string, ip: string): DHCPPacket {
  const p = DHCPPacket.createRequest(mac, 4, ip, SERVER);
  p.removeOption(DHCP_OPTION.SERVER_IDENTIFIER);
  p.removeOption(DHCP_OPTION.REQUESTED_IP);
  p.ciaddr = ip;
  p.flags = 0;
  return p;
}

function lease(s: DHCPServer, mac: string, extra: (p: DHCPPacket) => void = () => undefined): string {
  const offer = ask(s, discover(mac, extra))!;
  ask(s, selecting(mac, offer.yiaddr, extra));
  return offer.yiaddr;
}

describe('§4.2 identifiant du client', () => {
  it('l option 61 identifie le client : deux cartes de meme chaddr et d identifiants differents ont deux baux', () => {
    const s = server();
    const first = lease(s, MAC_A, p => p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'id-one'));
    const second = lease(s, MAC_A, p => p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'id-two'));
    expect(second).not.toBe(first);
  });

  it('l option 61 identifie le client : un meme identifiant sur une autre carte retrouve le meme bail', () => {
    const s = server();
    const first = lease(s, MAC_A, p => p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'id-one'));
    const again = ask(s, discover(MAC_B, p => p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'id-one')))!;
    expect(again.yiaddr).toBe(first);
  });

  it('TEMOIN : sans option 61, chaddr identifie le client', () => {
    const s = server();
    const first = lease(s, MAC_A);
    expect(ask(s, discover(MAC_A))!.yiaddr).toBe(first);
  });
});

describe('tableau 3 : champs et options des reponses', () => {
  it('l OFFER porte le temps de bail (51) et l identifiant du serveur (54) — TEMOIN', () => {
    const offer = ask(server(), discover(MAC_A))!;
    expect(offer.getOption(DHCP_OPTION.LEASE_TIME)).toBe(3600);
    expect(offer.getOption(DHCP_OPTION.SERVER_IDENTIFIER)).toBe(SERVER);
  });

  it('l OFFER et l ACK ne portent ni adresse demandee (50), ni liste de parametres (55), ni taille maximale (57)', () => {
    const s = server();
    const offer = ask(s, discover(MAC_A, p => p.setOption(55, [1, 3, 6])))!;
    const ack = ask(s, selecting(MAC_A, offer.yiaddr, p => p.setOption(55, [1, 3, 6])))!;
    for (const reply of [offer, ack]) {
      expect(reply.getOption(50)).toBeUndefined();
      expect(reply.getOption(55)).toBeUndefined();
      expect(reply.getOption(57)).toBeUndefined();
    }
  });

  it('siaddr est « l adresse du prochain serveur d amorcage » : 0 quand aucun n est configure', () => {
    const offer = ask(server(), discover(MAC_A))!;
    expect(offer.siaddr).toBe('0.0.0.0');
  });

  it('siaddr est le next-server configure', () => {
    const offer = ask(server((s, pool) => s.configurePoolNextServer(pool, '10.0.0.50')), discover(MAC_A))!;
    expect(offer.siaddr).toBe('10.0.0.50');
  });

  it('un routeur non configure n est pas annonce (« MUST omit any parameters it cannot provide »)', () => {
    const offer = ask(server(), discover(MAC_A))!;
    expect(offer.getOption(DHCP_OPTION.ROUTER)).toBeUndefined();
  });

  it('TEMOIN : un routeur configure est annonce', () => {
    const offer = ask(server((s, pool) => s.configurePoolRouter(pool, '10.0.0.1')), discover(MAC_A))!;
    expect(offer.getOption(DHCP_OPTION.ROUTER)).toBeDefined();
  });

  it('le NAK porte l identifiant du serveur, aucun temps de bail, yiaddr et ciaddr a zero', () => {
    const nak = ask(server(), initReboot(MAC_A, '192.168.99.5'))!;
    expect(nak.getMessageType()).toBe('DHCPNAK');
    expect(nak.getOption(DHCP_OPTION.SERVER_IDENTIFIER)).toBe(SERVER);
    expect(nak.getOption(DHCP_OPTION.LEASE_TIME)).toBeUndefined();
    expect(nak.yiaddr).toBe('0.0.0.0');
    expect(nak.ciaddr).toBe('0.0.0.0');
  });
});

describe('§4.3.2 DHCPREQUEST', () => {
  it('INIT-REBOOT sur un mauvais reseau : DHCPNAK', () => {
    const reply = ask(server(), initReboot(MAC_A, '192.168.99.5'));
    expect(reply?.getMessageType()).toBe('DHCPNAK');
  });

  it('INIT-REBOOT sans enregistrement du client : le serveur reste MUET', () => {
    expect(ask(server(), initReboot(MAC_A, '10.0.0.77'))).toBeNull();
  });

  it('INIT-REBOOT avec une autre adresse que la sienne : DHCPNAK', () => {
    const s = server();
    lease(s, MAC_A);
    expect(ask(s, initReboot(MAC_A, '10.0.0.200'))?.getMessageType()).toBe('DHCPNAK');
  });

  it('TEMOIN : INIT-REBOOT avec sa propre adresse : DHCPACK', () => {
    const s = server();
    const address = lease(s, MAC_A);
    expect(ask(s, initReboot(MAC_A, address))?.getMessageType()).toBe('DHCPACK');
  });

  it('un NAK a un client relaye porte le bit de diffusion, meme si le client ne l a pas leve', () => {
    const s = server();
    const request = initReboot(MAC_A, '192.168.99.5', p => { p.giaddr = '10.0.0.254'; p.flags = 0; });
    const nak = ask(s, request);
    expect(nak?.getMessageType()).toBe('DHCPNAK');
    expect((nak!.flags & 0x8000) !== 0).toBe(true);
  });

  it('RENEWING : le serveur repond ACK avec un temps de bail (51)', () => {
    const s = server();
    const address = lease(s, MAC_A);
    const ack = ask(s, renewing(MAC_A, address))!;
    expect(ack.getMessageType()).toBe('DHCPACK');
    expect(ack.getOption(DHCP_OPTION.LEASE_TIME)).toBeGreaterThan(0);
  });

  it('REBINDING avec un ciaddr qui n est pas le sien : DHCPNAK (« SHOULD check ciaddr for correctness »)', () => {
    const s = server();
    lease(s, MAC_A);
    expect(ask(s, renewing(MAC_A, '10.0.0.222'))?.getMessageType()).toBe('DHCPNAK');
  });
});

describe('§4.3.1 choix de l adresse et du bail', () => {
  it('un client qui a un bail retrouve le meme bail et le temps RESTANT, pas un bail neuf', () => {
    const s = server();
    const address = lease(s, MAC_A);
    s.setClock(() => Date.now() + 1800_000);
    const offer = ask(s, discover(MAC_A))!;
    expect(offer.yiaddr).toBe(address);
    expect(offer.getOption(DHCP_OPTION.LEASE_TIME)).toBeLessThanOrEqual(1800);
  });

  it('TEMOIN : sans bail, le bail configure est offert', () => {
    expect(ask(server(), discover(MAC_A))!.getOption(DHCP_OPTION.LEASE_TIME)).toBe(3600);
  });

  it('un client dont le bail a ete libere retrouve son ancienne adresse (§4.3.1, 2e regle)', () => {
    const s = server();
    const address = lease(s, MAC_A);
    ask(s, DHCPPacket.createRelease(MAC_A, 9, address, SERVER));
    expect(ask(s, discover(MAC_A))!.yiaddr).toBe(address);
  });
});

describe('§4.3.3 a §4.3.5', () => {
  it('DHCPDECLINE : l adresse n est plus offerte — TEMOIN', () => {
    const s = server();
    const offer = ask(s, discover(MAC_A))!;
    ask(s, DHCPPacket.createDecline(MAC_A, 5, offer.yiaddr, SERVER));
    expect(ask(s, discover(MAC_B))!.yiaddr).not.toBe(offer.yiaddr);
  });

  it('DHCPINFORM : ACK sans temps de bail (« MUST NOT send a lease expiration time ») et sans yiaddr', () => {
    const ack = ask(server(), DHCPPacket.createInform(MAC_A, 6, '10.0.0.150'))!;
    expect(ack.getMessageType()).toBe('DHCPACK');
    expect(ack.getOption(DHCP_OPTION.LEASE_TIME)).toBeUndefined();
    expect(ack.yiaddr).toBe('0.0.0.0');
  });

  it('DHCPINFORM : porte les parametres du sous-reseau (masque) — TEMOIN', () => {
    const ack = ask(server(), DHCPPacket.createInform(MAC_A, 6, '10.0.0.150'))!;
    expect(ack.getOption(DHCP_OPTION.SUBNET_MASK)).toBe('255.255.255.0');
  });

  it('DHCPINFORM : ne cree aucun bail', () => {
    const s = server();
    ask(s, DHCPPacket.createInform(MAC_A, 6, '10.0.0.150'));
    expect(s.getBindings().size).toBe(0);
  });
});

describe('§4.3.1 liste de parametres demandes (option 55)', () => {
  it('un parametre configure et demande est renvoye une seule fois — TEMOIN', () => {
    const s = server((srv, pool) => srv.configurePoolDNS(pool, ['8.8.8.8']));
    const offer = ask(s, discover(MAC_A, p => p.setOption(55, [6])))!;
    expect(offer.getOption(DHCP_OPTION.DNS)).toEqual(['8.8.8.8']);
  });

  it('un parametre que le serveur ne peut pas fournir est omis meme s il est demande', () => {
    const offer = ask(server(), discover(MAC_A, p => p.setOption(55, [3, 6, 15])))!;
    expect(offer.getOption(DHCP_OPTION.DNS)).toBeUndefined();
    expect(offer.getOption(DHCP_OPTION.DOMAIN_NAME)).toBeUndefined();
    expect(offer.getOption(DHCP_OPTION.ROUTER)).toBeUndefined();
  });
});
