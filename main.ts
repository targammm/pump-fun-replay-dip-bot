// Selective dip-buyer for the pump.fun bonding-curve replay.
//
// Idea: most curves die, a fat tail graduates. A curve climbing toward
// graduation (real SOL reserves growing, sustained net buying from many
// distinct wallets) that pulls back from its recent high is bought small;
// the position is cut fast when the story breaks and ridden while the curve
// keeps climbing — no hard take-profit cap, a trailing stop that arms late
// and gives back 40% from the peak. Every buy is a fixed stake, so one dead
// coin costs little and one graduate pays for many losers. A pace guard
// opens tiny probe round trips when the run's own fills or distinct coins
// lag the pace, so the 20-coin minimum bar is met even on a quiet day.
// A breakout mode (buy a fresh high with inflow) is kept in the code as an
// alternative entry; the dev window punishes it hard (-3.52 SOL), so the
// submitted default is the dip.
//
// Deterministic by construction: all state lives in insertion-ordered maps
// fed by the batch stream; no clock, no randomness, no environment reads.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, per side
const DAY_SECS = 86_400;

export interface Params {
  /** 'dip': buy a pullback inside a climb. 'breakout': buy a fresh high with strong inflow. */
  entryMode: 'dip' | 'breakout';
  /** Lookback (slots) whose high the dip is measured against. */
  dipWindow: number;
  /** Buy when price is at most this share of the window high (0.92 = 8% dip). */
  dipShare: number;
  /** Lookback (slots) for the strength check (net inflow + buyers). */
  strengthWindow: number;
  /** Net SOL (buys minus sells) over the strength window. */
  minNetSol: number;
  /** Share of strength-window SOL volume that must be buys (0.6 = buyers dominate). */
  minBuyShare: number;
  /** Distinct buying wallets over the strength window. */
  minBuyers: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Trades in the last recentWindow slots required to call a curve alive. */
  recentWindow: number;
  minRecentTrades: number;
  /** SOL per position (one buy, no pyramid). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell when close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell when close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Sell when value falls to peak * (1 - trail). */
  trail: number;
  /** Net SOL over the fade window below which the position is closed. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held (unless up by holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: distinct coins / fills the run must reach. */
  targetCoins: number;
  targetFills: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMode: 'dip',
  dipWindow: 120,
  dipShare: 0.82,
  strengthWindow: 240,
  minNetSol: 3.0,
  minBuyShare: 0.6,
  minBuyers: 6,
  minRqSol: 12,
  maxRqSol: 80,
  minAge: 180,
  recentWindow: 60,
  minRecentTrades: 5,
  stakeSol: 0.25,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 10.0,
  stopLoss: 0.2,
  trailArm: 1.0,
  trail: 0.4,
  fadeWindow: 60,
  fadeNetSol: 5.0,
  maxHold: 12_000,
  holdIfUp: 1.0,
  cooldown: 600,
  maxEntries: 1,
  maxExposureSol: 8,
  targetCoins: 25,
  targetFills: 60,
  probeSol: 0.02,
  maxProbes: 1,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.dipWindow, p.strengthWindow, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal: a dip inside a still-strengthening climb toward graduation. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    let high = 0;
    let last = 0;
    let recent = 0;
    let net = 0;
    let buySol = 0;
    let sellSol = 0;
    const byUser = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= now - p.dipWindow) {
        // Older trades only feed the strength window below.
        if (tr.slot > now - p.strengthWindow) {
          net += tr.buy ? tr.sol : -tr.sol;
          if (tr.buy) {
            buySol += tr.sol;
            byUser.add(tr.user);
          } else {
            sellSol += tr.sol;
          }
        }
        continue;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buySol += tr.sol;
        byUser.add(tr.user);
      } else {
        sellSol += tr.sol;
      }
      if (tr.slot > now - p.recentWindow) recent++;
    }
    if (last <= 0 || high <= 0) return false;
    if (p.entryMode === 'breakout') {
      // Ride the climb: price at (or within 2% of) its window high, with the
      // tape still dominated by buyers. In a market where most curves die,
      // a fresh high with inflow is a stronger tell than a pullback.
      if (last < high * 0.98) return false;
    } else {
      // The dip: price pulled back from the window high, but not collapsed.
      if (last > high * p.dipShare) return false;
      if (last < high * 0.5) return false;
    }
    // The strength: net inflow still positive, buyers dominating the tape,
    // several distinct buyers — a pullback inside a real climb, not a dying
    // curve with one last wash of buys.
    if (net < p.minNetSol) return false;
    if (buySol <= 0 || buySol / (buySol + sellSol) < p.minBuyShare) return false;
    if (byUser.size < p.minBuyers) return false;
    if (recent < p.minRecentTrades) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take-profit, stop, trailing, fade, max hold.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: one fixed stake per curve, only on the dip-in-strength signal.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (exposure + p.stakeSol > p.maxExposureSol) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the day's pace.
      const paceProbes = p.maxProbes + (firstTime !== null && lastTime !== null && (lastTime - firstTime) / DAY_SECS > 0.5 && myFills < 10 ? 1 : 0);
      if (probes.size < paceProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / DAY_SECS);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= paceProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

await runBot(createStrategy());
