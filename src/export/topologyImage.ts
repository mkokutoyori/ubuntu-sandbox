import { DEVICE_CATALOG } from '@/network';
import type { ConnectionType, DeviceType } from '@/network';
import { deviceTypeLabel, translate, type Locale } from '@/i18n';
import { DEVICE_VISUALS, type DeviceGlyph, type DeviceVisual } from '@/components/network/device-visuals';
import {
  computeCableRoutes, computeEndpointAnchors, connectorSegment, getLinkAppearance,
  interfaceTagWidth, shouldShowPortLabels, DEVICE_BADGE_BOTTOM, DEVICE_BADGE_TOP,
  NODE_CENTER_OFFSET_Y, NODE_HALF_HEIGHT, NODE_HALF_WIDTH, TAG_HEIGHT,
  type CableRoute, type LabelPlacement, type RoutedLink,
} from '@/components/network/connection-line-logic';

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
  readonly sourceInterface: string;
  readonly targetInterface: string;
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

const NODE_SIZE = NODE_HALF_WIDTH * 2;
const NODE_RADIUS = 12;
const LABEL_FONT_SIZE = 12;
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
        sourceInterface: connection.sourceInterfaceId,
        targetInterface: connection.targetInterfaceId,
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

interface Box { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

const LABEL_PILL_HEIGHT = DEVICE_BADGE_BOTTOM - DEVICE_BADGE_TOP + 2;
const LABEL_PILL_PADDING = 8;
const TAG_FILL = 'rgba(2,6,23,0.92)';
const CABLE_CASING = '#ffffff';
const POWER_ON = '#22c55e';
const POWER_OFF = '#64748b';

function cardCentre(device: TopologyImageDevice): { x: number; y: number } {
  return { x: device.x, y: device.y + NODE_CENTER_OFFSET_Y };
}

function deviceBox(device: TopologyImageDevice): Box {
  const centre = cardCentre(device);
  const half = Math.max(NODE_HALF_WIDTH,
    (textWidth(device.name, LABEL_FONT_SIZE) + 2 * LABEL_PILL_PADDING) / 2);
  return {
    left: centre.x - half, right: centre.x + half,
    top: centre.y - NODE_HALF_HEIGHT, bottom: centre.y + DEVICE_BADGE_BOTTOM + 1,
  };
}

function tagBox(placement: LabelPlacement): Box {
  const length = interfaceTagWidth(placement.text) / 2;
  const thickness = TAG_HEIGHT / 2;
  const halfWidth = placement.vertical ? thickness : length;
  const halfHeight = placement.vertical ? length : thickness;
  return {
    left: placement.at.x - halfWidth, right: placement.at.x + halfWidth,
    top: placement.at.y - halfHeight, bottom: placement.at.y + halfHeight,
  };
}

function routeBox(route: CableRoute): Box[] {
  const xs = route.points.map((point) => point.x);
  const ys = route.points.map((point) => point.y);
  const shown = [route.sourceLabel, route.targetLabel].filter((label) => label.shown).map(tagBox);
  return [{ left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }, ...shown];
}

function portTagMarkup(placement: LabelPlacement, color: string): string {
  const width = interfaceTagWidth(placement.text);
  const { x, y } = placement.at;
  const upright = placement.vertical ? ` transform="rotate(90 ${x} ${y})"` : '';
  return `<g data-port-label=""${upright}>`
    + `<rect x="${x - width / 2}" y="${y - TAG_HEIGHT / 2}" width="${width}" height="${TAG_HEIGHT}" `
    + `rx="${TAG_HEIGHT / 2}" fill="${TAG_FILL}" stroke="${color}" stroke-width="1.1"/>`
    + `<text x="${x}" y="${y + 3}" font-size="9" font-weight="600" font-family="monospace" `
    + `fill="${color}" text-anchor="middle">${escapeXml(placement.text)}</text></g>`;
}

function cableMarkup(link: TopologyImageLink, route: CableRoute): string {
  const { color, dash } = getLinkAppearance(link.type, link.operational);
  const anchors = computeEndpointAnchors(route.points);
  const connector = (anchor: typeof anchors.source): string => {
    const { a, b } = connectorSegment(anchor);
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${CABLE_CASING}" stroke-width="6" `
      + `stroke-linecap="round"/><line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" `
      + `stroke-width="3" stroke-linecap="round"/>`;
  };
  return `<g data-link="${escapeXml(link.id)}" data-link-state="${link.operational ? 'up' : 'down'}">`
    + `<path d="${route.path}" fill="none" stroke="${CABLE_CASING}" stroke-width="5" stroke-linecap="round" `
    + `stroke-linejoin="round"/>`
    + `<path d="${route.path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" `
    + `stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
    + connector(anchors.source) + connector(anchors.target) + '</g>';
}

function nodeMarkup(device: TopologyImageDevice): string {
  const centre = cardCentre(device);
  const left = centre.x - NODE_HALF_WIDTH;
  const top = centre.y - NODE_HALF_HEIGHT;
  const pillWidth = Math.max(NODE_SIZE, textWidth(device.name, LABEL_FONT_SIZE) + 2 * LABEL_PILL_PADDING);
  const pillTop = centre.y + DEVICE_BADGE_TOP - 1;
  return `<g>${nodeSwatch(device.type, left, top, NODE_SIZE, device.isPoweredOn)}`
    + `<circle cx="${left + NODE_SIZE - 1}" cy="${top + 1}" r="5" fill="${device.isPoweredOn ? POWER_ON : POWER_OFF}" `
    + `stroke="#ffffff" stroke-width="1.5"/>`
    + `<rect x="${centre.x - pillWidth / 2}" y="${pillTop}" width="${pillWidth}" height="${LABEL_PILL_HEIGHT}" `
    + `rx="5" fill="${TAG_FILL}"/>`
    + `<text x="${centre.x}" y="${pillTop + LABEL_PILL_HEIGHT / 2 + 4.2}" font-size="${LABEL_FONT_SIZE}" `
    + `fill="#ffffff" text-anchor="middle">${escapeXml(device.name)}</text></g>`;
}

export function renderTopologySvg(
  model: TopologyImageModel, options: TopologyImageOptions,
): RenderedTopologyImage {
  const { locale } = options;
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);

  const byId = new Map(model.devices.map((device) => [device.id, device] as const));
  const routedLinks: RoutedLink[] = model.links.flatMap((link) => {
    const source = byId.get(link.sourceId);
    const target = byId.get(link.targetId);
    if (!source || !target) return [];
    return [{
      id: link.id, sourceDeviceId: source.id, targetDeviceId: target.id,
      source: { x: source.x, y: source.y }, target: { x: target.x, y: target.y },
      sourceInterface: link.sourceInterface, targetInterface: link.targetInterface,
    }];
  });
  const routes = computeCableRoutes(
    routedLinks, model.devices.map((device) => ({ x: device.x, y: device.y })), 1);
  const labelsShown = shouldShowPortLabels(1);

  const boxes: Box[] = [
    ...model.devices.map(deviceBox),
    ...[...routes.values()].flatMap(routeBox),
  ];
  const minX = boxes.length ? Math.min(...boxes.map((box) => box.left)) : 0;
  const minY = boxes.length ? Math.min(...boxes.map((box) => box.top)) : 0;
  const maxX = boxes.length ? Math.max(...boxes.map((box) => box.right)) : 0;
  const maxY = boxes.length ? Math.max(...boxes.map((box) => box.bottom)) : 0;

  const diagramWidth = maxX - minX + 2 * MARGIN;
  const diagramHeight = maxY - minY + TOP_GAP + MARGIN;
  const offsetX = MARGIN - minX;
  const offsetY = HEADER_HEIGHT + TOP_GAP - minY;

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

  const cables = model.links.map((link) => {
    const route = routes.get(link.id);
    return route ? cableMarkup(link, route) : '';
  }).join('');
  const tags = model.links.map((link) => {
    const route = routes.get(link.id);
    if (!route || !labelsShown) return '';
    const { color } = getLinkAppearance(link.type, link.operational);
    return [route.sourceLabel, route.targetLabel]
      .filter((placement) => placement.shown)
      .map((placement) => portTagMarkup(placement, color)).join('');
  }).join('');
  const nodes = model.devices.map(nodeMarkup).join('');

  const legendMarkup = legend ? legend.markup(MARGIN, legendTop) : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}">`
    + `<rect width="${width}" height="${height}" fill="${BACKGROUND}"/>`
    + `<text x="${MARGIN}" y="34" font-size="13" fill="${MUTED}">${escapeXml(headerText)}</text>`
    + `<g transform="translate(${offsetX} ${offsetY})"><g>${cables}</g>${nodes}<g>${tags}</g></g>`
    + `${legendMarkup}</svg>`;
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
