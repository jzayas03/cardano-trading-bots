import type { EquityPoint, OrderRecord } from '@ctb/engine';
import { describe, expect, it } from 'vitest';
import { csvField, csvFileNames, EQUITY_COLUMNS, equityCsv, ORDER_COLUMNS, ordersCsv } from '../src/csv.js';

const filled: OrderRecord = {
  seq: 1, tsIntent: new Date('2026-09-06T00:00:00Z'), intent: { side: 'buy', amountIn: 990_000_000n, reason: 'rsi back above 30 (0.0 -> 50.0) period=2' },
  result: { status: 'filled', poolId: 'MinswapV2:abc', unitIn: 'lovelace', amountIn: 990_000_000n, unitOut: 'tok', amountOut: 2_151_119n, midPrice: '0.000460000000000000', fillPrice: '0.000460200000000000',
    poolFeeIn: 2_970_000n, batcherFeeLovelace: 2_000_000n, networkFeeLovelace: 200_000n, slippageBps: -158, priceImpactBps: 42, poolAfter: null, tsFill: new Date('2026-09-06T00:10:00Z') },
};
const rejected: OrderRecord = { seq: 2, tsIntent: new Date('2026-09-06T00:10:00Z'), intent: { side: 'sell', amountIn: 5n, reason: 'a "quoted", comma' }, result: { status: 'rejected', reason: 'stale t+1 (gap 35m)' } };

describe('csvField', () => {
  it('writes plain values bare and quotes commas, quotes and line breaks per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(12n)).toBe('12');
    expect(csvField(-1.5)).toBe('-1.5');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
  });
});

describe('ordersCsv', () => {
  it('has one header, one row per order, and the same column count on every row', () => {
    const text = ordersCsv([filled, rejected]);
    const lines = text.split('\n');
    expect(lines[0]).toBe(ORDER_COLUMNS.join(','));
    expect(lines).toHaveLength(4); // header, 2 rows, trailing newline
    expect(lines[1]).toBe('1,2026-09-06T00:00:00.000Z,buy,990000000,rsi back above 30 (0.0 -> 50.0) period=2,filled,2026-09-06T00:10:00.000Z,MinswapV2:abc,lovelace,tok,2151119,0.000460000000000000,0.000460200000000000,2970000,2000000,200000,-158,42,');
    expect(lines[2]).toBe('2,2026-09-06T00:10:00.000Z,sell,5,"a ""quoted"", comma",rejected,,,,,,,,,,,,,stale t+1 (gap 35m)');
    // every data row has exactly as many fields as the header (a naive split would miscount the quoted reason, so check the quoted row by its known shape)
    expect(lines[1]!.split(',')).toHaveLength(ORDER_COLUMNS.length);
  });
});

describe('equityCsv', () => {
  it('writes lovelace as integers and an empty executable cell when the executor could not price', () => {
    const pts: EquityPoint[] = [
      { tickTs: new Date('2026-09-06T00:00:00Z'), cashLovelace: 1_000_000_000n, positionBase: 0n, equityLovelace: 1_000_000_000n, equityExecutableLovelace: 1_000_000_000n, price: '0.0005' },
      { tickTs: new Date('2026-09-06T00:10:00Z'), cashLovelace: 7_800_000n, positionBase: 2_151_119n, equityLovelace: 997_000_000n, equityExecutableLovelace: null, price: '0.00046' },
    ];
    expect(equityCsv(pts)).toBe(`${EQUITY_COLUMNS.join(',')}\n2026-09-06T00:00:00.000Z,1000000000,0,1000000000,1000000000,0.0005\n2026-09-06T00:10:00.000Z,7800000,2151119,997000000,,0.00046\n`);
  });
});

describe('csvFileNames', () => {
  it('puts REHEARSAL in the file name of a rehearsal run, so synthetic data is marked where the file is opened', () => {
    expect(csvFileNames({ id: 12, rehearsal: false })).toEqual({ orders: 'run-12-orders.csv', equity: 'run-12-equity.csv' });
    expect(csvFileNames({ id: 7, rehearsal: true })).toEqual({ orders: 'run-7-REHEARSAL-orders.csv', equity: 'run-7-REHEARSAL-equity.csv' });
  });
});
