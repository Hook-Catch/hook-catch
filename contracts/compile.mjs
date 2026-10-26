// Compiles HookCatch.sol with solc 0.8.24 (optimizer 200, evm cancun) into build/HookCatch.json and the Standard JSON input.
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const input = {
  language: 'Solidity',
  sources: { 'HookCatch.sol': { content: readFileSync(new URL('./HookCatch.sol', import.meta.url), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === 'error')) process.exit(1);
const c = out.contracts['HookCatch.sol'].HookCatch;
mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
writeFileSync(new URL('./build/HookCatch.json', import.meta.url), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1));
writeFileSync(new URL('./HookCatch.standard-input.json', import.meta.url), JSON.stringify({ ...input, settings: { ...input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } }, null, 2));
console.log('compiled, bytecode', c.evm.bytecode.object.length / 2, 'bytes, runtime', c.evm.deployedBytecode.object.length / 2);
writeFileSync(new URL('./deploy.html', import.meta.url), readFileSync(new URL('./deploy.template.html', import.meta.url), 'utf8').replace('__BYTECODE__', '0x' + c.evm.bytecode.object));
console.log('wrote deploy.html');
// the subset of the ABI the site embeds (site/build.mjs)
const SITE = ['RuleCancelled', 'RuleCreated', 'RuleExecuted', 'activeRules', 'canExecute', 'cancelRule', 'catchToken', 'createRule', 'deposit', 'deposits', 'execute', 'feeSink', 'getRules', 'poolPrice', 'priceOf', 'protocolFeeBps', 'ruleKey', 'rulesCount', 'withdraw'];
writeFileSync(new URL('./build/abi-site.json', import.meta.url), JSON.stringify(c.abi.filter((x) => SITE.includes(x.name))));
