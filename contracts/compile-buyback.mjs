// Compiles HookCatchBuyback.sol with solc 0.8.24 (optimizer 200, evm cancun) into build/HookCatchBuyback.json
// and HookCatchBuyback.standard-input.json (the exact input for verification).
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const input = {
  language: 'Solidity',
  sources: { 'HookCatchBuyback.sol': { content: readFileSync(new URL('./HookCatchBuyback.sol', import.meta.url), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === 'error')) process.exit(1);
const c = out.contracts['HookCatchBuyback.sol'].HookCatchBuyback;
mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
writeFileSync(new URL('./build/HookCatchBuyback.json', import.meta.url), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1));
writeFileSync(new URL('./HookCatchBuyback.standard-input.json', import.meta.url), JSON.stringify({ ...input, settings: { ...input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } }, null, 2));
console.log('compiled HookCatchBuyback, bytecode', c.evm.bytecode.object.length / 2, 'bytes');
writeFileSync(new URL('./launch.html', import.meta.url), readFileSync(new URL('./launch.template.html', import.meta.url), 'utf8').replace('__BUYBACK_BYTECODE__', '0x' + c.evm.bytecode.object));
console.log('wrote launch.html');
