// Builds site/index.html from the template, embedding the contract ABI the app uses.
import { readFileSync, writeFileSync } from 'node:fs';
const abi = readFileSync(new URL('../contracts/build/abi-site.json', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.template.html', import.meta.url), 'utf8').replace('__ABI__', abi);
writeFileSync(new URL('./index.html', import.meta.url), html);
console.log('built site/index.html', Math.round(html.length / 1024), 'KB');
