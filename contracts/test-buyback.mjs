// Tests HookCatchBuyback on a local fork of Robinhood Chain (npx hardhat node --config hardhat.config.cjs),
// alone and wired as the HookCatch fee sink. Run: node test-buyback.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, encodeDeployData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = 'http://127.0.0.1:8545';
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const BB = JSON.parse(readFileSync(new URL('./build/HookCatchBuyback.json', import.meta.url), 'utf8'));
const HCJ = JSON.parse(readFileSync(new URL('./build/HookCatch.json', import.meta.url), 'utf8'));

const SEASON = { token: '0xea0071a8778fa02c12378e88868255e0e0952be6', curve: '0xdee6768c2b75253dec9bf7769022b145a72d49d2' }; // on its curve
const GOLEMITE = { token: '0x3d9f1a6faf2e290eea620cb95f61bd9902397375', curve: null }; // graduated to v4
GOLEMITE.curve = (await (await fetch('https://ponsfamily.com/api/launches/' + GOLEMITE.token)).json()).curve;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const ZERO = '0x0000000000000000000000000000000000000000';
const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };
async function reverts(name, fn, match) {
  try { await fn(); check(name, false, 'did not revert'); }
  catch (e) { const msg = [e.shortMessage, e.message, e.details, e.cause?.reason, e.cause?.details, e.cause?.cause?.details].filter(Boolean).join(' '); check(name, msg.includes(match), msg.includes(match) ? `reverted: ${match}` : msg.slice(0, 160)); }
}

const wallets = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()));
for (const a of wallets) await pub.request({ method: 'hardhat_setBalance', params: [a.address, '0x' + parseEther('100').toString(16)] });
const byAddr = new Map(wallets.map((a) => [a.address, a]));
const [deployer, user, keeper] = wallets.map((a) => a.address);
const w = (a) => createWalletClient({ account: byAddr.get(a), chain, transport: http(RPC) });
const wait = async (hash) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('tx failed'); return r; };
const deploy = async (j, args) => (await wait(await w(deployer).deployContract({ abi: j.abi, bytecode: j.bytecode, args, chain }))).contractAddress;
const call = (address, abi, functionName, args = [], from = keeper, value) => w(from).writeContract({ address, abi, functionName, args, value, chain }).then(wait);
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const dead = (t) => read(t, erc20, 'balanceOf', [DEAD]);
const fund = (to, eth) => w(user).sendTransaction({ to, value: parseEther(eth), chain }).then(wait);
const MIN = parseEther('0.003'), MAX = parseEther('0.05');

// ---------------- on the curve
const bbS = await deploy(BB, [SEASON.token, SEASON.curve, 0, 200, MIN, MAX]);
await reverts('no buyback below minBuy', () => call(bbS, BB.abi, 'buyback'), 'not enough ETH yet');
await fund(bbS, '0.002');
check('receiving ETH does not trigger anything', (await read(bbS, BB.abi, 'pending')) === parseEther('0.002') && !(await read(bbS, BB.abi, 'ready')));
await fund(bbS, '0.08');
let before = await dead(SEASON.token);
await call(bbS, BB.abi, 'buyback');
let burned = (await dead(SEASON.token)) - before;
check('curve buyback burns tokens', burned > 0n, `${Number(formatEther(burned)).toLocaleString('en-US')} SEASON to 0xdead`);
check('a buyback spends at most maxBuy', (await read(bbS, BB.abi, 'pending')) === parseEther('0.032'), `${formatEther(await read(bbS, BB.abi, 'pending'))} ETH left`);
check('totals are tracked', (await read(bbS, BB.abi, 'totalBurned')) === burned && (await read(bbS, BB.abi, 'buybacks')) === 1n);
check('the contract keeps no tokens', (await read(SEASON.token, erc20, 'balanceOf', [bbS])) === 0n);
await call(bbS, BB.abi, 'buyback');
check('the rest goes in the next buyback', (await read(bbS, BB.abi, 'pending')) === 0n && (await read(bbS, BB.abi, 'buybacks')) === 2n);

// ---------------- graduated: the curve refuses, the v4 pool is used
const bbG = await deploy(BB, [GOLEMITE.token, GOLEMITE.curve, 0, 200, MIN, MAX]);
await fund(bbG, '0.01');
before = await dead(GOLEMITE.token);
const r = await call(bbG, BB.abi, 'buyback');
burned = (await dead(GOLEMITE.token)) - before;
check('pool buyback burns tokens after graduation', burned > 0n, `${Number(formatEther(burned)).toLocaleString('en-US')} GOLEMITE to 0xdead, gas ${r.gasUsed}`);
check('nothing left behind after a pool buyback', (await read(bbG, BB.abi, 'pending')) === 0n && (await read(GOLEMITE.token, erc20, 'balanceOf', [bbG])) === 0n);

const simDeploy = (args) => pub.call({ account: deployer, data: encodeDeployData({ abi: BB.abi, bytecode: BB.bytecode, args }) });
await reverts('constructor rejects bad limits', () => simDeploy([SEASON.token, SEASON.curve, 0, 200, MAX, MIN]), 'bad limits');
await reverts('constructor rejects a zero token', () => simDeploy([ZERO, SEASON.curve, 0, 200, MIN, MAX]), 'zero address');

// ---------------- wired into HookCatch as the fee sink
const HC = await deploy(HCJ, [deployer]);
await call(HC, HCJ.abi, 'setFeeSink', [bbS], deployer);
check('HookCatch fee sink points at the buyback', (await read(HC, HCJ.abi, 'feeSink')).toLowerCase() === bbS.toLowerCase());
const [price] = await read(HC, HCJ.abi, 'priceOf', [SEASON.token, SEASON.curve]);
await call(HC, HCJ.abi, 'deposit', [], user, parseEther('1'));
const now = (await pub.getBlock()).timestamp;
await call(HC, HCJ.abi, 'createRule', [{ token: SEASON.token, curve: SEASON.curve, poolFee: 0, tickSpacing: 0, hooks: ZERO, kind: 2, amount: parseEther('0.5'), trigger: price * 2n, limit: price * 3n, runs: 1, interval: 0, expiry: now + 86400n }], user);
const p0 = await read(bbS, BB.abi, 'pending');
const ex = await call(HC, HCJ.abi, 'execute', [0n]);
const fee = (await read(bbS, BB.abi, 'pending')) - p0;
check('executing a rule pays the protocol fee into the buyback', fee === parseEther('0.001'), `${formatEther(fee)} ETH (0.20% of 0.5), execute gas ${ex.gasUsed}`);
await fund(bbS, '0.01');
before = await dead(SEASON.token);
await call(bbS, BB.abi, 'buyback');
check('the collected fees buy and burn the token', (await dead(SEASON.token)) > before);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
