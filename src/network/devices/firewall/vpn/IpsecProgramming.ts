import type { IPSecEngine } from '../../../ipsec/IPSecEngine';
import type { CryptoMapEntry } from '../../../ipsec/IPSecTypes';
import {
  IPAddress, IP_PROTO_UDP, createIPv4Packet,
  type IPv4Packet, type UDPPacket,
} from '../../../core/types';
import type { IpsecProposal, IpsecTunnelTable } from './IpsecTunnelTable';
import type { CertificateStore } from './CertificateStore';
import { CertificateVerifier } from '../../../pki/CertificateVerifier';

export function cryptoMapName(tunnel: string): string {
  return `FORTI_${tunnel}`;
}

export function cryptoEntryFor(
  engine: IPSecEngine, tunnel: string,
): CryptoMapEntry | undefined {
  return engine.getCryptoMap(cryptoMapName(tunnel))?.staticEntries.get(1);
}

export function transformSetName(tunnel: string): string {
  return `TS_${tunnel}`;
}

export function transformsOf(proposals: readonly IpsecProposal[]): string[] {
  const out: string[] = [];
  for (const proposal of proposals) {
    out.push(espTransform(proposal.cipher));
    out.push(`esp-${proposal.integrity}-hmac`);
  }
  return out.length > 0 ? out : ['esp-aes', 'esp-sha256-hmac'];
}

function espTransform(cipher: string): string {
  if (cipher === 'aes256') return 'esp-256-aes';
  if (cipher === 'aes192') return 'esp-192-aes';
  if (cipher === 'aes128gcm') return 'esp-gcm';
  if (cipher === 'aes256gcm') return 'esp-gcm-256';
  if (cipher === '3des') return 'esp-3des';
  if (cipher === 'des') return 'esp-des';
  return 'esp-aes';
}

export function programIpsecEngine(
  engine: IPSecEngine, tunnels: IpsecTunnelTable,
  certificates?: CertificateStore, now?: () => number,
): void {
  let priority = 10;
  if (certificates) programCertificateAuth(engine, tunnels, certificates, now);
  programLiveness(engine, tunnels);

  for (const tunnel of tunnels.all()) {
    const selectors = tunnels.selectorsOf(tunnel.name);
    const proposals = selectors[0]?.proposals ?? tunnel.proposals;

    for (const group of tunnel.dhGroups) {
      const policy = engine.getOrCreateISAKMPPolicy(priority++);
      policy.encryption = ikeEncryption(tunnel.proposals);
      policy.hash = ikeHash(tunnel.proposals);
      policy.group = group;
      policy.auth = tunnel.authMethod === 'signature' ? 'rsa-sig' : 'pre-share';
      policy.lifetime = tunnel.keyLifeSeconds;
    }

    if (tunnel.authMethod !== 'signature' && tunnel.presharedKey.length > 0) {
      engine.addPreSharedKey(tunnel.remoteGateway, tunnel.presharedKey);
    }

    engine.addTransformSet(transformSetName(tunnel.name), transformsOf(proposals));

    const entry = engine.getOrCreateCryptoMapEntry(cryptoMapName(tunnel.name), 1);
    entry.peers = [tunnel.remoteGateway];
    entry.transformSets = [transformSetName(tunnel.name)];
    entry.saLifetimeSeconds = selectors[0]?.keyLifeSeconds ?? tunnel.keyLifeSeconds;
    if (selectors[0]?.pfs) entry.pfsGroup = `group${selectors[0].dhGroups[0] ?? 14}`;

    if (tunnel.boundInterface.length > 0) {
      engine.applyCryptoMapToInterface(tunnel.boundInterface, cryptoMapName(tunnel.name));
    }
  }
}

function ikeEncryption(proposals: readonly IpsecProposal[]): string {
  const first = proposals[0]?.cipher ?? 'aes256';
  if (first === 'aes256' || first === 'aes256gcm') return 'aes 256';
  if (first === 'aes192') return 'aes 192';
  if (first === '3des') return '3des';
  if (first === 'des') return 'des';
  return 'aes';
}

function ikeHash(proposals: readonly IpsecProposal[]): string {
  return proposals[0]?.integrity ?? 'sha256';
}

function programLiveness(engine: IPSecEngine, tunnels: IpsecTunnelTable): void {
  const declared = tunnels.all();
  const probing = declared.find(tunnel => tunnel.dpd !== 'disable');

  if (!probing) engine.clearDPD();
  else {
    engine.setDPD(probing.dpdRetryIntervalSeconds, probing.dpdRetryCount,
      probing.dpd === 'on-idle' ? 'periodic' : 'on-demand');
  }

  const traversal = declared.find(tunnel => tunnel.natTraversal !== 'enable');
  engine.setNatTraversalPolicy(traversal?.natTraversal ?? 'enable');
}

function programCertificateAuth(
  engine: IPSecEngine, tunnels: IpsecTunnelTable,
  certificates: CertificateStore, now?: () => number,
): void {
  const signing = tunnels.all().find(tunnel => tunnel.authMethod === 'signature');
  const local = signing ? certificates.local(signing.certificate) : undefined;
  const trustAnchors = certificates.trustAnchors();

  if (!local) { engine.clearIkeCertAuth(); return; }

  engine.setIkeCertAuth({
    localCert: local.certificate,
    localKey: local.privateKey,
    trustAnchors,
    revocationCheck: 'none',
    clock: now,
    verifier: new CertificateVerifier({
      trustAnchors, revocationCheck: 'none', clock: now,
    }),
  });
}

export function bringUpTunnel(
  engine: IPSecEngine, tunnels: IpsecTunnelTable, name: string,
): boolean {
  const declared = tunnels.getPhase1(name);
  if (!declared) return false;

  programIpsecEngine(engine, tunnels);

  const entry = cryptoEntryFor(engine, name);
  if (entry && declared.boundInterface.length > 0) {
    engine.initiateTunnel(declared.remoteGateway, entry, declared.boundInterface);
  }

  const sas = engine.getIPSecSAs(declared.remoteGateway);
  if (sas.length === 0) { tunnels.markDown(name, 'negotiation failed'); return false; }

  tunnels.markUp(name, sas[0].natT === true);
  return true;
}

export function udpDatagram(
  source: string, destination: string, port: number, payload: unknown,
): IPv4Packet {
  const udp: UDPPacket = {
    type: 'udp', sourcePort: port, destinationPort: port,
    length: 8 + 64, checksum: 0, payload,
  };
  return createIPv4Packet(
    new IPAddress(source), new IPAddress(destination), IP_PROTO_UDP, 64, udp, 8 + 64);
}
