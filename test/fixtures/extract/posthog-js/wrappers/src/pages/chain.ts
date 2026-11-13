// Five wrappers deep is a site; six is cut off.
import { level5, level6 } from '../lib/chain';

export function checkout(): void {
  level5('five_deep');
  level6('six_deep');
}
