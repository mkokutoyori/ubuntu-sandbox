import type { CommandSpec } from '../../CommandTable';

export const VRP_TIMEZONE_DEFAUT = 'UTC';

const OFFSET_HMS = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export interface VrpClockHost {
  vrpSetTimezone(nom: string, minutes: number): string;
  vrpClearTimezone(): string;
}

function host(device: unknown): VrpClockHost | null {
  const candidate = device as VrpClockHost | null;
  return typeof candidate?.vrpSetTimezone === 'function' ? candidate : null;
}

export function vrpOffsetToMinutes(sens: string, offset: string): number {
  const [h, m] = offset.split(':');
  const magnitude = parseInt(h, 10) * 60 + parseInt(m, 10);
  return sens.toLowerCase() === 'minus' ? -magnitude : magnitude;
}

/** `add 01:00:00` — la forme que VRP ecrit, secondes comprises. */
export function vrpRenderOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  const deuxChiffres = (n: number) => String(n).padStart(2, '0');
  return `${minutes < 0 ? 'minus' : 'add'} `
    + `${deuxChiffres(Math.floor(abs / 60))}:${deuxChiffres(abs % 60)}:00`;
}

const SYSTEM = Object.freeze(['system']);

export function vrpClockFamily(): CommandSpec[] {
  return [
    {
      id: 'vrp-clock-timezone',
      path: ['clock', 'timezone',
        { name: 'nom', type: 'WORD' as const, description: 'Time zone name' },
        {
          name: 'sens', type: 'ENUM' as const, description: 'Offset direction',
          values: [
            { keyword: 'add', description: 'Add the offset to UTC' },
            { keyword: 'minus', description: 'Subtract the offset from UTC' },
          ],
        },
        {
          name: 'offset', type: 'WORD' as const, literal: 'HH:MM:SS',
          pattern: OFFSET_HMS, description: 'Offset from UTC',
        },
      ],
      description: 'Set the time zone',
      modes: SYSTEM, minPrivilege: 1,
      run: (session, args) => {
        const target = host(session.device);
        if (!target) return '';
        return target.vrpSetTimezone(
          String(args.nom), vrpOffsetToMinutes(String(args.sens), String(args.offset)));
      },
    },
    {
      id: 'vrp-clock-timezone-undo',
      path: ['clock', 'timezone'],
      description: 'Set the time zone',
      modes: SYSTEM, minPrivilege: 1,
      existsOnlyNegated: true,
      run: () => '',
      undo: (session) => host(session.device)?.vrpClearTimezone() ?? '',
    },
  ];
}
