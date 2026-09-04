import type { IPSecEngine } from '../../../ipsec/IPSecEngine';
import type { CryptoMapEntry, SATrafficSelector } from '../../../ipsec/IPSecTypes';
import type {
  IpsecProposal, IpsecTunnelTable, Phase1Tunnel, Phase2Tunnel,
} from './IpsecTunnelTable';
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

function wildcardOf(mask: string): string {
  const octets = mask.split('.').map(part => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some(value => Number.isNaN(value))) return '';
  return octets.map(value => 255 - value).join('.');
}

function selectorsOf(phase2: Phase2Tunnel | undefined): SATrafficSelector | undefined {
  if (!phase2) return undefined;
  if (phase2.sourceSubnet.length === 0 || phase2.destinationSubnet.length === 0) {
    return undefined;
  }
  return {
    srcAddress: phase2.sourceSubnet,
    srcWildcard: wildcardOf(phase2.sourceMask),
    dstAddress: phase2.destinationSubnet,
    dstWildcard: wildcardOf(phase2.destinationMask),
    protocol: 0, srcPort: 0, dstPort: 0,
  };
}

export function requestsConfiguration(tunnel: {
  modeCfg?: boolean; poolStart?: string; poolEnd?: string;
}): boolean {
  return tunnel.modeCfg === true
    && (tunnel.poolStart ?? '').length === 0
    && (tunnel.poolEnd ?? '').length === 0;
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
    entry.trafficSelectors = selectorsOf(selectors[0]);
    if (selectors[0]?.pfs) entry.pfsGroup = `group${selectors[0].dhGroups[0] ?? 14}`;

    if (tunnel.boundInterface.length > 0) {
      engine.applyCryptoMapToInterface(tunnel.boundInterface, cryptoMapName(tunnel.name));
    }

    if (requestsConfiguration(tunnel)) {
      engine.requestConfigFor(tunnel.remoteGateway, {
        wantAddress: true,
        identity: tunnel.authUser,
        credential: tunnel.authPassword,
      });
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

  const gatewayUp = engine.hasIkeSA(declared.remoteGateway);
  applyReceivedConfiguration(engine, tunnels, declared);
  const sas = engine.getIPSecSAs(declared.remoteGateway);
  if (sas.length === 0) {
    tunnels.markDown(name,
      failureReason(tunnels.selectorsOf(name).length > 0, gatewayUp));
    tunnels.markGateway(name, gatewayUp);
    return false;
  }

  tunnels.markUp(name, sas[0].natT === true);
  return true;
}

function failureReason(hasSelector: boolean, gatewayUp: boolean): string {
  if (!hasSelector) return 'no phase2 selector bound to this phase1';
  return gatewayUp ? 'no matching selector' : 'negotiation failed';
}

function applyReceivedConfiguration(
  engine: IPSecEngine, tunnels: IpsecTunnelTable, tunnel: Phase1Tunnel,
): void {
  if (!requestsConfiguration(tunnel)) return;
  const reply = engine.configReplyFor(tunnel.remoteGateway);
  if (!reply) return;
  tunnels.recordAssignment(tunnel.name, reply);
}
