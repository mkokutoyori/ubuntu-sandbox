
import { renderTable, VRP_TABLE, FIXED_TABLE, type TableColumn } from '../cli/TextTable';

export interface LigneIpBrief {
  readonly nom: string;
  readonly adresse: string;
  readonly physique: string;
  readonly protocole: string;
}

export const COLONNES_IP_BRIEF: ReadonlyArray<TableColumn<LigneIpBrief>> = [
  { header: 'Interface', width: 32, value: (r) => r.nom },
  { header: 'IP Address/Mask', width: 19, value: (r) => r.adresse },
  { header: 'Physical', width: 9, value: (r) => r.physique },
  { header: 'Protocol', value: (r) => r.protocole },
];

export const LEGENDE_IP_BRIEF: readonly string[] = [
  '*down: administratively down',
  '^down: standby',
  '(l): loopback',
  '(s): spoofing',
];

export function protocoleSpoofe(nom: string): boolean {
  return /^LoopBack/i.test(nom);
}

export function protocoleVrp(nom: string, proto: string): string {
  return proto === 'up' && protocoleSpoofe(nom) ? 'up(s)' : proto;
}

export function compteursIpBrief(lignes: readonly LigneIpBrief[]): string[] {
  const up = (v: string) => v.startsWith('up');
  const upPhys = lignes.filter((l) => up(l.physique)).length;
  const upProto = lignes.filter((l) => up(l.protocole)).length;
  return [
    `The number of interface that is UP in Physical is ${upPhys}`,
    `The number of interface that is DOWN in Physical is ${lignes.length - upPhys}`,
    `The number of interface that is UP in Protocol is ${upProto}`,
    `The number of interface that is DOWN in Protocol is ${lignes.length - upProto}`,
  ];
}

export function rendreIpInterfaceBrief(lignes: readonly LigneIpBrief[]): string {
  return [
    ...LEGENDE_IP_BRIEF,
    ...compteursIpBrief(lignes),
    '',
    ...renderTable(lignes, COLONNES_IP_BRIEF, VRP_TABLE),
  ].join('\n');
}

export interface LigneInterface {
  readonly nom: string;
  readonly physique: string;
  readonly protocole: string;
  readonly description: string;
}

export const COLONNES_INTERFACE_BRIEF: ReadonlyArray<TableColumn<LigneInterface>> = [
  { header: 'Interface', width: 28, value: (r) => r.nom },
  { header: 'PHY', width: 6, value: (r) => r.physique },
  { header: 'Protocol', width: 10, value: (r) => r.protocole },
  { header: 'InUti', width: 5, align: 'right', value: () => '0%' },
  { header: 'OutUti', width: 7, align: 'right', value: () => '0%' },
  { header: 'inErrors', width: 11, align: 'right', value: () => '0' },
  { header: 'outErrors', width: 11, align: 'right', value: () => '0' },
];

export const LEGENDE_INTERFACE_BRIEF = 'PHY: Physical   *down: administratively down';

export const COLONNES_INTERFACE_DESCRIPTION: ReadonlyArray<TableColumn<LigneInterface>> = [
  { header: 'Interface', width: 30, value: (r) => r.nom },
  { header: 'PHY', width: 8, value: (r) => r.physique },
  { header: 'Protocol', width: 9, value: (r) => r.protocole },
  { header: 'Description', value: (r) => r.description },
];

export function rendreInterfaceBrief(lignes: readonly LigneInterface[]): string {
  return [
    LEGENDE_INTERFACE_BRIEF,
    ...renderTable(lignes, COLONNES_INTERFACE_BRIEF, FIXED_TABLE),
  ].join('\n');
}

export function rendreInterfaceDescription(lignes: readonly LigneInterface[]): string {
  return renderTable(lignes, COLONNES_INTERFACE_DESCRIPTION, FIXED_TABLE).join('\n');
}

export function huaweiMacAddress(mac: { toString(): string } | string): string {
  const brut = String(mac).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (brut.length !== 12) return String(mac);
  return `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}`;
}

export interface LigneArp {
  readonly ip: string;
  readonly mac: string;
  readonly expire: string;
  readonly type: string;
  readonly iface: string;
}

export const COLONNES_ARP: ReadonlyArray<TableColumn<LigneArp>> = [
  { header: 'IP ADDRESS', width: 16, value: (r) => r.ip },
  { header: 'MAC ADDRESS', width: 16, value: (r) => r.mac },
  { header: 'EXPIRE(M)', width: 11, value: (r) => r.expire },
  { header: 'TYPE', width: 10, value: (r) => r.type },
  { header: 'INTERFACE', value: (r) => r.iface },
];

export const COLONNES_ARP_SWITCH: ReadonlyArray<TableColumn<LigneArp>> = [
  ...COLONNES_ARP.slice(0, 4),
  { header: 'INTERFACE', width: 13, value: (r) => r.iface },
  { header: 'VPN-INSTANCE', value: () => '' },
];

export function rendreArp(lignes: readonly LigneArp[], vide: string): string {
  if (lignes.length === 0) {
    return [renderTable([], COLONNES_ARP, FIXED_TABLE)[0], vide].join('\n');
  }
  return renderTable(lignes, COLONNES_ARP, FIXED_TABLE).join('\n');
}

export interface LigneMac {
  readonly mac: string;
  readonly vlan: string;
  readonly port: string;
  readonly type: string;
}

export const COLONNES_MAC: ReadonlyArray<TableColumn<LigneMac>> = [
  { header: 'MAC Address', width: 15, value: (r) => r.mac },
  { header: 'VLAN/VSI', width: 11, value: (r) => r.vlan },
  { header: 'Learned-From', width: 22, value: (r) => r.port },
  { header: 'Type', value: (r) => r.type },
];

export function rendreMacAddress(lignes: readonly LigneMac[]): string[] {
  return renderTable(lignes, COLONNES_MAC, FIXED_TABLE);
}

const FILET_ARP = '-'.repeat(78);

export function rendreArpSwitch(lignes: readonly LigneArp[]): string {
  const table = renderTable(lignes, COLONNES_ARP_SWITCH, FIXED_TABLE);
  const dyn = lignes.filter((l) => l.type === 'dynamic').length;
  return [
    table[0],
    '                                          VLAN/CEVLAN PVC',
    FILET_ARP,
    ...table.slice(1),
    FILET_ARP,
    `Total: ${lignes.length}        Dynamic: ${dyn}      Static: ${lignes.length - dyn}`,
  ].join('\n');
}

export interface LigneUsers {
  readonly courante: boolean;
  readonly interfaceUtilisateur: string;
  readonly nomLigne: string;
  readonly delai: string;
  readonly type: string;
  readonly adresse: string;
  readonly authentification: string;
  readonly autorisation: string;
}

export const COLONNES_USERS: ReadonlyArray<TableColumn<LigneUsers>> = [
  { header: '  User-Intf', width: 13, value: (r) => `${r.courante ? '+' : ' '} ${r.interfaceUtilisateur} ${r.nomLigne}` },
  { header: 'Delay', width: 9, value: (r) => r.delai },
  { header: 'Type', width: 7, value: (r) => r.type },
  { header: 'Network Address', width: 21, value: (r) => r.adresse },
  { header: 'AuthenStatus', width: 16, value: (r) => r.authentification },
  { header: 'AuthorcmdFlag', value: (r) => r.autorisation },
];

export function rendreDisplayUsers(lignes: readonly LigneUsers[], noms: readonly string[]): string {
  const table = renderTable(lignes, COLONNES_USERS, FIXED_TABLE);
  const sortie: string[] = [table[0]];
  table.slice(1).forEach((l, i) => {
    sortie.push(l.trimEnd());
    sortie.push(`  Username : ${noms[i] || 'Unspecified'}`);
  });
  sortie.push('');
  sortie.push('Wait     : Wait for the user to press ENTER.');
  return sortie.join('\n');
}
