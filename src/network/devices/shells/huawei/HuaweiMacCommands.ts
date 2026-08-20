import type { MACTableEntry } from '../../Switch';
import { huaweiMacAddress } from './huaweiTableLayouts';
import { huaweiDisplayInterfaceName } from '../cli-utils';

export const VRP_MAC_AGING_DEFAUT = 300;

export type MacAnalyse =
  | { statut: 'aging-time'; secondes: number }
  | { statut: 'static'; mac: string; iface: string; vlan: number }
  | { statut: 'blackhole'; mac: string; vlan: number }
  | { statut: 'refus'; token: string | null };

const MAC_VRP = /^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}$/;

export function normaliserMacVrp(valeur: string): string | null {
  if (!MAC_VRP.test(valeur)) return null;
  const brut = valeur.replace(/-/g, '').toLowerCase();
  return brut.match(/.{2}/g)!.join(':');
}

function lireVlan(mots: readonly string[], depuis: number): number | null {
  if ((mots[depuis] ?? '').toLowerCase() !== 'vlan') return null;
  const n = parseInt(mots[depuis + 1] ?? '', 10);
  if (isNaN(n) || n < 1 || n > 4094) return null;
  return n;
}

export function analyserMacAddress(args: readonly string[]): MacAnalyse {
  const mots = args.filter(a => a.length > 0);
  if (mots.length === 0) return { statut: 'refus', token: null };
  const tete = mots[0].toLowerCase();

  if (tete === 'aging-time') {
    const n = parseInt(mots[1] ?? '', 10);
    if (mots[1] === undefined) return { statut: 'refus', token: null };
    if (isNaN(n) || n < 0 || n > 1000000 || mots.length > 2) {
      return { statut: 'refus', token: mots[2] ?? mots[1] };
    }
    return { statut: 'aging-time', secondes: n };
  }

  if (tete === 'static' || tete === 'blackhole') {
    const mac = normaliserMacVrp(mots[1] ?? '');
    if (mots[1] === undefined) return { statut: 'refus', token: null };
    if (!mac) return { statut: 'refus', token: mots[1] };
    if (tete === 'blackhole') {
      const vlan = lireVlan(mots, 2);
      if (vlan === null) return { statut: 'refus', token: mots[2] ?? null };
      if (mots.length > 4) return { statut: 'refus', token: mots[4] };
      return { statut: 'blackhole', mac, vlan };
    }
    const vlanAt = mots.findIndex((m, i) => i >= 2 && m.toLowerCase() === 'vlan');
    if (vlanAt < 0) return { statut: 'refus', token: mots[2] ?? null };
    const iface = mots.slice(2, vlanAt).join('');
    if (!iface) return { statut: 'refus', token: mots[2] ?? null };
    const vlan = lireVlan(mots, vlanAt);
    if (vlan === null) return { statut: 'refus', token: mots[vlanAt + 1] ?? null };
    if (mots.length > vlanAt + 2) return { statut: 'refus', token: mots[vlanAt + 2] };
    return { statut: 'static', mac, iface, vlan };
  }

  return { statut: 'refus', token: mots[0] };
}

export function macRunningConfigLines(
  entries: readonly MACTableEntry[], agingTime: number,
): string[] {
  const out: string[] = [];
  if (agingTime !== VRP_MAC_AGING_DEFAUT) out.push(`mac-address aging-time ${agingTime}`);
  for (const e of entries) {
    if (e.type === 'static') {
      out.push(`mac-address static ${huaweiMacAddress(e.mac)} ${huaweiDisplayInterfaceName(e.port)} vlan ${e.vlan}`);
    } else if (e.type === 'blackhole') {
      out.push(`mac-address blackhole ${huaweiMacAddress(e.mac)} vlan ${e.vlan}`);
    }
  }
  return out;
}
