import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MessengerSnapshot, parseWireJson, packetObjects} from '../dist/facebook/lightspeed.js';
import {buildCurlConfig, postWithCurl, parseGraphqlResponse} from '../dist/facebook/transport.js';
import {FacebookClient} from '../dist/facebook/client.js';
import {validateFacebookId} from '../dist/facebook/messenger.js';
import {createStartSellerThreadHandler, createSendThreadMessageHandler} from '../dist/tools/messages.js';

const i64 = n => [19, String(n)];
const operation = (name, ...args) => [5, name, ...args];
function ingest(state, ...ops) {state.ingestPacket(JSON.stringify({payload: JSON.stringify({step: [1, ...ops]})}));}
function thread(id='101', parent='-12', time=1000, group='1') {
  const a = Array.from({length: 90}, () => [9]);
  a[0]=i64(time);a[1]=i64(time-1);a[2]='Synthetic preview';a[3]='Synthetic listing';
  a[7]=i64(id);a[9]=i64(5);a[10]='inbox';a[35]=i64(parent);a[66]=i64(group);a[89]=i64(2);
  return operation('deleteThenInsertThread',...a);
}
function message(id='mid.1',tid='101',time=1000,text='Synthetic message',offline='501',sender='42') {
  const a=Array.from({length:18},()=>[9]);
  a[0]=text;a[3]=i64(tid);a[5]=i64(time);a[8]=id;a[9]=offline;a[10]=i64(sender);a[17]=false;
  return operation('upsertMessage',...a);
}
const folder = () => operation('upsertSyncGroupThreadsRange',i64(1),i64(-12),i64(1),false,false,i64(0));
function outgoing(state,tid='101',text='hello',otid='501') {
  state.ingestPacket(JSON.stringify({payload:JSON.stringify({tasks:[{label:'46',payload:JSON.stringify({thread_id:tid,text,otid})}]})}),true);
}

test('64-bit identifiers are not rounded; text is unchanged',()=>{
  const data=parseWireJson('{"id":9223372036854775807,"text":"9223372036854775807","decimal":1.5}');
  assert.equal(data.id,'9223372036854775807');assert.equal(data.text,'9223372036854775807');assert.equal(data.decimal,1.5);
});
test('binary envelopes and multiple JSON objects are decoded',()=>{
  const result=packetObjects(Buffer.concat([Buffer.from([0,255,1]),Buffer.from('{"x":"brace } here"}\u0000{"y":2}')]));
  assert.deepEqual(result,[{x:'brace } here'},{y:2}]);
});
test('missing data never becomes an empty inbox',()=>{
  const s=new MessengerSnapshot();s.ingestPacket('{"payload":[]}');
  assert.throws(()=>s.marketplaceThreads(20),/not an empty inbox/);
});
test('a confirmed empty Marketplace folder is distinguishable',()=>{
  const s=new MessengerSnapshot();ingest(s,folder());assert.deepEqual(s.marketplaceThreads(20),[]);
});
test('Marketplace folder is selected instead of the generic inbox',()=>{
  const s=new MessengerSnapshot();ingest(s,folder(),thread('101'),thread('102','0'),thread('103','-12',2000));
  assert.deepEqual(s.marketplaceThreads(1).map(t=>t.id),['103']);
});
test('messages are isolated, deduplicated, ordered and limited',()=>{
  const s=new MessengerSnapshot();ingest(s,thread(),message('mid.2','101',2000),message('other','102',2500),message('mid.1','101',1000),message('mid.2','101',2000));
  assert.deepEqual(s.threadMessages('101',1).map(m=>m.id),['mid.2']);
});
test('unknown threads do not return false empty history',()=>{
  assert.throws(()=>new MessengerSnapshot().threadMessages('999',20),/not returned/);
});
test('encrypted histories fail explicitly',()=>{
  const s=new MessengerSnapshot();ingest(s,thread('101','-12',1000,'95'));
  assert.throws(()=>s.threadMessages('101',20),/end-to-end encrypted/);
});
test('participant names are resolved from the actual thread',()=>{
  const s=new MessengerSnapshot();s.accountId='42';
  ingest(s,folder(),thread(),operation('addParticipantIdToGroupThread',i64(101),i64(43)),operation('verifyContactRowExists',i64(43),i64(0),'','Synthetic seller'));
  assert.deepEqual(s.marketplaceThreads(1)[0].participantNames,['Synthetic seller']);
});
test('HTML parses only Lightspeed payloads, not user-authored JSON text',()=>{
  const s=new MessengerSnapshot();
  s.ingestHtml('<script type="application/json">'+JSON.stringify({comment:JSON.stringify({step:[1,folder(),thread()]})})+'</script>');
  assert.equal(s.payloadCount,0);
});
test('message text cannot inject a server acknowledgement',()=>{
  const s=new MessengerSnapshot();outgoing(s);
  const attack=JSON.stringify({step:[1,operation('replaceOptimsiticMessage','501','mid.fake')]});
  ingest(s,message('mid.incoming','101',1000,attack,'600','43'));
  assert.equal(s.receipt('101','hello',0),undefined);
});
test('task removal is not proof that a message was delivered',()=>{
  const s=new MessengerSnapshot();outgoing(s);ingest(s,operation('taskExists',i64(1)),operation('removeTask',i64(1)));
  assert.equal(s.receipt('101','hello',0),undefined);
});
test('send acknowledgements must match the exact outgoing ID and target',()=>{
  const s=new MessengerSnapshot();outgoing(s);
  ingest(s,operation('replaceOptimsiticMessage','999','mid.unrelated'));
  assert.equal(s.receipt('101','hello',0),undefined);
  ingest(s,operation('replaceOptimsiticMessage','501','mid.confirmed'));
  assert.deepEqual(s.receipt('101','hello',0),{threadId:'101',messageId:'mid.confirmed'});
  assert.equal(s.receipt('102','hello',0),undefined);assert.equal(s.receipt('101','other text',0),undefined);
});
test('explicit failures override acknowledgement candidates',()=>{
  const s=new MessengerSnapshot();outgoing(s);ingest(s,operation('replaceOptimsiticMessage','501','mid.confirmed'),operation('markOptimisticMessageFailed','501','failed'));
  assert.throws(()=>s.receipt('101','hello',0),/rejected/);
});
test('confirmed server message is a correlated acknowledgement',()=>{
  const s=new MessengerSnapshot();s.accountId='42';outgoing(s);ingest(s,message('mid.confirmed','101',2000,'hello','501'));
  assert.deepEqual(s.receipt('101','hello',1999),{threadId:'101',messageId:'mid.confirmed'});
  assert.equal(s.receipt('101','hello',2001),undefined);
});
test('ID validation rejects routes, negatives, zero and overflow',()=>{
  for(const id of ['../other','0','-1','1?x=y','9223372036854775808'])assert.throws(()=>validateFacebookId(id));
  assert.doesNotThrow(()=>validateFacebookId('9223372036854775807'));
});
test('curl configuration rejects header and file-input injection',()=>{
  assert.throws(()=>buildCurlConfig('https://example.test',{'X-Test':'x\r\nInjected: y'},'a=b'));
  assert.throws(()=>buildCurlConfig('https://example.test',{},'@private-file'));
});
test('curl credentials are sent on stdin, not command arguments',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'marketplace-test-'));const binary=path.join(dir,'curl-test');
  try {
    await fs.writeFile(binary,'#!/usr/bin/env node\nlet x="";process.stdin.on("data",c=>x+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),config:x})+"\\n200"));',{mode:0o700});
    const r=await postWithCurl(binary,'https://example.test',{'Cookie':'synthetic-canary'},'body=synthetic');
    const observed=JSON.parse(r.text);assert.deepEqual(observed.args,['--config','-']);assert.match(observed.config,/synthetic-canary/);assert.equal(r.status,200);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('subprocess failures cannot echo sensitive stderr',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'marketplace-test-'));const binary=path.join(dir,'curl-test');
  try {
    await fs.writeFile(binary,'#!/usr/bin/env node\nconsole.error("synthetic-sensitive-canary");process.exit(7);',{mode:0o700});
    await assert.rejects(postWithCurl(binary,'https://example.test',{},'a=b'),e=>!/canary/.test(e.message)&&/transport failed/.test(e.message));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('HTTP-200 GraphQL errors and missing data fail closed',()=>{
  for(const raw of ['{"error":1357054}','{"errors":[{"message":"private canary"}],"data":{}}','{"payload":[]}','<html>private canary</html>']){
    assert.throws(()=>parseGraphqlResponse(raw),e=>!/canary/.test(e.message));
  }
  assert.deepEqual(parseGraphqlResponse('for (;;);{"data":{"ok":true}}'),{data:{ok:true}});
});
test('client delegates both read paths to modern transport',async()=>{
  const c=new FacebookClient();const calls=[];
  c.messenger={checkMessages:async n=>{calls.push(['check',n]);return [];},readThread:async(id,n)=>{calls.push(['read',id,n]);return [];}};
  await c.checkMessages(4);await c.getMessageThread('101',8);assert.deepEqual(calls,[['check',4],['read','101',8]]);
});
test('first contact requires a listing and matching seller',async()=>{
  const c=new FacebookClient();let calls=0;c.getListingDetail=async()=>({seller:{id:'43'}});c.messenger={startSellerThread:async()=>{calls++;}};
  await assert.rejects(c.sendSellerMessage({sellerId:'42',message:'hello'}),/listing_id/);
  await assert.rejects(c.sendSellerMessage({sellerId:'42',listingId:'101',message:'hello'}),/does not match/);
  assert.equal(calls,0);
});
test('first contact passes verified listing context to sender',async()=>{
  const c=new FacebookClient();c.getListingDetail=async()=>({seller:{id:'43'}});let received;
  c.messenger={startSellerThread:async(...args)=>{received=args;return {threadId:'101',messageId:'mid.1'};}};
  await c.sendSellerMessage({sellerId:'43',listingId:'201',message:' hello '});assert.deepEqual(received,['201','43','hello']);
});
test('client rejects ambiguous recipients and empty text',async()=>{
  const c=new FacebookClient();
  await assert.rejects(c.sendSellerMessage({sellerId:'42',threadId:'101',message:'hello'}),/exactly one/);
  await assert.rejects(c.sendSellerMessage({threadId:'101',message:'  '}),/characters/);
});
test('uncertain sends are returned as errors and never automatically retried',async()=>{
  let count=0;
  const handler=createSendThreadMessageHandler({sendSellerMessage:async()=>{count++;throw new Error('Send outcome is unknown.');}});
  const r=await handler({thread_id:'101',message:'hello'});assert.equal(r.isError,true);assert.equal(count,1);assert.match(r.content[0].text,/unknown/);
});
test('tool forwards listing ID rather than silently dropping it',async()=>{
  let received;const handler=createStartSellerThreadHandler({sendSellerMessage:async args=>{received=args;return {threadId:'101',messageId:'mid.1'};}});
  await handler({seller_id:'43',listing_id:'201',message:'hello'});assert.equal(received.listingId,'201');
});


test('first-contact schema requires the listing context used by the client',async()=>{
  const {startSellerThreadSchema}=await import('../dist/tools/messages.js');
  assert.equal(startSellerThreadSchema.listing_id.safeParse(undefined).success,false);
  assert.equal(startSellerThreadSchema.listing_id.safeParse('201').success,true);
});
