import { registerDeviceBuilder } from '../deviceBuilders';
import { CiscoSwitch } from '../CiscoSwitch';
import { CiscoRouter } from '../CiscoRouter';

registerDeviceBuilder('switch-cisco', (name, x, y) => new CiscoSwitch('switch-cisco', name, 26, x, y));
registerDeviceBuilder('router-cisco', (name, x, y) => new CiscoRouter(name, x, y));
