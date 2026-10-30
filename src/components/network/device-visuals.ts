import type { DeviceType } from '@/network';

export type DeviceGlyph =
  'monitor' | 'laptop' | 'server' | 'router' | 'switch' | 'shield' | 'wifi' | 'cloud' | 'hub';

export interface DeviceVisual {
  readonly glyph: DeviceGlyph;
  readonly glyphColor?: string;
  readonly badge?: { readonly text: string; readonly color: string; readonly fontSize: number };
}

const ORANGE = '#f97316';
const BLUE = '#3b82f6';
const CYAN = '#22d3ee';
const CYAN_DARK = '#0891b2';
const RED = '#f87171';
const RED_DARK = '#dc2626';

export const DEVICE_VISUALS: Readonly<Record<DeviceType, DeviceVisual>> = {
  'linux-pc': { glyph: 'monitor', badge: { text: 'L', color: ORANGE, fontSize: 8 } },
  'windows-pc': { glyph: 'monitor', badge: { text: 'W', color: BLUE, fontSize: 8 } },
  'mac-pc': { glyph: 'laptop', badge: { text: 'M', color: '#1f2937', fontSize: 8 } },
  'linux-server': { glyph: 'server', badge: { text: 'L', color: ORANGE, fontSize: 8 } },
  'windows-server': { glyph: 'server', badge: { text: 'W', color: BLUE, fontSize: 8 } },
  'router-cisco': {
    glyph: 'router', glyphColor: CYAN, badge: { text: 'C', color: CYAN_DARK, fontSize: 5 },
  },
  'router-huawei': {
    glyph: 'router', glyphColor: RED, badge: { text: 'H', color: RED_DARK, fontSize: 5 },
  },
  'switch-cisco': {
    glyph: 'switch', glyphColor: CYAN, badge: { text: 'C', color: CYAN_DARK, fontSize: 5 },
  },
  'switch-huawei': {
    glyph: 'switch', glyphColor: RED, badge: { text: 'H', color: RED_DARK, fontSize: 5 },
  },
  'switch-generic': { glyph: 'switch' },
  'hub': { glyph: 'hub' },
  'firewall-generic': { glyph: 'shield' },
  'firewall-fortinet': {
    glyph: 'shield', glyphColor: '#ef4444', badge: { text: 'FG', color: '#b91c1c', fontSize: 5 },
  },
  'firewall-cisco': {
    glyph: 'shield', glyphColor: CYAN, badge: { text: 'ASA', color: CYAN_DARK, fontSize: 5 },
  },
  'firewall-paloalto': {
    glyph: 'shield', glyphColor: '#fb923c', badge: { text: 'PA', color: '#ea580c', fontSize: 5 },
  },
  'access-point': { glyph: 'wifi', glyphColor: '#4ade80' },
  'cloud': { glyph: 'cloud', glyphColor: '#38bdf8' },
};
