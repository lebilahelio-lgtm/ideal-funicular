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
 return result;}
before(async()=>{
  const net=await import('node:net');const probe=net.createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(0,'127.0.0.1',r);});const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('Server exited '+code)));setTimeout(()=>reject(Error('Server timeout')),10000).unref();});
});
after(()=>{child?.kill();rmSync(dir,{recursive:true,force:true});});
test('system passwords require a new password before any shop access, including administrator resets',async()=>{
 const identity={name:'Ana Silva',bi:'009763932CA042',birth_date:'1990-01-01',email:'owner@gmail.com'};
 const setup=await request('setup',identity);
 owner=(await request('login',{identifier:identity.email,password:setup.body.password})).cookie;
 let state=(await request('state')).body;
 assert.equal(state.password_change_required,true);assert.equal(state.products,undefined);
 for(const path of ['products','sales','shifts/open','users','profile','sales/history'])assert.equal((await request(path,{})).status,403);
 assert.equal((await request('sales/1')).status,403);
 assert.equal((await request('password',{password:setup.body.password})).status,400);
 assert.equal((await request('password',{password:'weak'})).status,400);
 // Login again and refresh cannot bypass the persisted requirement.
 const other=(await request('login',{identifier:identity.bi,password:setup.body.password})).cookie;
 assert.equal((await request('state',undefined,other)).body.password_change_required,true);
 assert.equal((await request('password',{password:'MinhaNovaSenha123!'})).status,200);
 assert.equal((await request('state',undefined,other)).status,401);
 assert.equal((await request('state')).body.user.must_change_password,0);
 assert.equal((await request('login',{identifier:identity.email,password:setup.body.password})).status,401);
 owner=(await request('login',{identifier:identity.email,password:'MinhaNovaSenha123!'})).cookie;
 assert.equal((await request('state')).body.password_change_required,undefined);
 const staff=await request('users',{...identity,name:'João Silva',bi:'009763933CA042',email:'seller@gmail.com',role:'vendedor'});
 seller=(await request('login',{identifier:'seller@gmail.com',password:staff.body.password})).cookie;
 assert.equal((await request('state',undefined,seller)).body.password_change_required,true);
 assert.equal((await request('password',{password:'SenhaVendedor123!'},seller)).status,200);
 assert.equal((await request('shifts/open',{opening:0},seller)).status,200);
 const reset=await request('users/reset-password',{id:staff.body.id});
 assert.equal(reset.status,200);assert.equal((await request('state',undefined,seller)).status,401);
 seller=(await request('login',{identifier:'seller@gmail.com',password:reset.body.password})).cookie;
 assert.equal((await request('state',undefined,seller)).body.password_change_required,true);
 assert.equal((await request('shifts/close',{closing:0},seller)).status,403);
 assert.equal((await request('password',{password:'SenhaVendedorNova123!'},seller)).status,200);
 assert.equal((await request('shifts/close',{closing:0},seller)).status,200);
 const db=new DatabaseSync(join(dir,'loja.sqlite'));assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id=?').get(staff.body.id).must_change_password,0);db.close();
});
