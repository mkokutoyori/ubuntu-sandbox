/*
 * Export of a topology as an image: the SVG the PNG is rasterised from.
 *
 * What is pinned: the legend is the user's choice (absent when not asked,
 * present when asked), it names exactly the equipment and link types the
 * topology uses and nothing else, in the language chosen for the image, the
 * picture frames every device even at negative coordinates, device names
 * cannot break the markup, and a down link or a powered-off device shows up
 * in the legend. The witnesses prove the lab is sound: the same topology
 * renders its devices with and without the legend.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTopologyImageModel, renderTopologySvg, pngScaleFor, escapeXml,
  type TopologyImageModel,
} from '@/export/topologyImage';

const MODEL: TopologyImageModel = {
  title: 'Agence Douala',
  devices: [
    { id: 'r1', name: 'R-EDGE', type: 'router-cisco', x: 200, y: 120, isPoweredOn: true },
    { id: 's1', name: 'SW-CORE', type: 'switch-huawei', x: 200, y: 300, isPoweredOn: true },
    { id: 'p1', name: 'PC-1', type: 'windows-pc', x: 80, y: 460, isPoweredOn: true },
    { id: 'p2', name: 'PC-2', type: 'windows-pc', x: 320, y: 460, isPoweredOn: false },
  ],
  links: [
    { id: 'l1', type: 'ethernet', sourceId: 'r1', targetId: 's1', operational: true,
      sourceInterface: 'GigabitEthernet0/0', targetInterface: 'GigabitEthernet0/1' },
    { id: 'l2', type: 'serial', sourceId: 's1', targetId: 'p1', operational: true,
      sourceInterface: 'Serial0/0', targetInterface: 'eth0' },
    { id: 'l3', type: 'ethernet', sourceId: 's1', targetId: 'p2', operational: false,
      sourceInterface: 'GigabitEthernet0/2', targetInterface: 'eth0' },
  ],
};

const render = (legend: boolean, locale: 'en' | 'fr' = 'en', model = MODEL) =>
  renderTopologySvg(model, { locale, legend, generatedAt: new Date('2026-03-04T10:00:00Z') });

describe('the legend is the user\'s choice', () => {
  it('witness: every device is drawn with and without the legend', () => {
    for (const legend of [true, false]) {
      const { svg } = render(legend);
      for (const name of ['R-EDGE', 'SW-CORE', 'PC-1', 'PC-2']) expect(svg).toContain(`>${name}<`);
    }
  });

  it('omits the legend when it is not asked for', () => {
    const { svg } = render(false);
    expect(svg).not.toContain('Legend');
    expect(svg).not.toContain('role="group"');
    expect(svg).not.toContain('Cisco Router');
  });

  it('includes it when asked for', () => {
    const { svg } = render(true);
    expect(svg).toContain('role="group"');
    expect(svg).toContain('>Legend<');
  });

  it('is taller with the legend than without it', () => {
    expect(render(true).height).toBeGreaterThan(render(false).height);
  });
});

describe('the legend names what the topology uses', () => {
  it('lists the equipment types present, with their counts', () => {
    const { svg } = render(true);
    expect(svg).toContain('Cisco Router — 1 on the diagram');
    expect(svg).toContain('Huawei Switch — 1 on the diagram');
    expect(svg).toContain('Windows PC — 2 on the diagram');
  });

  it('does not list a type the topology does not use', () => {
    const { svg } = render(true);
    for (const absent of ['Linux Server', 'FortiGate', 'Hub', 'Access Point', 'Cloud', 'Huawei Router']) {
      expect(svg, absent).not.toContain(absent);
    }
  });

  it('lists the link types present, and the down link and powered-off device', () => {
    const { svg } = render(true);
    expect(svg).toContain('Ethernet cable');
    expect(svg).toContain('Serial cable');
    expect(svg).not.toContain('Console cable');
    expect(svg).toContain('Link down');
    expect(svg).toContain('Powered off');
  });

  it('shows no down-link entry when every link carries', () => {
    const allUp = { ...MODEL, links: MODEL.links.map((link) => ({ ...link, operational: true })) };
    expect(render(true, 'en', allUp).svg).not.toContain('Link down');
  });
});

describe('the image speaks the language chosen for it', () => {
  it('French', () => {
    const { svg } = render(true, 'fr');
    for (const text of ['Légende', 'Équipements', 'Liens', 'Routeur Cisco — 1 sur le schéma',
      'Commutateur Huawei', 'PC Windows — 2 sur le schéma', 'Câble série', 'Lien coupé', 'Hors tension']) {
      expect(svg, text).toContain(text);
    }
    expect(svg).not.toContain('>Legend<');
  });

  it('English', () => {
    expect(render(true, 'en').svg).not.toContain('Légende');
  });
});

describe('the picture frames the diagram', () => {
  it('keeps every device inside the canvas, even at negative coordinates', () => {
    const shifted = {
      ...MODEL,
      devices: MODEL.devices.map((device) => ({ ...device, x: device.x - 900, y: device.y - 700 })),
    };
    const { svg, width, height } = render(true, 'en', shifted);
    const [, shiftX, shiftY] = /<g transform="translate\((-?[\d.]+) (-?[\d.]+)\)">/.exec(svg) ?? [];
    const centres = [...svg.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)" font-size="12"/g)];
    expect(centres.length).toBe(4);
    for (const [, x, y] of centres) {
      expect(Number(x) + Number(shiftX)).toBeGreaterThan(0);
      expect(Number(x) + Number(shiftX)).toBeLessThan(width);
      expect(Number(y) + Number(shiftY)).toBeGreaterThan(0);
      expect(Number(y) + Number(shiftY)).toBeLessThan(height);
    }
  });

  it('renders an empty topology without failing', () => {
    const { svg } = render(true, 'en', { title: '', devices: [], links: [] });
    expect(svg.startsWith('<svg')).toBe(true);
  });
});

describe('device names cannot break the markup', () => {
  it('escapes them', () => {
    const hostile = {
      ...MODEL,
      devices: [{ ...MODEL.devices[0], name: '<script>alert("x")</script>&' }],
      links: [],
    };
    const { svg } = render(false, 'en', hostile);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;');
    expect(escapeXml("a&b<c>'\"")).toBe('a&amp;b&lt;c&gt;&apos;&quot;');
  });
});

describe('the model built from the store', () => {
  it('marks a link down as soon as one end has no carrier, and drops dangling links', () => {
    const model = buildTopologyImageModel('T',
      [
        { id: 'a', name: 'A', type: 'hub', x: 0, y: 0, isPoweredOn: true,
          interfaces: [{ id: 'eth0', isOperational: true }] },
        { id: 'b', name: 'B', type: 'hub', x: 10, y: 0, isPoweredOn: true,
          interfaces: [{ id: 'eth0', isOperational: false }] },
      ],
      [
        { id: 'c1', type: 'ethernet', sourceDeviceId: 'a', sourceInterfaceId: 'eth0',
          targetDeviceId: 'b', targetInterfaceId: 'eth0' },
        { id: 'c2', type: 'ethernet', sourceDeviceId: 'a', sourceInterfaceId: 'eth0',
          targetDeviceId: 'gone', targetInterfaceId: 'eth0' },
      ]);
    expect(model.links).toHaveLength(1);
    expect(model.links[0].operational).toBe(false);
  });
});

describe('rasterisation is bounded', () => {
  it('keeps the requested scale for a normal diagram and shrinks a huge one', () => {
    expect(pngScaleFor(1200, 800, 2)).toBe(2);
    const huge = pngScaleFor(40000, 30000, 2);
    expect(huge).toBeLessThan(1);
    expect(40000 * huge).toBeLessThanOrEqual(16384);
  });
});


describe('the cables follow the browser canvas', () => {
  it('witness: every link is drawn, with its up or down state', () => {
    const { svg } = render(false);
    expect(svg.match(/data-link="/g)).toHaveLength(3);
    expect(svg.match(/data-link-state="up"/g)).toHaveLength(2);
    expect(svg.match(/data-link-state="down"/g)).toHaveLength(1);
  });

  it('routes cables as the canvas does: right-angle paths, not straight lines', () => {
    const { svg } = render(false);
    expect(svg).not.toMatch(/<line [^>]*stroke-width="2.5"/);
    const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#(?!ffffff)/g)];
    expect(paths.length).toBe(3);
    for (const [, d] of paths) expect(d).toMatch(/^M /);
  });

  it('names the ports at both ends with the canvas abbreviations', () => {
    const { svg } = render(false);
    for (const text of ['Gi0/0', 'Gi0/1', 'Gi0/2', 'Se0/0']) expect(svg, text).toContain(`>${text}<`);
    expect(svg).not.toContain('>GigabitEthernet0/0<');
  });

  it('draws connector ticks where a cable meets a device', () => {
    const { svg } = render(false);
    expect(svg.match(/stroke-width="3" stroke-linecap="round"\/>/g)?.length).toBe(6);
  });

  it('marks power state on each device', () => {
    const { svg } = render(false);
    expect(svg.match(/fill="#22c55e"/g)).toHaveLength(3);
    expect(svg.match(/fill="#64748b"/g)).toHaveLength(1);
  });

  it('keeps two cables between the same devices on separate lanes', () => {
    const doubled = {
      ...MODEL,
      links: [
        MODEL.links[0],
        { ...MODEL.links[0], id: 'l1b', sourceInterface: 'GigabitEthernet0/3', targetInterface: 'GigabitEthernet0/4' },
      ],
    };
    const { svg } = render(false, 'en', doubled);
    const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#(?!ffffff)/g)].map((m) => m[1]);
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
  });
});
