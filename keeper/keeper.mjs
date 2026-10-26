// Hook Catch keeper: finds rules whose line has been crossed and executes them for the 0.30% keeper fee.
//
//   KEEPER_KEY=0x...  HOOKCATCH=0x...  node keeper.mjs
//
// Optional env:
//   RPC         JSON-RPC url (default: public Robinhood Chain RPC)
//   INTERVAL    seconds between scans (default 20)
//   MIN_PROFIT  only send when fee >= gas cost x this (default 1.2; 0 = execute everything)
//   DRY_RUN     1 = print what would run, send nothing
//   ONCE        1 = one scan, then exit
import { createPublicClient, createWalletClient, http, defineChain, formatEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const env = process.env;
const RPC = env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const INTERVAL = Number(env.INTERVAL || 20) * 1000;
const MIN_PROFIT = Number(env.MIN_PROFIT ?? 1.2);
const DRY = env.DRY_RUN === '1';
const KEEPER_BPS = 30n;
if (!env.HOOKCATCH) throw new Error('set HOOKCATCH to the Hook Catch contract address');
if (!DRY && !env.KEEPER_KEY) throw new Error('set KEEPER_KEY (a fresh wallet with a little ETH for gas), or DRY_RUN=1');
const HC = getAddress(env.HOOKCATCH);

const chain = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const account = env.KEEPER_KEY ? privateKeyToAccount(env.KEEPER_KEY) : null;
const wallet = account ? createWalletClient({ account, chain, transport: http(RPC) }) : null;

const RULE = [
  { name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'curve', type: 'address' }, { name: 'hooks', type: 'address' },
  { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'kind', type: 'uint8' }, { name: 'active', type: 'bool' },
  { name: 'runsLeft', type: 'uint32' }, { name: 'interval', type: 'uint32' }, { name: 'nextAt', type: 'uint40' }, { name: 'expiry', type: 'uint40' },
  { name: 'amount', type: 'uint128' }, { name: 'trigger', type: 'uint128' }, { name: 'limit', type: 'uint128' },
];
const ABI = [
  { type: 'function', name: 'rulesCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getRules', stateMutability: 'view', inputs: [{ name: 'from', type: 'uint256' }, { name: 'to', type: 'uint256' }], outputs: [{ type: 'tuple[]', components: RULE }] },
  { type: 'function', name: 'canExecute', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'bool' }, { type: 'string' }] },
  { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
];
const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const KINDS = ['take profit', 'stop loss', 'buy the dip', 'DCA'];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const read = (functionName, args = []) => pub.readContract({ address: HC, abi: ABI, functionName, args });

// rough ETH size of the trade, for the fee estimate (sells: tokens the contract can pull x the limit price)
async function tradeEth(r) {
  if (r.kind >= 2) return r.amount;
  const [bal, allow] = await Promise.all([
    pub.readContract({ address: r.token, abi: ERC20, functionName: 'balanceOf', args: [r.owner] }),
    pub.readContract({ address: r.token, abi: ERC20, functionName: 'allowance', args: [r.owner, HC] }),
  ]);
  let amt = r.amount; if (bal < amt) amt = bal; if (allow < amt) amt = allow;
  return (amt * r.limit) / 10n ** 18n;
}

async function scan() {
  const n = Number(await read('rulesCount'));
  const rules = [];
  for (let i = 0; i < n; i += 200) rules.push(...(await read('getRules', [BigInt(i), BigInt(Math.min(n, i + 200))])).map((r, j) => ({ ...r, id: BigInt(i + j) })));
  const now = BigInt((await pub.getBlock()).timestamp);
  const open = rules.filter((r) => r.active && now <= BigInt(r.expiry) && now >= BigInt(r.nextAt));
  let sent = 0;
  for (const r of open) {
    const [ok] = await read('canExecute', [r.id]);
    if (!ok) continue;
    const fee = ((await tradeEth(r)) * KEEPER_BPS) / 10000n;
    let gas, price;
    try {
      [gas, price] = await Promise.all([pub.estimateContractGas({ address: HC, abi: ABI, functionName: 'execute', args: [r.id], account: account?.address ?? r.owner }), pub.getGasPrice()]);
    } catch (e) { log(`#${r.id} would revert: ${e.shortMessage || e.message}`); continue; }
    const cost = gas * price;
    const what = `#${r.id} ${KINDS[r.kind]} · fee ~${formatEther(fee)} ETH · gas ~${formatEther(cost)} ETH`;
    if (MIN_PROFIT > 0 && Number(fee) < Number(cost) * MIN_PROFIT) { log('skip (not worth gas)', what); continue; }
    if (DRY) { log('would execute', what); continue; }
    try {
      const hash = await wallet.writeContract({ address: HC, abi: ABI, functionName: 'execute', args: [r.id], gas: (gas * 12n) / 10n });
      const rc = await pub.waitForTransactionReceipt({ hash });
      log(rc.status === 'success' ? 'executed' : 'FAILED', what, hash);
      sent++;
    } catch (e) { log(`#${r.id} send failed: ${e.shortMessage || e.message}`); }
  }
  log(`scanned ${n} rules · ${open.length} open · ${sent} executed`);
}

log(`Hook Catch keeper · contract ${HC} · ${account ? 'keeper ' + account.address : 'dry run'}`);
for (;;) {
  try { await scan(); } catch (e) { log('scan error:', e.shortMessage || e.message); }
  if (env.ONCE === '1') break;
  await new Promise((r) => setTimeout(r, INTERVAL));
}
