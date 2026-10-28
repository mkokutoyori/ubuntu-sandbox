import type { DeviceType } from '@/network';

export type Locale = 'en' | 'fr';

export const LOCALES: readonly Locale[] = ['en', 'fr'];

export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  fr: 'Français',
};

const EN = {
  'export.image.title': 'Export as image',
  'export.image.description': 'Save the topology as a picture to include in a report or an audit file.',
  'export.image.legend': 'Include the legend',
  'export.image.legendHint': 'Lists the equipment types and the link types used in this topology.',
  'export.image.format': 'Format',
  'export.image.formatPng': 'PNG (raster image)',
  'export.image.formatSvg': 'SVG (vector image)',
  'export.image.language': 'Language of the image',
  'export.image.preview': 'Preview',
  'export.image.empty': 'The topology is empty: add equipment before exporting an image.',
  'export.image.cancel': 'Cancel',
  'export.image.confirm': 'Export',
  'export.image.failed': 'Image export failed',
  'export.image.button': 'Image',
  'export.image.buttonTitle': 'Export the topology as an image',
  'legend.title': 'Legend',
  'legend.equipment': 'Equipment',
  'legend.links': 'Links',
  'legend.count': '{count} on the diagram',
  'legend.poweredOff': 'Powered off',
  'legend.linkDown': 'Link down',
  'link.ethernet': 'Ethernet cable',
  'link.serial': 'Serial cable',
  'link.console': 'Console cable',
  'link.fiber': 'Fibre cable',
  'diagram.generated': 'Generated on {date}',
  'diagram.summary': '{devices} devices, {links} links',
} as const;

export type MessageKey = keyof typeof EN;

const FR: Readonly<Record<MessageKey, string>> = {
  'export.image.title': 'Exporter en image',
  'export.image.description': 'Enregistre la topologie sous forme d\'image, pour un rapport ou un dossier d\'audit.',
  'export.image.legend': 'Inclure la légende',
  'export.image.legendHint': 'Liste les types d\'équipements et les types de liens utilisés dans cette topologie.',
  'export.image.format': 'Format',
  'export.image.formatPng': 'PNG (image matricielle)',
  'export.image.formatSvg': 'SVG (image vectorielle)',
  'export.image.language': 'Langue de l\'image',
  'export.image.preview': 'Aperçu',
  'export.image.empty': 'La topologie est vide : ajoutez des équipements avant d\'exporter une image.',
  'export.image.cancel': 'Annuler',
  'export.image.confirm': 'Exporter',
  'export.image.failed': 'Échec de l\'export de l\'image',
  'export.image.button': 'Image',
  'export.image.buttonTitle': 'Exporter la topologie en image',
  'legend.title': 'Légende',
  'legend.equipment': 'Équipements',
  'legend.links': 'Liens',
  'legend.count': '{count} sur le schéma',
  'legend.poweredOff': 'Hors tension',
  'legend.linkDown': 'Lien coupé',
  'link.ethernet': 'Câble Ethernet',
  'link.serial': 'Câble série',
  'link.console': 'Câble console',
  'link.fiber': 'Câble fibre',
  'diagram.generated': 'Généré le {date}',
  'diagram.summary': '{devices} équipements, {links} liens',
};

export const MESSAGES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = {
  en: EN,
  fr: FR,
};

export const FRENCH_DEVICE_LABELS: Readonly<Record<DeviceType, string>> = {
  'linux-pc': 'PC Linux',
  'windows-pc': 'PC Windows',
  'mac-pc': 'Mac',
  'linux-server': 'Serveur Linux',
  'windows-server': 'Serveur Windows',
  'switch-cisco': 'Commutateur Cisco',
  'switch-huawei': 'Commutateur Huawei',
  'switch-generic': 'Commutateur générique',
  'router-cisco': 'Routeur Cisco',
  'router-huawei': 'Routeur Huawei',
  'firewall-generic': 'Pare-feu générique',
  'firewall-cisco': 'Cisco ASA',
  'firewall-fortinet': 'FortiGate',
  'firewall-paloalto': 'Palo Alto',
  'hub': 'Concentrateur (hub)',
  'access-point': 'Point d\'accès Wi-Fi',
  'cloud': 'Nuage (réseau externe)',
};
