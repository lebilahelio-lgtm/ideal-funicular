import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Recovery,deliveryStatus} from '../recovery.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,bi TEXT,phone TEXT,active INTEGER,deleted_at TEXT); INSERT INTO users VALUES(1,'ana@example.com','009763932CA042','+244923456789',1,NULL)");
 let now=1000000;const recovery=new Recovery(db,()=>now);let sent;
 return {db,recovery,advance:ms=>now+=ms,send:async value=>{sent=value;},last:()=>sent};
}
test('six-digit recovery code, registered destination only, single use and expiry at 120 seconds',async()=>{
 const f=fixture();try{
  const r=await f.recovery.request('ana@example.com','email','ip',f.send);
  assert.match(f.last().code,/^\d{6}$/);assert.equal(f.last().user.email,'ana@example.com');assert.equal(r.expires_in,120);
  assert.equal(JSON.stringify(r).includes(f.last().code),false);
  assert.equal(f.db.prepare('SELECT code_hash FROM recoveries').get().code_hash.includes(f.last().code),false);
  f.advance(119999);assert.equal(f.recovery.verify(r.challenge,f.last().code,'ip'),1);
  assert.equal(f.recovery.verify(r.challenge,f.last().code,'ip'),null);
  const next=await f.recovery.request('009763932CA042','sms','ip',f.send);assert.equal(f.last().user.phone,'+244923456789');
  f.advance(120000);assert.equal(f.recovery.verify(next.challenge,f.last().code,'ip'),null);
 }finally{f.db.close();}
});
test('five wrong attempts block the code; resend invalidates previous codes',async()=>{
 const f=fixture();try{
  const first=await f.recovery.request('ana@example.com','email','ip',f.send),original=f.last().code;
  const wrong=original==='000000'?'111111':'000000';
  for(let i=0;i<5;i++)assert.equal(f.recovery.verify(first.challenge,wrong,'ip'),null);
  assert.equal(f.recovery.verify(first.challenge,original,'ip'),null);
  await assert.rejects(()=>f.recovery.request('ana@example.com','email','ip',f.send),{status:429});
  f.advance(60000);const second=await f.recovery.request('ana@example.com','email','ip',f.send);
  const code=f.last().code;f.advance(60000);await f.recovery.request('ana@example.com','email','ip',f.send);
  assert.equal(f.recovery.verify(second.challenge,code,'ip'),null);
 }finally{f.db.close();}
});
test('unknown accounts do not send; provider failure invalidates code; deleted users cannot recover',async()=>{
 const f=fixture();try{
  const unknown=await f.recovery.request('missing@example.com','email','ip',()=>assert.fail('Must not send'));
  assert.ok(unknown.challenge);assert.equal(f.recovery.verify(unknown.challenge,'000000','ip'),null);
  let code;
  await assert.rejects(()=>f.recovery.request('ana@example.com','email','ip',async v=>{code=v.code;throw Error('Provider failure');}));
  const row=f.db.prepare('SELECT token,used FROM recoveries WHERE user_id=1').get();assert.equal(row.used,1);assert.equal(f.recovery.verify(row.token,code,'ip'),null);
  f.advance(60000);const valid=await f.recovery.request('ana@example.com','sms','ip',f.send);
  f.db.prepare("UPDATE users SET deleted_at=CURRENT_TIMESTAMP,active=0").run();assert.equal(f.recovery.verify(valid.challenge,f.last().code,'ip'),null);
 }finally{f.db.close();}
});
test('request rate limit applies to unknown accounts too',async()=>{
 const f=fixture();try{
  for(let i=0;i<10;i++)await f.recovery.request(`missing${i}@example.com`,'email','ip',f.send);
  await assert.rejects(()=>f.recovery.request('another@example.com','email','ip',f.send),{status:429});
  f.advance(600000);assert.ok((await f.recovery.request('another@example.com','email','ip',f.send)).challenge);
  assert.equal(typeof deliveryStatus().email,'boolean');assert.equal(typeof deliveryStatus().sms,'boolean');
 }finally{f.db.close();}
});
