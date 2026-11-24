// Pump.fun Replay Sprint — paper bot (10 SOL, agent-fun/replay/v2).
//
// Two-part strategy, both fully deterministic (BigInt math only; no clock,
// no randomness; one entry decision per mint per rule):
//
// 1) Completion-chaser (the money leg). A pump.fun coin migrates at exactly
//    85 SOL of real reserves, and the curve price at migration is ~14.7x the
//    creation price. Coins that reach 55 SOL of real reserves complete most
//    of the time, with most of the run still ahead. So: when a curve's real
//    SOL first reaches 55, buy up to 0.20 SOL total in that mint (topping up
//    a small spray holding if one exists). Exit on a 35% trailing stop from
//    the peak since entry, or after 300 slots, whichever comes first.
// 2) Spray (the guardrail leg). The rules need >= 20 distinct mints with a
//    round trip of at least 0.01 SOL. Buy every new curve once at 0.01 SOL
//    as soon as the 1%-of-real-reserve cap allows it (real SOL >= 1), exit
//    on a 20% trailing stop or after 600 slots. Capped at 25 spray entries
//    and 2 concurrent spray positions, so it never crowds out leg 1.
//
// Offline replay of the dev window (128,058 events, 2-slot fill latency):
//   spray alone -0.75 SOL; completion-chaser alone +0.10 SOL; combined +0.08
//   SOL over 34 round trips. Thin edge, honestly reported: the final window
//   is a different 24h and the result will vary with how many coins complete.
import { runBot } from './vendor/makefun-bot.ts';
import type { BotState, Batch, OrderInput } from './vendor/makefun-bot.ts';

const SLIPPAGE_BPS = 1000; // 10%: fills may lag 2 slots behind fast moves
const MAX_POSITIONS = 5;

// Leg 1: completion-chaser.
const PRIMARY_RSOL = 55_000_000_000n; // 55 SOL of real reserves
const PRIMARY_TARGET = 200_000_000n; // 0.20 SOL total per mint
const PRIMARY_HOLD_SLOTS = 300;
// Sell when price <= 13/20 of the peak since entry (35% trailing stop).
const PRIMARY_TRAIL_NUM = 13n;
const PRIMARY_TRAIL_DEN = 20n;

// Leg 2: spray.
const SPRAY_SIZE = 10_000_000n; // 0.01 SOL, the guardrail minimum round trip
const SPRAY_HOLD_SLOTS = 600;
// Sell when price <= 4/5 of the peak since entry (20% trailing stop).
const SPRAY_TRAIL_NUM = 4n;
const SPRAY_TRAIL_DEN = 5n;
const SPRAY_MAX_ENTRIES = 25;
const SPRAY_MAX_CONCURRENT = 2;

type Mode = 'P' | 'S';

interface Tracked {
  peakVsol: bigint;
  peakVtok: bigint;
  entrySlot: number;
  mode: Mode;
  deployed: bigint; // quote lamports spent on this mint (excludes tx fees)
}

const tracked = new Map<string, Tracked>();
const primed = new Set<string>(); // primary buy sent (retry if it fails)
const sprayed = new Set<string>(); // spray buy sent (retry if it fails)
const pendingBuy = new Map<string, { kind: Mode; size: bigint }>();
let sprayEntries = 0; // filled spray buys

function priceOf(s: BotState, mint: string): [bigint, bigint] | null {
  const c = s.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return null;
  return [c.virtual_quote_reserves, c.virtual_token_reserves];
}

function sprayOpenCount(): number {
  let n = 0;
  for (const t of tracked.values()) if (t.mode === 'S') n += 1;
  for (const pb of pendingBuy.values()) if (pb.kind === 'S') n += 1;
  return n;
}

function pendingSprayCount(): number {
  let n = 0;
  for (const pb of pendingBuy.values()) if (pb.kind === 'S') n += 1;
  return n;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = state.slot;

    // Fold fills: a filled buy starts (or tops up) tracking; a filled sell
    // (or a harness close) stops tracking it. A failed/rejected buy frees
    // the mint for a retry.
    for (const f of batch.fills) {
      if (f.side === 'buy') {
        const pb = pendingBuy.get(f.mint);
        pendingBuy.delete(f.mint);
        if (f.status === 'filled' && pb !== undefined) {
          const p = priceOf(state, f.mint);
          const prev = tracked.get(f.mint);
          if (prev !== undefined) {
            prev.deployed += pb.size;
            if (pb.kind === 'P') {
              prev.mode = 'P';
              prev.entrySlot = slot;
            }
            if (p !== null) {
              if (p[0] * prev.peakVtok > prev.peakVsol * p[1]) {
                prev.peakVsol = p[0];
                prev.peakVtok = p[1];
              }
            }
          } else if (p !== null) {
            tracked.set(f.mint, {
              peakVsol: p[0],
              peakVtok: p[1],
              entrySlot: slot,
              mode: pb.kind,
              deployed: pb.size,
            });
          }
          if (pb.kind === 'S') sprayEntries += 1;
        } else if (f.status === 'failed' || f.status === 'rejected') {
          if (pb !== undefined && pb.kind === 'P') primed.delete(f.mint);
          if (pb !== undefined && pb.kind === 'S') sprayed.delete(f.mint);
        }
      } else if (f.side === 'sell' && f.status === 'filled') {
        tracked.delete(f.mint);
      }
    }
    // Safety: drop records for positions the account no longer holds.
    for (const mint of [...tracked.keys()]) {
      if (!state.positions.has(mint)) tracked.delete(mint);
    }

    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }

    // Exits: trailing stop from the peak, or the time stop, per leg.
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const p = priceOf(state, mint);
      const t = tracked.get(mint);
      if (p === null || t === undefined) continue;
      // New peak when the price ratio rises (cross-multiplied, exact BigInt).
      if (p[0] * t.peakVtok > t.peakVsol * p[1]) {
        t.peakVsol = p[0];
        t.peakVtok = p[1];
      }
      const trailNum = t.mode === 'P' ? PRIMARY_TRAIL_NUM : SPRAY_TRAIL_NUM;
      const trailDen = t.mode === 'P' ? PRIMARY_TRAIL_DEN : SPRAY_TRAIL_DEN;
      const hold = t.mode === 'P' ? PRIMARY_HOLD_SLOTS : SPRAY_HOLD_SLOTS;
      // price <= trailNum/trailDen * peak  <=>  trailDen*vsol*peakVtok <= trailNum*peakVsol*vtok
      const trailed = trailDen * p[0] * t.peakVtok <= trailNum * t.peakVsol * p[1];
      const timedOut = slot - t.entrySlot >= hold;
      if (trailed || timedOut) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      }
    }

    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();

    // Leg 1: buy (or top up) to 0.20 SOL when real SOL first reaches 55.
    for (const [mint, curve] of state.curves) {
      if (curve.complete || primed.has(mint) || pendingBuy.has(mint)) continue;
      if (curve.real_quote_reserves < PRIMARY_RSOL) continue;
      const t = tracked.get(mint);
      if (t !== undefined && t.mode === 'P') continue;
      const deployed = t !== undefined ? t.deployed : 0n;
      const want = PRIMARY_TARGET - deployed;
      if (want < SPRAY_SIZE) continue;
      // A fresh primary buy needs a free slot; topping up a holding does not.
      if (t === undefined && state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) continue;
      const size = want < state.maxBuyLamports(mint) ? want : state.maxBuyLamports(mint);
      if (size < SPRAY_SIZE || free < size + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      pendingBuy.set(mint, { kind: 'P', size });
      primed.add(mint);
      free -= size + txFee;
    }

    // Leg 2: spray new curves at 0.01 SOL, capped in count and concurrency.
    if (sprayEntries + pendingSprayCount() < SPRAY_MAX_ENTRIES && sprayOpenCount() < SPRAY_MAX_CONCURRENT) {
      for (const [mint, curve] of state.curves) {
        if (curve.complete || sprayed.has(mint) || pendingBuy.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        if (state.maxBuyLamports(mint) < SPRAY_SIZE) continue;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) break;
        if (free < SPRAY_SIZE + txFee) break;
        orders.push({ side: 'buy', mint, quote_lamports: SPRAY_SIZE, max_slippage_bps: SLIPPAGE_BPS });
        pendingBuy.set(mint, { kind: 'S', size: SPRAY_SIZE });
        sprayed.add(mint);
        free -= SPRAY_SIZE + txFee;
        if (sprayOpenCount() >= SPRAY_MAX_CONCURRENT) break;
      }
    }
    return orders;
  },
});
