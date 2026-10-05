import type { PamRlimit, PamRlimitResource } from './PamLinuxHost';

const UNLIMITED = Number.POSITIVE_INFINITY;

const DEFAULTS: ReadonlyArray<readonly [PamRlimitResource, PamRlimit]> = [
  ['cpu', { soft: UNLIMITED, hard: UNLIMITED }],
  ['fsize', { soft: UNLIMITED, hard: UNLIMITED }],
  ['data', { soft: UNLIMITED, hard: UNLIMITED }],
  ['stack', { soft: 8_388_608, hard: UNLIMITED }],
  ['core', { soft: 0, hard: UNLIMITED }],
  ['rss', { soft: UNLIMITED, hard: UNLIMITED }],
  ['nproc', { soft: 15730, hard: 15730 }],
  ['nofile', { soft: 1024, hard: 1_048_576 }],
  ['memlock', { soft: 67_108_864, hard: 67_108_864 }],
  ['as', { soft: UNLIMITED, hard: UNLIMITED }],
  ['locks', { soft: UNLIMITED, hard: UNLIMITED }],
  ['sigpending', { soft: 15730, hard: 15730 }],
  ['msgqueue', { soft: 819_200, hard: 819_200 }],
  ['nice', { soft: 0, hard: 0 }],
  ['rtprio', { soft: 0, hard: 0 }],
  ['rttime', { soft: UNLIMITED, hard: UNLIMITED }],
];

export function defaultRlimits(overrides: ReadonlyMap<PamRlimitResource, PamRlimit> = new Map()): Map<PamRlimitResource, PamRlimit> {
  return new Map(DEFAULTS.map(([resource, limit]) => [resource, { ...(overrides.get(resource) ?? limit) }]));
}
