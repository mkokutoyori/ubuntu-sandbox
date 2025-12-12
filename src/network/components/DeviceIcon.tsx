import { 
  Monitor, 
  Server, 
  Database, 
  Router, 
  Shield, 
  Wifi, 
  Cloud,
  HardDrive,
  Laptop
} from 'lucide-react';
import { DeviceType } from '../types';
import { cn } from '@/lib/utils';

interface DeviceIconProps {
  type: DeviceType;
  size?: number;
  className?: string;
}

export function DeviceIcon({ type, size = 32, className }: DeviceIconProps) {
  const iconProps = { size, className: cn('transition-all', className) };
  
  switch (type) {
    case 'linux-pc':
      return (
        <div className="relative">
          <Monitor {...iconProps} />
          <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-orange-500 text-white rounded px-0.5">
            🐧
          </span>
        </div>
      );
    case 'windows-pc':
      return (
        <div className="relative">
          <Monitor {...iconProps} />
          <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-blue-500 text-white rounded px-0.5">
            ⊞
          </span>
        </div>
      );
    case 'mac-pc':
      return (
        <div className="relative">
          <Laptop {...iconProps} />
          <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-gray-800 text-white rounded px-0.5">
            
          </span>
        </div>
      );
    case 'linux-server':
      return (
        <div className="relative">
          <Server {...iconProps} />
          <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-orange-500 text-white rounded px-0.5">
            🐧
          </span>
        </div>
      );
    case 'windows-server':
      return (
        <div className="relative">
          <Server {...iconProps} />
          <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-blue-500 text-white rounded px-0.5">
            ⊞
          </span>
        </div>
      );
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
    case 'router-cisco':
      return (
        <div className="relative">
          <Router {...iconProps} className={cn(iconProps.className, 'text-cyan-400')} />
          <span className="absolute -bottom-1 -right-1 text-[5px] font-bold bg-cyan-600 text-white rounded px-0.5">
            C
          </span>
        </div>
      );
    case 'router-huawei':
      return (
        <div className="relative">
          <Router {...iconProps} className={cn(iconProps.className, 'text-red-400')} />
          <span className="absolute -bottom-1 -right-1 text-[5px] font-bold bg-red-600 text-white rounded px-0.5">
            H
          </span>
        </div>
      );
    case 'switch-cisco':
      return (
        <div className="relative">
          <HardDrive {...iconProps} className={cn(iconProps.className, 'text-cyan-400')} />
          <span className="absolute -bottom-1 -right-1 text-[5px] font-bold bg-cyan-600 text-white rounded px-0.5">
            C
          </span>
        </div>
      );
    case 'switch-huawei':
      return (
        <div className="relative">
          <HardDrive {...iconProps} className={cn(iconProps.className, 'text-red-400')} />
          <span className="absolute -bottom-1 -right-1 text-[5px] font-bold bg-red-600 text-white rounded px-0.5">
            H
          </span>
        </div>
      );
    case 'firewall-fortinet':
      return (
        <div className="relative">
          <Shield {...iconProps} className={cn(iconProps.className, 'text-red-500')} />
          <span className="absolute -bottom-1 -right-1 text-[5px] font-bold bg-red-700 text-white rounded px-0.5">
            FG
          </span>
        </div>
      );
    case 'firewall-cisco':
      return (
        <div className="relative">
          <Shield {...iconProps} className={cn(iconProps.className, 'text-cyan-400')} />
          <span className="absolute -bottom-1 -right-1 text-[5px] font-bold bg-cyan-600 text-white rounded px-0.5">
            ASA
          </span>
        </div>
      );
    case 'firewall-paloalto':
      return (
        <div className="relative">
          <Shield {...iconProps} className={cn(iconProps.className, 'text-orange-400')} />
          <span className="absolute -bottom-1 -right-1 text-[5px] font-bold bg-orange-600 text-white rounded px-0.5">
            PA
          </span>
        </div>
      );
    case 'access-point':
      return <Wifi {...iconProps} className={cn(iconProps.className, 'text-green-400')} />;
    case 'cloud':
      return <Cloud {...iconProps} className={cn(iconProps.className, 'text-sky-400')} />;
    default:
      return <Monitor {...iconProps} />;
  }
}
