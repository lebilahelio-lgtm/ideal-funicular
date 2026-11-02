import { DatabaseSync } from 'node:sqlite';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'loja-test-'));
let child, base, owner='', seller='';
async function request(path,data,cookie=owner){
 if(path==='stock'&&data&&!data.supplier_id){const fixture=new DatabaseSync(join(dir,'loja.sqlite'));fixture.exec("INSERT OR IGNORE INTO partners(id,name,kind,phone,email,location) VALUES(1,'Fornecedor de Teste','fornecedor','923456789','teste@example.com','Luanda')");fixture.close();data={...data,supplier_id:1};}
 if(path==='shifts/open'&&data){const fixture=new DatabaseSync(join(dir,'loja.sqlite'));for(let n=1;n<=10;n++)fixture.prepare('INSERT OR IGNORE INTO registers(number,name) VALUES(?,?)').run(n,'Balcão '+n);fixture.close();const pins=await request('account/pin',undefined,cookie),registers=await request('registers',undefined,cookie);data={...data,pin:pins.body.code,register_id:registers.body.registers?.find(r=>!r.shift_id)?.id};}
const r=await fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});const result={status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 // These business-flow fixtures represent accounts that completed initial onboarding.
 // The mandatory password transition is exercised without this fixture in first-login.test.js.
 if(r.ok&&['setup','users','users/reset-password'].includes(path)&&result.body.password){const fixture=new DatabaseSync(join(dir,'loja.sqlite'));fixture.prepare('UPDATE users SET must_change_password=0 WHERE email=?').run(result.body.email);fixture.close();}
 return result;}
before(async()=>{
  const net=await import('node:net');const probe=net.createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(0,'127.0.0.1',r);});const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('Server exited '+code)));setTimeout(()=>reject(Error('Server timeout')),10000).unref();});
});
after(()=>{child?.kill();rmSync(dir,{recursive:true,force:true});});
test('history isolates seller cash registers and filters all leadership history before pagination',async()=>{
 const identity={name:'Ana Silva',bi:'009763932CA042',birth_date:'1990-01-01',email:'owner@gmail.com'};
 const setup=await request('setup',identity);
 owner=(await request('login',{identifier:identity.email,password:setup.body.password})).cookie;
 const actors=[];
 for(const [name,email,bi,role] of [['Maria Silva','manager@gmail.com','009763933CA042','gerente'],['João Silva','seller@gmail.com','009763934CA042','vendedor'],['Pedro Silva','other@gmail.com','009763935CA042','vendedor']]){
  const created=await request('users',{...identity,name,email,bi,role});
  actors.push({id:created.body.id,cookie:(await request('login',{identifier:email,password:created.body.password})).cookie});
 }
 const [mgr,a,b]=actors;
 const product=await request('products',{name:'Arroz',category:'Alimentares',unit:'kg',minimum:1,pack_type:'Saco',pack_size:100,pack_cost:500,price:100,sale_enabled:true});
 await request('stock',{product_id:product.body.id,packs:2,reason:'Teste'});
 const sale={items:[{product_id:product.body.id,quantity:1}],discount:0,paid:100,method:'dinheiro'};
 const receipts=[];
 for(const cookie of [owner,mgr.cookie,a.cookie,b.cookie]){
  assert.equal((await request('shifts/open',{opening:0},cookie)).status,200);
  const r=await request('sales',sale,cookie);assert.equal(r.status,200);receipts.push(r.body);
  await request('shifts/close',{closing:100},cookie);
 }
 await request('shifts/open',{opening:0},a.cookie);
 const next=await request('sales',{...sale,method:'tpa'},a.cookie);assert.equal(next.status,200);
 const own=await request('sales/history',{},a.cookie);
 assert.equal(own.body.summary.count,2);assert.ok(own.body.sales.every(s=>s.user_id===a.id));assert.deepEqual(own.body.sellers,[]);
 assert.notEqual(own.body.sales[0].shift_id,own.body.sales[1].shift_id);
 for(const scope of ['all',String(b.id),String(a.id)])assert.equal((await request('sales/history',{scope},a.cookie)).status,403);
 assert.equal((await request('sales/'+receipts[3].id,undefined,a.cookie)).status,403);
 assert.equal((await request('sales/'+receipts[2].id,undefined,a.cookie)).status,200);
 assert.equal((await request('sales/history',{shift_id:receipts[3].shift_id},a.cookie)).body.summary.count,0);
 assert.equal((await request('state',undefined,a.cookie)).body.sales.length,2);
 assert.equal((await request('sales/history',{scope:'all'},mgr.cookie)).body.summary.count,5);
 assert.equal((await request('sales/history',{scope:'mine'},mgr.cookie)).body.summary.count,1);
 assert.equal((await request('sales/history',{scope:String(a.id)},mgr.cookie)).body.summary.count,2);
 assert.equal((await request('sales/history',{scope:'mine'})).body.summary.count,1);
 assert.equal((await request('sales/history',{method:'tpa'})).body.summary.count,1);
 assert.equal((await request('sales/history',{q:'00001'})).body.sales[0].id,receipts[0].id);
 assert.equal((await request('sales/history',{q:'Maria',search_by:'seller'})).body.summary.count,1);
 assert.equal((await request('sales/history',{q:'Maria',search_by:'customer'})).body.summary.count,0);
 assert.equal((await request('sales/history',{q:'Consumidor',search_by:'customer'})).body.summary.count,5);
 assert.equal((await request('sales/history',{search_by:'invalid'})).status,400);
 assert.equal((await request('sales/history',{start:'2000-01-02',end:'2000-01-01'})).status,400);
 assert.equal((await request('sales/history',{start:'2000-02-30'})).status,400);
 assert.equal((await request('sales/history',{scope:'bad'})).status,400);
 assert.equal((await request('sales/history',{page:0})).status,400);
 // Filters run over the full database, not only the last 100 loaded receipts.
 const db=new DatabaseSync(join(dir,'loja.sqlite'));
 for(let i=0;i<105;i++)db.prepare("INSERT INTO sales(user_id,shift_id,created,customer,subtotal,discount,total,paid,change_due,method) VALUES(?,?,'2020-01-01 23:30:00','Arquivo',10000,0,10000,10000,0,'dinheiro')").run(1,receipts[0].shift_id);
 db.close();
 const general=await request('sales/history',{});
 assert.equal(general.body.summary.count,110);assert.equal(general.body.summary.total,1100000);assert.equal(general.body.sales.length,50);assert.equal(general.body.pages,3);
 const last=await request('sales/history',{page:3});assert.equal(last.body.sales.length,10);
 assert.equal((await request('sales/history',{start:'2020-01-02',end:'2020-01-02'})).body.summary.count,105); // Angola UTC+1.
 assert.equal((await request('sales/history',{scope:String(a.id)},mgr.cookie)).body.summary.count,2);
 assert.equal((await request('users/remove',{id:b.id})).status,200);
 const archive=await request('sales/history',{scope:String(b.id)},mgr.cookie);
 assert.equal(archive.body.summary.count,1);assert.ok(archive.body.sellers.find(u=>u.id===b.id).deleted_at);
 assert.equal(archive.body.sellers.find(u=>u.id===a.id).email,undefined);
 const noHistory=await request('users/access',{id:a.id,role:'vendedor',active:true,permissions:{history:false}});
 assert.equal(noHistory.status,200);
 // Existing session is revoked, and a new authenticated session is denied by the permission check.
 assert.equal((await request('sales/history',{},a.cookie)).status,401);
 const password=await request('users/reset-password',{id:a.id});
 const logged=(await request('login',{identifier:'seller@gmail.com',password:password.body.password})).cookie;
 assert.equal((await request('sales/history',{},logged)).status,403);
});
