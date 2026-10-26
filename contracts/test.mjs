// Tests HookCatch on a local fork of Robinhood Chain (npx hardhat node --config hardhat.config.cjs).
// Real Pons curves and real Uniswap v4 pools; accounts are the fork's funded test wallets.
// Run: node test.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, maxUint256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = 'http://127.0.0.1:8545';
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const { abi, bytecode } = JSON.parse(readFileSync(new URL('./build/HookCatch.json', import.meta.url), 'utf8'));

const SMART = { token: '0x0b78f8903265d93c0c156fba5c589b2d3eb2689b', curve: '0x32968c128ed2ea3d19ceb595f6133e51d7aaae72' }; // on its curve
const GOLEMITE = { token: '0x3d9f1a6faf2e290eea620cb95f61bd9902397375', curve: null }; // graduated to v4
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const curveAbi = [{ type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }], outputs: [] }];
const Kind = { SellAbove: 0, SellBelow: 1, BuyBelow: 2, BuyEvery: 3 };

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };
async function reverts(name, fn, match) {
  try { await fn(); check(name, false, 'did not revert'); }
  catch (e) { const msg = (e.shortMessage || e.message || '') + ' ' + (e.cause?.reason || ''); check(name, !match || msg.includes(match), match ? (msg.includes(match) ? `reverted: ${match}` : msg.slice(0, 160)) : ''); }
}

// fresh wallets: the well-known Hardhat keys carry EIP-7702 delegations on the real chain, so they can't be used on a fork
const wallets = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
for (const a of wallets) await pub.request({ method: 'hardhat_setBalance', params: [a.address, '0x' + parseEther('100').toString(16)] });
const byAddr = new Map(wallets.map((a) => [a.address, a]));
const [deployer, user, keeper, sink, other] = wallets.map((a) => a.address);
const w = (address) => createWalletClient({ account: byAddr.get(address), chain, transport: http(RPC) });
const send = async (account, args) => { const hash = await w(account).writeContract({ ...args, chain }); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('tx failed'); return r; };
const bal = (a) => pub.getBalance({ address: a });
const tokBal = (t, a) => pub.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [a] });

// curve address of GOLEMITE from the Pons API (needed for creation checks even after graduation)
GOLEMITE.curve = (await (await fetch('https://ponsfamily.com/api/launches/' + GOLEMITE.token)).json()).curve;

// ---------------- deploy
const deployHash = await w(deployer).deployContract({ abi, bytecode, args: [sink], chain });
const HC = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
const hc = { address: HC, abi };
const read = (functionName, args = []) => pub.readContract({ ...hc, functionName, args });
const ZERO = '0x0000000000000000000000000000000000000000';
const toInput = ([token, curve, kind, amount, trigger, limit, runs, interval, expiry], pool = {}) => ({ token, curve, poolFee: pool.fee ?? 0, tickSpacing: pool.ts ?? 0, hooks: pool.hooks ?? ZERO, kind, amount, trigger, limit, runs, interval, expiry });
const tx = (account, functionName, args = [], value) => send(account, { ...hc, functionName, args: functionName === 'createRule' && args.length === 9 ? [toInput(args)] : args, value });
const now = (await pub.getBlock()).timestamp; // the fork's clock, which earlier time jumps moved ahead
const far = now + BigInt(30 * 86400);
const lastRule = async () => Number(await read('rulesCount')) - 1;
const ruleOf = async (i) => (await read('getRules', [BigInt(i), BigInt(i) + 1n]))[0];
console.log('HookCatch deployed at', HC);

// ---------------- prices
const [pSmart, smartOnCurve] = await read('priceOf', [SMART.token, SMART.curve]);
const [pGol, golOnCurve] = await read('priceOf', [GOLEMITE.token, GOLEMITE.curve]);
check('SMART price comes from its curve', smartOnCurve === true && pSmart > 0n, `${formatEther(pSmart)} ETH per token`);
check('GOLEMITE price comes from its v4 pool', golOnCurve === false && pGol > 0n, `${formatEther(pGol)} ETH per token`);

// ---------------- buy the dip on a curve
await tx(user, 'deposit', [], parseEther('0.2'));
check('deposit recorded', (await read('deposits', [user])) === parseEther('0.2'));
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.BuyBelow, parseEther('0.05'), pSmart * 2n, pSmart * 3n / 2n, 1, 0, far]);
let id = await lastRule();
const ok0 = await read('canExecute', [BigInt(id)]);
check('keeper view says it can run', ok0[0] === true, ok0[1]);
let kBefore = await bal(keeper), sBefore = await bal(sink), tBefore = await tokBal(SMART.token, user);
let r = await tx(keeper, 'execute', [BigInt(id)]);
let gotSmart = (await tokBal(SMART.token, user)) - tBefore;
check('dip buy on the curve delivers tokens to the user', gotSmart > 0n, `${Number(formatEther(gotSmart)).toLocaleString('en-US')} SMART`);
check('protocol fee 0.20% of 0.05 ETH to the sink', (await bal(sink)) - sBefore === parseEther('0.0001'));
const keeperNet = (await bal(keeper)) - kBefore;
check('keeper is paid 0.30% (minus gas)', keeperNet > 0n || keeperNet > -parseEther('0.0002'), `net ${formatEther(keeperNet)} ETH incl. gas`);
check('deposit reduced by the run', (await read('deposits', [user])) === parseEther('0.15'));
check('one-shot rule closes after firing', (await ruleOf(id)).active === false);
await reverts('a closed rule cannot run again', () => tx(keeper, 'execute', [BigInt(id)]), 'not active');

// ---------------- trigger not met
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.BuyBelow, parseEther('0.01'), pSmart / 2n, pSmart, 1, 0, far]);
id = await lastRule();
await reverts('dip buy waits while price is above the trigger', () => tx(keeper, 'execute', [BigInt(id)]), 'price above trigger');
await tx(user, 'cancelRule', [BigInt(id)]);

// ---------------- take profit on a curve (tokens stay in the wallet until it fires)
await send(user, { address: SMART.token, abi: erc20, functionName: 'approve', args: [HC, maxUint256] });
const half = gotSmart / 2n;
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.SellAbove, half, pSmart / 2n, pSmart / 2n, 1, 0, far]);
id = await lastRule();
check('tokens are still in the wallet before the rule fires', (await tokBal(SMART.token, user)) >= gotSmart);
let eBefore = await bal(user);
await tx(keeper, 'execute', [BigInt(id)]);
const gotEth = (await bal(user)) - eBefore;
check('take profit sells on the curve and pays the user in ETH', gotEth > 0n, `${formatEther(gotEth)} ETH`);
check('only the rule amount was sold', (await tokBal(SMART.token, user)) === gotSmart - half);

// ---------------- stop loss not met, and the price limit
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.SellBelow, half, pSmart / 3n, pSmart / 4n, 1, 0, far]);
id = await lastRule();
await reverts('stop loss waits while price is above the stop', () => tx(keeper, 'execute', [BigInt(id)]), 'price above trigger');
await tx(user, 'cancelRule', [BigInt(id)]);
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.SellAbove, half, pSmart / 2n, pSmart * 5n, 1, 0, far]);
id = await lastRule();
await reverts('a sale never fills below the limit price', () => tx(keeper, 'execute', [BigInt(id)]));
check('rule stays armed after a refused fill', (await ruleOf(id)).active === true);
await tx(user, 'cancelRule', [BigInt(id)]);

// ---------------- DCA
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.BuyEvery, parseEther('0.01'), 0n, pSmart * 2n, 2, 3600, far]);
id = await lastRule();
await tx(keeper, 'execute', [BigInt(id)]);
check('DCA run 1', (await ruleOf(id)).runsLeft === 1);
await reverts('DCA cannot run again before the interval', () => tx(keeper, 'execute', [BigInt(id)]), 'too early');
await pub.request({ method: 'evm_increaseTime', params: [3601] }); await pub.request({ method: 'evm_mine', params: [] });
await tx(keeper, 'execute', [BigInt(id)]);
check('DCA run 2 after the interval, then closes', (await ruleOf(id)).active === false);

// ---------------- graduated token: Uniswap v4 pool
await tx(user, 'createRule', [GOLEMITE.token, GOLEMITE.curve, Kind.BuyBelow, parseEther('0.02'), pGol * 2n, pGol * 3n / 2n, 1, 0, far]);
id = await lastRule();
tBefore = await tokBal(GOLEMITE.token, user);
await tx(keeper, 'execute', [BigInt(id)]);
const gotGol = (await tokBal(GOLEMITE.token, user)) - tBefore;
check('dip buy through the v4 pool delivers tokens', gotGol > 0n, `${Number(formatEther(gotGol)).toLocaleString('en-US')} GOLEMITE`);
await send(user, { address: GOLEMITE.token, abi: erc20, functionName: 'approve', args: [HC, maxUint256] });
await tx(user, 'createRule', [GOLEMITE.token, GOLEMITE.curve, Kind.SellAbove, gotGol, pGol / 2n, pGol / 2n, 1, 0, far]);
id = await lastRule();
eBefore = await bal(user);
await tx(keeper, 'execute', [BigInt(id)]);
check('take profit through the v4 pool pays ETH', (await bal(user)) > eBefore, `${formatEther((await bal(user)) - eBefore)} ETH`);
check('nothing is left stuck in the contract (tokens)', (await tokBal(GOLEMITE.token, HC)) === 0n && (await tokBal(SMART.token, HC)) === 0n);
// the 3-rule limit counts active rules: close the open ones from the steps above

// ---------------- safety
await reverts('a curve of another token is rejected', () => tx(user, 'createRule', [SMART.token, GOLEMITE.curve, Kind.BuyBelow, 1n, 1n, 1n, 1, 0, far]), 'not a Pons curve');
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.SellBelow, 1n, 1n, 1n, 1, 0, far]);
id = await lastRule();
await reverts('only the owner can cancel', () => tx(other, 'cancelRule', [BigInt(id)]), 'not your rule');
await tx(user, 'cancelRule', [BigInt(id)]);
for (let i = 0; i < 3; i++) await tx(other, 'createRule', [SMART.token, SMART.curve, Kind.SellBelow, 1n, 1n, 1n, 1, 0, far]);
await reverts('3 active rules without the token', () => tx(other, 'createRule', [SMART.token, SMART.curve, Kind.SellBelow, 1n, 1n, 1n, 1, 0, far]), 'rule limit');
await tx(user, 'createRule', [SMART.token, SMART.curve, Kind.BuyBelow, parseEther('0.01'), pSmart * 2n, pSmart * 2n, 1, 0, (await pub.getBlock()).timestamp + 7200n]);
id = await lastRule();
await pub.request({ method: 'evm_increaseTime', params: [3 * 86400] }); await pub.request({ method: 'evm_mine', params: [] });
await reverts('an expired rule never fires', () => tx(keeper, 'execute', [BigInt(id)]), 'expired');
await reverts('the owner cannot change the fee sink to zero', () => tx(deployer, 'setFeeSink', ['0x0000000000000000000000000000000000000000']), 'no fee sink');
await reverts('strangers cannot touch admin settings', () => tx(other, 'setFeeSink', [other]), 'not owner');

// ---------------- non-ETH launches and plain v4 pools
const GF_CURVE = '0xcbc1514e14b8af33595be966641b4a0c0252a7d1', GF = '0xfed6b187f6da04e2eae5d3ea89b57129da62b28a';
await reverts('a Pons launch paired with USDG is refused', () => tx(user, 'createRule', [GF, GF_CURVE, Kind.BuyBelow, 1n, 1n, 1n, 1, 0, far]), 'only ETH-paired');
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', USDG_POOL = { fee: 0x800000, ts: 10, hooks: '0x06a889870c8f83640d6816319f72e2aa579b6080' };
await reverts('a pool that does not exist is refused', () => send(user, { ...hc, functionName: 'createRule', args: [toInput([USDG, ZERO, Kind.BuyBelow, 1n, 1n, 1n, 1, 0, far], { fee: 12345, ts: 77, hooks: ZERO })] }), 'pool not found');
const pUsdg = await read('poolPrice', [USDG, USDG_POOL.fee, USDG_POOL.ts, USDG_POOL.hooks]);
check('price of a plain v4 pool (ETH/USDG, third-party hook)', pUsdg > 0n);
await tx(user, 'deposit', [], parseEther('0.05'));
await send(user, { ...hc, functionName: 'createRule', args: [toInput([USDG, ZERO, Kind.BuyBelow, parseEther('0.02'), pUsdg * 2n, pUsdg * 3n / 2n, 1, 0, far], USDG_POOL)] });
id = await lastRule();
let uBefore = await tokBal(USDG, user);
await tx(keeper, 'execute', [BigInt(id)]);
const gotUsdg = (await tokBal(USDG, user)) - uBefore;
check('dip buy in a plain v4 pool (USDG)', gotUsdg > 0n, `${Number(gotUsdg) / 1e6} USDG`);
await send(user, { address: USDG, abi: erc20, functionName: 'approve', args: [HC, maxUint256] });
await send(user, { ...hc, functionName: 'createRule', args: [toInput([USDG, ZERO, Kind.SellAbove, gotUsdg, pUsdg / 2n, pUsdg / 2n, 1, 0, far], USDG_POOL)] });
id = await lastRule();
eBefore = await bal(user);
await tx(keeper, 'execute', [BigInt(id)]);
check('take profit in a plain v4 pool pays ETH', (await bal(user)) > eBefore && (await tokBal(USDG, user)) === uBefore, `${formatEther((await bal(user)) - eBefore)} ETH`);
check('rule remembers its pool', (await read('ruleKey', [BigInt(id)])).hooks.toLowerCase() === USDG_POOL.hooks);

// ---------------- holder perks (SMART stands in for the Hook Catch token here)
await tx(deployer, 'setCatchToken', [SMART.token]);
await reverts('the token can only be set once', () => tx(deployer, 'setCatchToken', [GOLEMITE.token]), 'already set');
const holderBal = await tokBal(SMART.token, user);
check('fee for a small holder', (await read('protocolFeeBps', [user])) === (holderBal >= parseEther('1000000') ? 0n : holderBal >= parseEther('100000') ? 10n : 20n), `${Number(formatEther(holderBal)).toLocaleString('en-US')} held`);
check('fee for a non-holder stays 0.20%', (await read('protocolFeeBps', [other])) === 20n);

// ---------------- withdraw
const dep = await read('deposits', [user]);
eBefore = await bal(user);
await tx(user, 'withdraw', [dep]);
check('user withdraws the whole deposit', (await read('deposits', [user])) === 0n && (await bal(user)) > eBefore, `${formatEther(dep)} ETH`);
await reverts('cannot withdraw more than deposited', () => tx(user, 'withdraw', [1n]), 'not enough deposited');
check('contract keeps no ETH beyond deposits', (await bal(HC)) === 0n, `${formatEther(await bal(HC))} ETH`);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
