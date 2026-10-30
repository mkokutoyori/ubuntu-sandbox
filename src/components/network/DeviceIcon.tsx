/**
 * DeviceIcon - Icons for different device types
 */

import { Monitor, Database } from 'lucide-react';
import type { DeviceType } from '@/network';
import { cn } from '@/lib/utils';
import { DEVICE_VISUALS, type DeviceVisual } from './device-visuals';
import { DEVICE_GLYPHS } from './device-glyphs';

interface DeviceIconProps {
  type: DeviceType;
  size?: number;
  className?: string;
}

export function DeviceIcon({ type, size = 32, className }: DeviceIconProps) {
  const iconProps = { size, className: cn('transition-all', className) };

  const visual = (DEVICE_VISUALS as Partial<Record<string, DeviceVisual>>)[type];
  if (visual) {
    const Glyph = DEVICE_GLYPHS[visual.glyph];
    return (
      <div className="relative">
        <Glyph {...iconProps} style={visual.glyphColor ? { color: visual.glyphColor } : undefined} />
        {visual.badge && (
          <span
            className="absolute -bottom-1 -right-1 font-bold text-white rounded px-0.5"
            style={{ fontSize: visual.badge.fontSize, backgroundColor: visual.badge.color }}
          >
            {visual.badge.text}
          </span>
        )}
      </div>
    );
  }

  switch (type as DeviceType | 'db-mysql' | 'db-postgres' | 'db-oracle' | 'db-sqlserver') {
    case 'db-mysql':
      return (
        <div className="relative">
          <Database {...iconProps} className={cn(iconProps.className, 'text-blue-400')} />
          <span className="absolute -bottom-1 -right-1 text-[6px] font-bold bg-blue-600 text-white rounded px-0.5">
            My
          </span>
        </div>
      );
    case 'db-postgres':
      return (
        <div className="relative">
          <Database {...iconProps} className={cn(iconProps.className, 'text-blue-300')} />
          <span className="absolute -bottom-1 -right-1 text-[6px] font-bold bg-blue-700 text-white rounded px-0.5">
            PG
          </span>
        </div>
      );
    case 'db-oracle':
      return (
        <div className="relative">
          <Database {...iconProps} className={cn(iconProps.className, 'text-red-400')} />
          <span className="absolute -bottom-1 -right-1 text-[6px] font-bold bg-red-600 text-white rounded px-0.5">
            Or
          </span>
        </div>
      );
    case 'db-sqlserver':
      return (
        <div className="relative">
          <Database {...iconProps} className={cn(iconProps.className, 'text-yellow-400')} />
          <span className="absolute -bottom-1 -right-1 text-[6px] font-bold bg-yellow-600 text-white rounded px-0.5">
            MS
          </span>
        </div>
      );
    default:
      return <Monitor {...iconProps} />;
  }
}
