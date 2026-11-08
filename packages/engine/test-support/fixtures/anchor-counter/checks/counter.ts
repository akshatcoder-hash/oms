import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
function decode(text: string): Buffer {
  let n = 0n;
  for (const char of text) { const digit = alphabet.indexOf(char); assert.ok(digit >= 0); n = n * 58n + BigInt(digit); }
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  assert.equal(n, 0n);
  return out;
}
let nextId = 0;
async function rpc(method: string, params: unknown[]) {
  const response = await fetch(process.env.SURFNET_RPC_URL!, {method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:++nextId,method,params})});
  const body = await response.json() as {error?:unknown;result:any};
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}

test('offline Anchor counter executes increment and updates the owned account', async () => {
  const program = 'Fg6PaFpoGXkYsidMpWxTWqkZSnL8W9pXz5HoWbapZkR';
  const pair = generateKeyPairSync('ed25519');
  const payer = Buffer.from((pair.publicKey.export({format:'jwk'}) as {x:string}).x,'base64url');
  const counter = createHash('sha256').update('oms-anchor-counter-fixture').digest();
  const data = Buffer.concat([createHash('sha256').update('account:Counter').digest().subarray(0,8),Buffer.alloc(8)]);
  const elf = await readFile('target/deploy/oms_anchor_counter.so');
  await rpc('surfnet_writeProgram',[program,elf.toString('hex'),0]);
  await rpc('surfnet_setAccount',[encode(payer),{lamports:100_000_000}]);
  await rpc('surfnet_setAccount',[encode(counter),{owner:program,lamports:10_000_000,data:data.toString('hex')}]);
  const latest = await rpc('getLatestBlockhash',[]);
  const ix = createHash('sha256').update('global:increment').digest().subarray(0,8);
  const message = Buffer.concat([Buffer.from([1,0,1,3]),payer,counter,decode(program),decode(latest.value.blockhash),Buffer.from([1,2,1,1,8]),ix]);
  const wire = Buffer.concat([Buffer.from([1]),sign(null,message,pair.privateKey),message]).toString('base64');
  const simulation = await rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:true}]);
  assert.equal(simulation.value.err,null,JSON.stringify(simulation));
  await rpc('sendTransaction',[wire,{encoding:'base64'}]);
  const account = await rpc('getAccountInfo',[encode(counter),{encoding:'base64'}]);
  assert.equal(account.value.owner,program);
  assert.equal(Buffer.from(account.value.data[0],'base64').readBigUInt64LE(8),1n);
});
