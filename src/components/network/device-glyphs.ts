import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cloud, HardDrive, Laptop, Monitor, Router, Server, Shield, Wifi, type LucideIcon } from 'lucide-react';
import type { DeviceGlyph } from './device-visuals';

export const DEVICE_GLYPHS: Readonly<Record<DeviceGlyph, LucideIcon>> = {
  monitor: Monitor, laptop: Laptop, server: Server, router: Router, switch: HardDrive,
  shield: Shield, wifi: Wifi, cloud: Cloud, hub: HardDrive,
};

const SVG_BODY = /^<svg[^>]*>([\s\S]*)<\/svg>$/;

export function glyphSvgBody(glyph: DeviceGlyph): string {
  const markup = renderToStaticMarkup(createElement(DEVICE_GLYPHS[glyph]));
  return SVG_BODY.exec(markup)?.[1] ?? '';
}
