import type { Strategy } from '../types.js';
import { buyAndHold } from './buyAndHold.js';
import { maCrossover } from './maCrossover.js';
import { rsiMeanReversion } from './rsiMeanReversion.js';
import { scheduledAccumulation } from './scheduledAccumulation.js';
export const STRATEGIES: Record<string, Strategy> = { [maCrossover.id]: maCrossover, [rsiMeanReversion.id]: rsiMeanReversion, [buyAndHold.id]: buyAndHold, [scheduledAccumulation.id]: scheduledAccumulation };
export { buyAndHold, maCrossover, rsiMeanReversion, scheduledAccumulation };
