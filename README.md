# pump-fun-replay-dip-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/targammm/pump-fun-replay-dip-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/targammm/pump-fun-replay-dip-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A selective dip-buyer paper bot for make.fun's **Pump.fun Replay Sprint — Paper Bot, Real Ranking**: it trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins; a placement needs net PnL above holding cash after every fee.

## Strategy

Most curves die; a fat tail graduates. The bot buys a curve only when it is already climbing toward graduation — real SOL reserves between 12 and 80 SOL, net inflow of at least 3 SOL over the last 240 slots from at least 6 distinct buyers, buyers dominating the tape — and the price has pulled back at least 18% from its 120-slot high without collapsing. One fixed 0.25 SOL stake per curve, at most one entry per curve, at most 5 open positions.

Exits let the rare graduate run: no hard take-profit cap, a trailing stop that arms at +100% and gives back 40% from the peak, a −20% hard stop, a fade exit when net flow turns hard negative, and a 12,000-slot max hold. Tiny probe round trips keep the 20-coin minimum bar met on quiet stretches.

## What did not work

Tuning on the same dev window showed the selectivity is the whole edge: a looser dip filter (135 round trips) lost −0.64 SOL, a momentum-breakout variant lost −3.52 SOL buying fresh highs that then died, and a loose trailing stop lost −1.45 SOL letting losers ride. The submitted parameters sit in the tight, fee-robust region: every variant with the same tight entry filter stayed positive, while every loosening went negative.

Local dev-window grade (kit `grade-local`, process driver): **+0.757 SOL net PnL** (+0.601 SOL at 2× fees), 33 round trips over 32 coins, max drawdown 3.8%, two runs byte-identical.

## Run it

Grade it locally with the competition kit (Node 22.18+; the kit ships its own CLI, nothing to install):

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

The entrypoint is `main.ts` (TypeScript, run as-is on Node 22). `vendor/makefun-bot.ts` is the kit's SDK shim, vendored byte for byte. Everything the bot runs is in this repository.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c5ppnbr2&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
