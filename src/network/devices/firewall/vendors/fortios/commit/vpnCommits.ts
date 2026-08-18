import type { Firewall } from '../../../Firewall';
import { parseProposal } from '../../../vpn/IpsecProposals';
import type { IpsecProposal, Phase1Type, DpdMode } from '../../../vpn/IpsecTunnelTable';
import type { FortiCommitDevice } from '../schema/types';
import { readCertificatePem, readPrivateKeyPem } from '../../../vpn/CertificateStore';

type VpnHandlers = Pick<FortiCommitDevice,
  'applyPhase1' | 'removePhase1' | 'applyPhase2' | 'removePhase2'
  | 'applyLocalCertificate' | 'removeLocalCertificate'
  | 'applyCaCertificate' | 'removeCaCertificate'>;

export function vpnCommitHandlers(fw: Firewall): VpnHandlers {
  return {
    applyPhase1(tunnel) {
      fw.getTunnelTable().setPhase1({
        name: tunnel.name,
        boundInterface: tunnel.boundInterface,
        ikeVersion: tunnel.ikeVersion,
        type: asPhase1Type(tunnel.type),
        remoteGateway: tunnel.remoteGateway,
        proposals: acceptedProposals(tunnel.proposals),
        dhGroups: [...tunnel.dhGroups],
        presharedKey: tunnel.presharedKey,
        keyLifeSeconds: tunnel.keyLifeSeconds,
        authMethod: tunnel.authMethod,
        certificate: tunnel.certificate,
        dpd: asDpdMode(tunnel.dpd),
        natTraversal: tunnel.natTraversal,
        policyBased: tunnel.policyBased,
        comments: tunnel.comments,
      });
      fw.syncIpsecTunnels();
    },
    removePhase1(name) {
      fw.getTunnelTable().removePhase1(name);
      fw.syncIpsecTunnels();
    },
    applyLocalCertificate(entry) {
      const certificate = readCertificatePem(entry.certificatePem);
      if (entry.certificatePem !== '' && !certificate) {
        return 'the certificate is not readable PEM.';
      }
      const privateKey = readPrivateKeyPem(entry.privateKeyPem);
      if (entry.privateKeyPem !== '' && !privateKey) {
        return 'the private key is not readable PEM.';
      }
      if (!certificate || !privateKey) return;

      fw.getCertificateStore().setLocal({
        name: entry.name,
        certificate,
        privateKey,
        certificatePem: entry.certificatePem,
        privateKeyPem: entry.privateKeyPem,
        comments: entry.comments,
      });
      fw.syncIpsecTunnels();
    },
    removeLocalCertificate(name) {
      fw.getCertificateStore().removeLocal(name);
      fw.syncIpsecTunnels();
    },
    applyCaCertificate(entry) {
      const certificate = readCertificatePem(entry.certificatePem);
      if (entry.certificatePem !== '' && !certificate) {
        return 'the CA certificate is not readable PEM.';
      }
      if (!certificate) return;

      fw.getCertificateStore().setAuthority({
        name: entry.name,
        certificate,
        certificatePem: entry.certificatePem,
        trusted: entry.trusted,
      });
      fw.syncIpsecTunnels();
    },
    removeCaCertificate(name) {
      fw.getCertificateStore().removeAuthority(name);
      fw.syncIpsecTunnels();
    },
    applyPhase2(tunnel) {
      fw.getTunnelTable().setPhase2({
        name: tunnel.name,
        phase1Name: tunnel.phase1Name,
        proposals: acceptedProposals(tunnel.proposals),
        sourceSubnet: tunnel.sourceSubnet,
        sourceMask: tunnel.sourceMask,
        destinationSubnet: tunnel.destinationSubnet,
        destinationMask: tunnel.destinationMask,
        pfs: tunnel.pfs,
        dhGroups: [...tunnel.dhGroups],
        keyLifeSeconds: tunnel.keyLifeSeconds,
        autoNegotiate: tunnel.autoNegotiate,
      });
      fw.syncIpsecTunnels();
    },
    removePhase2(name) {
      fw.getTunnelTable().removePhase2(name);
      fw.syncIpsecTunnels();
    },
  };
}

function acceptedProposals(words: readonly string[]): IpsecProposal[] {
  const out: IpsecProposal[] = [];
  for (const word of words) {
    const verdict = parseProposal(word);
    if (verdict.ok) out.push(verdict.proposal);
  }
  return out;
}

function asPhase1Type(declared: string): Phase1Type {
  if (declared === 'dynamic' || declared === 'ddns') return declared;
  return 'static';
}

function asDpdMode(declared: string): DpdMode {
  if (declared === 'disable' || declared === 'on-idle') return declared;
  return 'on-demand';
}
