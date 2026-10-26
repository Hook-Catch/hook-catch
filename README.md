# Hook Catch

**[usehookcatch.fun](https://usehookcatch.fun)** · Price rules that trade for you on Robinhood Chain: take profit, stop loss, buy the dip and DCA for Pons tokens and Uniswap v4 pools. One contract, open keepers, and nothing held for you except the ETH you deposit for buys.

**Token:** $HOOKCATCH · **Chain:** Robinhood Chain (4663) · **Contract:** [`0xc2ab35c41022da338a4fe450444e20a41044bdd6`](https://robinhoodchain.blockscout.com/address/0xc2ab35c41022da338a4fe450444e20a41044bdd6) · [verified on Sourcify](https://repo.sourcify.dev/4663/0xc2ab35c41022da338a4fe450444e20a41044bdd6)

## How it works

1. **You set a rule.** Pick a token, a kind, an amount, a trigger price, a limit price, how many runs and an expiry.
2. **A keeper calls `execute(id)`.** Anyone can. The contract reads the live on-chain price and refuses if the line hasn't been crossed, the rule expired or the next DCA run isn't due.
3. **The trade settles in the same transaction.** Pons tokens trade on their bonding curve while it is live, and on the Uniswap v4 pool after graduation. Any ETH-paired v4 pool works too.

| Rule | What it does | Funds |
|---|---|---|
| Take profit | Sell when the price rises to the line | Tokens stay in your wallet, pulled only when it fires (capped by your allowance) |
| Stop loss | Sell when the price falls to the line | Same as above |
| Buy the dip | Buy when the price falls to the line, up to 3 ladder steps | ETH deposited in the contract, withdraw any time |
| DCA | Buy every N hours, with a price ceiling | Same as above |

Every rule carries a **limit price**: the trade reverts if the fill is worse, so a keeper can't push the price to fill you badly.

## Fees

| | |
|---|---|
| Keeper | 0.30% of each trade, paid to whoever executes it |
| Protocol | 0.20% to the fee wallet, used for $HOOKCATCH buybacks |
| Hold 100K $HOOKCATCH | protocol fee 0.10%, unlimited rules |
| Hold 1M $HOOKCATCH | protocol fee 0% |
| Without the token | up to 3 active rules |

The owner can only change the fee wallet and set the $HOOKCATCH address once. There is no pause, no upgrade and no function that moves user funds.

## Repository

```
contracts/   HookCatch.sol, compile script, fork tests, one-click deploy page
site/        the app (single HTML file, built from index.template.html)
keeper/      the keeper bot
```

### Build and test the contract

```bash
cd contracts
npm install
node compile.mjs
```

The tests run on a local fork of Robinhood Chain against the real Pons curves and Uniswap v4 pools:

```bash
FORK_RPC=<archive RPC url> npx hardhat node --config hardhat.config.cjs
node test.mjs
```

Compiler: solc 0.8.24, viaIR, optimizer 200 runs, evm cancun. `HookCatch.standard-input.json` is the exact input for verification.

### Build the site

```bash
node site/build.mjs
```

This embeds the ABI into `site/index.html`. Set `CONFIG.contract` in the template after deployment.

### Run a keeper

```bash
cd keeper
npm install
KEEPER_KEY=0x... HOOKCATCH=<contract> node keeper.mjs
```

Use a fresh wallet with a little ETH for gas, never your main wallet. Options: `RPC`, `INTERVAL` (seconds, default 20), `MIN_PROFIT` (fee must beat gas by this factor, default 1.2; 0 executes everything), `DRY_RUN=1`, `ONCE=1`.

## Risks

Hook Catch has not had an independent audit. Rules use the spot price at execution time, and the limit price is your protection against a bad fill. Keepers are not guaranteed: a rule that pays less than the gas may wait. Only trade what you can afford to lose.

## License

MIT
