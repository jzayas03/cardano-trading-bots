import type { Strategy } from '../types.js';
import { maCrossover } from './maCrossover.js';
export const STRATEGIES: Record<string, Strategy> = { [maCrossover.id]: maCrossover };
export { maCrossover };
