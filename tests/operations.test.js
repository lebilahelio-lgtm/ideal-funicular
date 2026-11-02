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
test('physical registers, private rotating PINs, warehouse roles, FIFO lots, partners and immutable cancellations',async()=>{
 const identity={name:'Ana Silva',bi:'009763932CA042',birth_date:'1990-01-01',email:'owner@gmail.com'};
 const created=await request('setup',identity);owner=(await request('login',{identifier:identity.email,password:created.body.password})).cookie;
 let seq=100;
 async function person(profile,email){const r=await request('users',{...identity,name:'Pessoa Teste',bi:String(++seq).padStart(9,'0')+'CA042',email,role:profile});assert.equal(r.status,200);return {id:r.body.id,password:r.body.password,cookie:(await request('login',{identifier:email,password:r.body.password})).cookie};}
 const mgr=await person('gerente','manager@gmail.com'),responsible=await person('responsavel_armazem','responsible@gmail.com'),worker=await person('armazem','worker@gmail.com'),a=await person('vendedor','seller@gmail.com'),b=await person('vendedor','other@gmail.com'),cashLead=await person('responsavel_caixa','cashlead@gmail.com');
 const code=async actor=>(await request('account/pin',undefined,actor.cookie)).body.code;
 let apin=await code(a),bpin=await code(b);assert.match(apin,/^\d{4}$/);assert.notEqual(apin,bpin);
 assert.equal((await request('cash/pins',undefined,a.cookie)).status,403);assert.equal((await request('cash/pins',undefined,mgr.cookie)).status,403);
 assert.equal((await request('users/access',{id:mgr.id,role:'gerente',active:true,permissions:{view_all_pins:true}})).status,200);
 mgr.cookie=(await request('login',{identifier:'manager@gmail.com',password:mgr.password})).cookie;
 assert.equal((await request('cash/pins',undefined,mgr.cookie)).status,200);
 const ownerPins=await request('cash/pins');assert.equal(new Set(ownerPins.body.pins.map(p=>p.code)).size,ownerPins.body.pins.length);
 const db=new DatabaseSync(join(dir,'loja.sqlite'));db.prepare('UPDATE cash_pins SET expires_at=? WHERE user_id=?').run(Date.now()-1,a.id);
 const rotated=await code(a);assert.notEqual(rotated,apin);apin=rotated;
 assert.notEqual(db.prepare('SELECT cipher FROM cash_pins WHERE user_id=?').get(a.id).cipher,apin);
 assert.equal((await request('registers/config',{count:2})).status,200);
 const regs=(await request('registers',undefined,a.cookie)).body.registers;
 const open=(actor,pin,id)=>request('shifts/open',{opening:500,register_id:id,pin},actor.cookie);
 for(let n=0;n<5;n++)assert.equal((await open(a,apin==='0000'?'1111':'0000',regs[0].id)).status,403);
 assert.equal((await open(a,apin,regs[0].id)).status,429);
 db.prepare('UPDATE cash_pins SET blocked_until=0,failures=0 WHERE user_id=?').run(a.id);
 const races=await Promise.all([open(a,apin,regs[0].id),open(b,bpin,regs[0].id)]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
 const first=races[0].status===200?a:b,second=first===a?b:a;
 assert.equal((await open(second,second===a?apin:bpin,regs[1].id)).status,200);
 assert.equal((await request('registers/config',{count:1})).status,400);
 const occupied=(await request('registers',undefined,a.cookie)).body.registers;assert.ok(occupied.every(r=>r.operator&&r.shift_id));
 assert.equal((await request('products',{name:'Negado'},worker.cookie)).status,403);
 assert.equal((await request('partners',undefined,worker.cookie)).status,403);
 const supplier=await request('suppliers',{name:'Fornecedor Alfa',phone:'923456789',email:'compras@empresa.ao',location:'Luanda'},worker.cookie);assert.equal(supplier.status,200);
 const names=(await request('suppliers',undefined,worker.cookie)).body.suppliers;assert.deepEqual(Object.keys(names[0]).sort(),['id','name']);
 assert.equal((await request('partners',{name:'Negado'},worker.cookie)).status,403);
 const partner=await request('partners',{name:'Parceiro Banco',kind:'outro',phone:'923456789',email:'contacto@banco.ao',location:'Luanda'});assert.equal(partner.status,200);
 assert.equal((await request('suppliers',undefined,worker.cookie)).body.suppliers.length,1);
 const p=await request('products',{name:'Arroz',category:'Alimentares',unit:'kg',minimum:1,pack_type:'Saco',pack_size:1,pack_cost:50,price:100,expiry_required:true,expiry_warning_days:10},responsible.cookie);assert.equal(p.status,200);
 const future=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
 const entry={purchased_on:'2000-01-01',product_id:p.body.id,packs:1,reason:'Compra de teste',supplier_id:supplier.body.id};
 assert.equal((await request('stock',entry,worker.cookie)).status,400); // Mandatory expiry.
 const long=await request('stock',{...entry,expires_on:future(30)},worker.cookie),short=await request('stock',{...entry,expires_on:future(5)},worker.cookie);
 assert.equal(long.status,200);assert.equal(short.status,200);
 assert.equal((await request('lots/availability',{id:long.body.id,enabled:true},worker.cookie)).status,200);assert.equal((await request('lots/availability',{id:short.body.id,enabled:true},worker.cookie)).status,200);
 db.prepare("UPDATE lots SET received='2020-01-01 00:00:00' WHERE id=?").run(long.body.id);
 const alerts=(await request('state',undefined,worker.cookie)).body.expiry_alerts;assert.ok(alerts.some(l=>l.id===short.body.id));
 const sale=await request('sales',{items:[{product_id:p.body.id,quantity:1.5}],discount:0,paid:150,method:'dinheiro'},first.cookie);assert.equal(sale.status,200);assert.equal(sale.body.items[0].lots.find(l=>l.lot_id===short.body.id).expires_on,future(5));
 assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(short.body.id).remaining,500);assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(long.body.id).remaining,0);
 assert.equal((await request('sales/cancel',{id:sale.body.id,reason:'Erro'},first.cookie)).status,403);
 assert.equal((await request('sales/cancel',{id:sale.body.id,reason:'Cliente desistiu'},cashLead.cookie)).status,200);
 assert.equal((await request('sales/cancel',{id:sale.body.id,reason:'Repetição'},cashLead.cookie)).status,409);
 assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(short.body.id).remaining,1000);
 assert.equal((await request('sales/'+sale.body.id,undefined,first.cookie)).body.cancellation.reason,'Cliente Desistiu');
 assert.equal((await request('state',undefined,first.cookie)).body.cash_summary.total_sales,0);
 const physical=(await request('state',undefined,first.cookie)).body.current_shift;assert.equal(physical.cash_sales,0);
 assert.equal((await request('warehouse/dispose',{lot_id:short.body.id,kind:'desperdicio',quantity:0.25,reason:''},worker.cookie)).status,400);
 assert.equal((await request('warehouse/dispose',{lot_id:short.body.id,kind:'desperdicio',quantity:0.25,reason:'Embalagem danificada'},worker.cookie)).status,200);
 assert.equal((await request('warehouse/dispose',{lot_id:short.body.id,kind:'expirado',quantity:0.1,reason:'Prazo expirado'},worker.cookie)).status,400);
 assert.equal((await request('lots/update',{id:short.body.id,supplier_id:supplier.body.id,expires_on:'2000-01-01'},worker.cookie)).status,200);
 assert.equal((await request('sales/'+sale.body.id,undefined,first.cookie)).body.items[0].lots.find(l=>l.lot_id===short.body.id).expires_on,future(5));
 const available=(await request('state',undefined,first.cookie)).body.products[0];assert.equal(available.stock,1);assert.equal(available.physical_stock,1.75);
 assert.equal((await request('sales',{items:[{product_id:p.body.id,quantity:1.5}],discount:0,paid:150,method:'dinheiro'},first.cookie)).status,400);
 assert.equal((await request('warehouse/dispose',{lot_id:short.body.id,kind:'expirado',quantity:0.75,reason:'Prazo expirado'},worker.cookie)).status,200);
 // Closed shifts remain fixed; later cash refunds are booked in the responsible person's open shift.
 const later=await request('sales',{items:[{product_id:p.body.id,quantity:0.5}],discount:0,paid:50,method:'dinheiro'},first.cookie);assert.equal(later.status,200);
 assert.equal((await request('shifts/close',{closing:550},first.cookie)).status,200);
 assert.equal((await request('sales/cancel',{id:later.body.id,reason:'Devolução posterior'},cashLead.cookie)).status,400);
 const free=(await request('registers',undefined,cashLead.cookie)).body.registers.find(r=>!r.shift_id);
 assert.equal((await request('shifts/open',{register_id:free.id,opening:100,pin:await code(cashLead)},cashLead.cookie)).status,200);
 assert.equal((await request('sales/cancel',{id:later.body.id,reason:'Devolução posterior'},cashLead.cookie)).status,200);
 const refundState=(await request('state',undefined,cashLead.cookie)).body;assert.equal(refundState.current_shift.cash_sales,-5000);
 assert.equal((await request('shifts/close',{closing:50},cashLead.cookie)).status,200);
 assert.equal(db.prepare('SELECT expected FROM shifts WHERE id=?').get(later.body.shift_id).expected,55000);
 // FIFO is the tie-breaker when expiration dates match.
 const sameExpiry=await request('stock',{...entry,expires_on:future(30)},worker.cookie);assert.equal(sameExpiry.status,200);assert.equal((await request('lots/availability',{id:sameExpiry.body.id,enabled:true},worker.cookie)).status,200);
 const tieSale=await request('sales',{items:[{product_id:p.body.id,quantity:1.1}],discount:0,paid:110,method:'dinheiro'},second.cookie);assert.equal(tieSale.status,200);
 assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(long.body.id).remaining,0);
 assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(sameExpiry.body.id).remaining,900);
 assert.equal((await request('sales/history',{scope:'mine',register_id:regs[0].id},first.cookie)).body.sales[0].register_number,1);
 for(const table of ['sales','items','movements','audit'])assert.throws(()=>db.exec('DELETE FROM '+table),/Histórico/);
 assert.throws(()=>db.prepare('UPDATE sales SET total=0 WHERE id=?').run(sale.body.id),/Histórico/);
 assert.ok(db.prepare("SELECT reason FROM movements WHERE kind='desperdicio'").get().reason);
 db.close();
});
