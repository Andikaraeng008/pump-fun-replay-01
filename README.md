# pump-fun-replay-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Andikaraeng008/pump-fun-replay-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Andikaraeng008/pump-fun-replay-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for make.fun's **Pump.fun Replay Sprint — Paper Bot, Real Ranking** bounty. No real funds: it replays frozen pump.fun data with 10 SOL of paper money, max 5 open positions, no shorts, no leverage.

## Strategy

Two legs, both fully deterministic (BigInt math only — no clock, no randomness):

1. **Completion-chaser.** A pump.fun coin migrates at exactly 85 SOL of real reserves, and the curve price at migration is ~14.7x the creation price. Coins that reach 55 SOL of real reserves complete most of the time, with most of the run still ahead. When a curve's real SOL first reaches 55, the bot buys up to 0.20 SOL in that mint (topping up a small spray holding if one exists), and exits on a 35% trailing stop from the peak or after 300 slots.
2. **Spray.** The rules need at least 20 distinct mints with a round trip of at least 0.01 SOL. The bot buys every new curve once at 0.01 SOL as soon as the 1%-of-real-reserve cap allows it (real SOL >= 1), exiting on a 20% trailing stop or after 600 slots. Capped at 25 spray entries and 2 concurrent spray positions, so it never crowds out leg 1.

## Dev result (kit's own grader, `--driver process`)

- **Net PnL +0.116 SOL** (+1.16% on 10 SOL), 45 round trips, win rate 46.7%, max drawdown 4.6% — guardrails met.
- Honest caveat: the edge is thin and concentrated (3 coins made 53% of the gains); the 90% interval is -0.48 to +0.67 SOL. The final phase runs on a different 24h window, so the result will vary with how many coins complete.

## Run it

```sh
# from inside the downloaded bounty kit directory:
node cli/makefun.mjs grade-local --kit . --bot /path/to/pump-fun-replay-01 --driver process --worktree
```

`main.ts` is the entry (TypeScript, Node 22, stdlib only). `vendor/makefun-bot.ts` is the kit's bot SDK, vendored unchanged.

Entered on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?ref=fkrw3nqq)
