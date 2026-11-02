import { registerDeviceBuilder } from '../deviceBuilders';
import { WindowsPC } from '../WindowsPC';
import { WindowsServer } from '../WindowsServer';

registerDeviceBuilder('windows-pc', (name, x, y) => new WindowsPC('windows-pc', name, x, y));
registerDeviceBuilder('windows-server', (name, x, y) => new WindowsServer(name, x, y));
