import { registerDeviceBuilder } from '../deviceBuilders';
import { GenericSwitch } from '../GenericSwitch';
import { Hub } from '../Hub';

registerDeviceBuilder('switch-generic', (name, x, y) => new GenericSwitch('switch-generic', name, 24, x, y));
registerDeviceBuilder('hub', (name, x, y) => new Hub(name, 8, x, y));
registerDeviceBuilder('access-point', (name, x, y) => new Hub(name, 4, x, y));
