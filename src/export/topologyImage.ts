import { DEVICE_CATALOG } from '@/network';
import type { ConnectionType, DeviceType } from '@/network';
import { deviceTypeLabel, translate, type Locale } from '@/i18n';
import { DEVICE_VISUALS, type DeviceGlyph, type DeviceVisual } from '@/components/network/device-visuals';
import { getLinkAppearance } from '@/components/network/connection-line-logic';

export interface TopologyImageDevice {
  readonly id: string;
  readonly name: string;
  readonly type: DeviceType;
  readonly x: number;
  readonly y: number;
  readonly isPoweredOn: boolean;
}

export interface TopologyImageLink {
  readonly id: string;
  readonly type: ConnectionType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly operational: boolean;
}

export interface TopologyImageModel {
  readonly title: string;
  readonly devices: readonly TopologyImageDevice[];
  readonly links: readonly TopologyImageLink[];
}

export interface TopologyImageOptions {
  readonly locale: Locale;
  readonly legend: boolean;
  readonly generatedAt?: Date;
}

export interface RenderedTopologyImage {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

interface SourceDevice {
  id: string; name: string; type: DeviceType; x: number; y: number; isPoweredOn: boolean;
  interfaces: ReadonlyArray<{ id: string; isOperational?: boolean }>;
}

interface SourceConnection {
  id: string; type: ConnectionType;
  sourceDeviceId: string; sourceInterfaceId: string;
  targetDeviceId: string; targetInterfaceId: string;
}

const NODE_SIZE = 64;
const NODE_RADIUS = 12;
const LABEL_FONT_SIZE = 12;
const LABEL_GAP = 6;
const MARGIN = 56;
const HEADER_HEIGHT = 52;
const TOP_GAP = 24;
const GLYPH_SIZE = 36;
const LEGEND_PADDING = 18;
const LEGEND_ROW_HEIGHT = 34;
const LEGEND_SWATCH = 28;
const LEGEND_GAP = 16;
const LEGEND_FONT_SIZE = 13;
const CHARACTER_WIDTH_RATIO = 0.6;
const FONT_FAMILY = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const BACKGROUND = '#ffffff';
const INK = '#0f172a';
const MUTED = '#475569';
const NODE_FILL = '#e2e8f0';
const NODE_STROKE = '#94a3b8';
const PANEL_FILL = '#f8fafc';
const PANEL_STROKE = '#cbd5e1';
const DEFAULT_GLYPH_COLOR = '#334155';
const POWERED_OFF_OPACITY = 0.45;
const CONNECTION_TYPES: readonly ConnectionType[] = ['ethernet', 'fiber', 'serial', 'console'];

const GLYPH_PATHS: Readonly<Record<DeviceGlyph, string>> = {
  monitor: '<rect x="2.5" y="4" width="19" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1.2"/><path d="M2.5 19h19"/>',
  server: '<rect x="3" y="3.5" width="18" height="7" rx="1.5"/><rect x="3" y="13.5" width="18" height="7" rx="1.5"/>'
    + '<path d="M7 7h.01M7 17h.01"/>',
  router: '<circle cx="12" cy="12" r="8.5"/><path d="M12 6v12M6 12h12M9.5 8.5 12 6l2.5 2.5M9.5 15.5 12 18l2.5-2.5'
    + 'M8.5 9.5 6 12l2.5 2.5M15.5 9.5 18 12l-2.5 2.5"/>',
  switch: '<rect x="2.5" y="7" width="19" height="10" rx="1.5"/><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01"/>',
  hub: '<rect x="2.5" y="8" width="19" height="8" rx="1.5"/><circle cx="7" cy="12" r="1"/><circle cx="12" cy="12" r="1"/>'
    + '<circle cx="17" cy="12" r="1"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6z"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0"/>'
    + '<path d="M12 19.5h.01"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.2 4.2 0 0 1-.5 8.5z"/>',
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] as string);
}

const textWidth = (text: string, fontSize: number): number =>
  Math.ceil(text.length * fontSize * CHARACTER_WIDTH_RATIO);

export function buildTopologyImageModel(
  title: string,
  devices: readonly SourceDevice[],
  connections: readonly SourceConnection[],
): TopologyImageModel {
  const known = new Map(devices.map((device) => [device.id, device] as const));
  const operational = (device: SourceDevice, interfaceId: string): boolean =>
    device.interfaces.find((item) => item.id === interfaceId)?.isOperational ?? true;
  return {
    title,
    devices: devices.map(({ id, name, type, x, y, isPoweredOn }) => ({ id, name, type, x, y, isPoweredOn })),
    links: connections.flatMap((connection): TopologyImageLink[] => {
      const source = known.get(connection.sourceDeviceId);
      const target = known.get(connection.targetDeviceId);
      if (!source || !target) return [];
      return [{
        id: connection.id, type: connection.type,
        sourceId: source.id, targetId: target.id,
        operational: operational(source, connection.sourceInterfaceId)
          && operational(target, connection.targetInterfaceId),
      }];
    }),
  };
}

function glyphMarkup(
  visual: DeviceVisual, centerX: number, centerY: number, size: number, ink: string,
): string {
  const scale = size / 24;
  const color = visual.glyphColor ?? ink;
  return `<g transform="translate(${centerX - size / 2} ${centerY - size / 2}) scale(${scale})" `
    + `fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`
    + `${GLYPH_PATHS[visual.glyph]}</g>`;
}

function badgeMarkup(visual: DeviceVisual, right: number, bottom: number, scale: number): string {
  if (!visual.badge) return '';
  const { text, color } = visual.badge;
  const fontSize = 10 * scale;
  const width = textWidth(text, fontSize) + 8 * scale;
  const height = 14 * scale;
  return `<rect x="${right - width}" y="${bottom - height}" width="${width}" height="${height}" rx="3" fill="${color}"/>`
    + `<text x="${right - width / 2}" y="${bottom - 3.5 * scale}" font-size="${fontSize}" font-weight="700" `
    + `fill="#ffffff" text-anchor="middle">${escapeXml(text)}</text>`;
}

function nodeSwatch(
  type: DeviceType, left: number, top: number, size: number, poweredOn: boolean,
): string {
  const visual = DEVICE_VISUALS[type];
  const opacity = poweredOn ? 1 : POWERED_OFF_OPACITY;
  const glyphSize = size * (GLYPH_SIZE / NODE_SIZE);
  return `<g opacity="${opacity}">`
    + `<rect x="${left}" y="${top}" width="${size}" height="${size}" rx="${size * NODE_RADIUS / NODE_SIZE}" `
    + `fill="${NODE_FILL}" stroke="${NODE_STROKE}" stroke-width="1.2"/>`
    + glyphMarkup(visual, left + size / 2, top + size / 2, glyphSize, DEFAULT_GLYPH_COLOR)
    + badgeMarkup(visual, left + size - 3, top + size - 3, Math.max(0.65, size / NODE_SIZE))
    + '</g>';
}

interface LegendLayout {
  readonly markup: (left: number, top: number) => string;
  readonly width: number;
  readonly height: number;
}

function buildLegend(model: TopologyImageModel, locale: Locale): LegendLayout {
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);

  const counts = new Map<DeviceType, number>();
  for (const device of model.devices) counts.set(device.type, (counts.get(device.type) ?? 0) + 1);
  const orderedTypes = (Object.keys(DEVICE_CATALOG) as DeviceType[]).filter((type) => counts.has(type));
  const anyOff = model.devices.some((device) => !device.isPoweredOn);

  const linkTypes = CONNECTION_TYPES.filter(
    (type) => model.links.some((link) => link.type === type && link.operational));
  const anyDown = model.links.some((link) => !link.operational);

  interface Row { readonly draw: (left: number, top: number) => string; readonly label: string }
  const equipmentRows: Row[] = orderedTypes.map((type) => ({
    label: `${deviceTypeLabel(type, locale)} — ${t('legend.count', { count: counts.get(type) ?? 0 })}`,
    draw: (left, top) => nodeSwatch(type, left, top, LEGEND_SWATCH, true),
  }));
  if (anyOff) {
    const sample = orderedTypes[0] ?? 'linux-pc';
    equipmentRows.push({
      label: t('legend.poweredOff'),
      draw: (left, top) => nodeSwatch(sample, left, top, LEGEND_SWATCH, false),
    });
  }
  const lineSample = (color: string, dash: string) => (left: number, top: number): string =>
    `<line x1="${left}" y1="${top + LEGEND_SWATCH / 2}" x2="${left + LEGEND_SWATCH}" `
    + `y2="${top + LEGEND_SWATCH / 2}" stroke="${color}" stroke-width="3" stroke-linecap="round"`
    + `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const linkRows: Row[] = linkTypes.map((type) => {
    const { color, dash } = getLinkAppearance(type, true);
    return { label: t(`link.${type}` as const), draw: lineSample(color, dash) };
  });
  if (anyDown) {
    const { color, dash } = getLinkAppearance('ethernet', false);
    linkRows.push({ label: t('legend.linkDown'), draw: lineSample(color, dash) });
  }

  const sections = [
    { title: t('legend.equipment'), rows: equipmentRows },
    { title: t('legend.links'), rows: linkRows },
  ].filter((section) => section.rows.length > 0);

  const titleHeight = 30;
  const sectionTitleHeight = 24;
  const rowsWidth = Math.max(0, ...sections.flatMap((section) => [
    textWidth(section.title, LEGEND_FONT_SIZE),
    ...section.rows.map((row) => LEGEND_SWATCH + LEGEND_GAP + textWidth(row.label, LEGEND_FONT_SIZE)),
  ]));
  const width = Math.max(rowsWidth, textWidth(t('legend.title'), LEGEND_FONT_SIZE + 3)) + 2 * LEGEND_PADDING;
  const height = 2 * LEGEND_PADDING + titleHeight
    + sections.reduce((sum, section) => sum + sectionTitleHeight + section.rows.length * LEGEND_ROW_HEIGHT, 0);

  return {
    width, height,
    markup: (left, top) => {
      let y = top + LEGEND_PADDING;
      const parts: string[] = [
        `<g role="group" aria-label="${escapeXml(t('legend.title'))}">`,
        `<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="10" fill="${PANEL_FILL}" `
        + `stroke="${PANEL_STROKE}" stroke-width="1.2"/>`,
        `<text x="${left + LEGEND_PADDING}" y="${y + 16}" font-size="${LEGEND_FONT_SIZE + 3}" font-weight="700" `
        + `fill="${INK}">${escapeXml(t('legend.title'))}</text>`,
      ];
      y += titleHeight;
      for (const section of sections) {
        parts.push(`<text x="${left + LEGEND_PADDING}" y="${y + 14}" font-size="${LEGEND_FONT_SIZE}" `
          + `font-weight="700" fill="${MUTED}">${escapeXml(section.title)}</text>`);
        y += sectionTitleHeight;
        for (const row of section.rows) {
          parts.push(row.draw(left + LEGEND_PADDING, y));
          parts.push(`<text x="${left + LEGEND_PADDING + LEGEND_SWATCH + LEGEND_GAP}" `
            + `y="${y + LEGEND_SWATCH / 2 + 4.5}" font-size="${LEGEND_FONT_SIZE}" fill="${INK}">`
            + `${escapeXml(row.label)}</text>`);
          y += LEGEND_ROW_HEIGHT;
        }
      }
      parts.push('</g>');
      return parts.join('');
    },
  };
}

export function renderTopologySvg(
  model: TopologyImageModel, options: TopologyImageOptions,
): RenderedTopologyImage {
  const { locale } = options;
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);

  const xs = model.devices.map((device) => device.x);
  const ys = model.devices.map((device) => device.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  const maxY = ys.length ? Math.max(...ys) : 0;
  const labelWidths = model.devices.map((device) => textWidth(device.name, LABEL_FONT_SIZE));
  const widestLabel = labelWidths.length ? Math.max(...labelWidths) : 0;
  const halfNode = Math.max(NODE_SIZE, widestLabel) / 2;

  const diagramWidth = maxX - minX + 2 * halfNode + 2 * MARGIN;
  const diagramHeight = maxY - minY + NODE_SIZE + LABEL_GAP + LABEL_FONT_SIZE + TOP_GAP + MARGIN;
  const offsetX = MARGIN + halfNode - minX;
  const offsetY = HEADER_HEIGHT + TOP_GAP + NODE_SIZE / 2 - minY;

  const legend = options.legend ? buildLegend(model, locale) : null;
  const title = model.title || '';
  const summary = t('diagram.summary', { devices: model.devices.length, links: model.links.length });
  const generated = t('diagram.generated', {
    date: (options.generatedAt ?? new Date()).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB'),
  });
  const headerText = [title, summary, generated].filter(Boolean).join('  ·  ');

  const width = Math.ceil(Math.max(
    diagramWidth, legend ? legend.width + 2 * MARGIN : 0, textWidth(headerText, 13) + 2 * MARGIN));
  const legendTop = HEADER_HEIGHT + diagramHeight;
  const height = Math.ceil(legend ? legendTop + legend.height + MARGIN : HEADER_HEIGHT + diagramHeight);

  const byId = new Map(model.devices.map((device) => [device.id, device] as const));
  const links = model.links.map((link) => {
    const source = byId.get(link.sourceId);
    const target = byId.get(link.targetId);
    if (!source || !target) return '';
    const { color, dash } = getLinkAppearance(link.type, link.operational);
    return `<line x1="${source.x + offsetX}" y1="${source.y + offsetY}" x2="${target.x + offsetX}" `
      + `y2="${target.y + offsetY}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"`
      + `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  }).join('');

  const nodes = model.devices.map((device) => {
    const cx = device.x + offsetX;
    const cy = device.y + offsetY;
    return `<g>${nodeSwatch(device.type, cx - NODE_SIZE / 2, cy - NODE_SIZE / 2, NODE_SIZE, device.isPoweredOn)}`
      + `<text x="${cx}" y="${cy + NODE_SIZE / 2 + LABEL_GAP + LABEL_FONT_SIZE}" font-size="${LABEL_FONT_SIZE}" `
      + `fill="${INK}" text-anchor="middle">${escapeXml(device.name)}</text></g>`;
  }).join('');

  const legendMarkup = legend ? legend.markup(MARGIN, legendTop) : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}">`
    + `<rect width="${width}" height="${height}" fill="${BACKGROUND}"/>`
    + `<text x="${MARGIN}" y="34" font-size="13" fill="${MUTED}">${escapeXml(headerText)}</text>`
    + `<g>${links}</g>${nodes}${legendMarkup}</svg>`;
  return { svg, width, height };
}

const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_PIXELS = 100_000_000;

export function pngScaleFor(width: number, height: number, wanted: number): number {
  const bySide = MAX_CANVAS_SIDE / Math.max(width, height);
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
  return Math.max(0.25, Math.min(wanted, bySide, byArea));
}

export async function svgToPngBlob(
  image: RenderedTopologyImage, wantedScale = 2,
): Promise<Blob> {
  const scale = pngScaleFor(image.width, image.height, wantedScale);
  const url = URL.createObjectURL(new Blob([image.svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const picture = new Image();
    picture.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      picture.onload = () => resolve();
      picture.onerror = () => reject(new Error('The SVG could not be rasterised'));
      picture.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas context');
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function svgToBlob(image: RenderedTopologyImage): Blob {
  return new Blob([image.svg], { type: 'image/svg+xml;charset=utf-8' });
}
