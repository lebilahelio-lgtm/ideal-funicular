import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import net from 'node:net';

test('dated purchases always create pending lots; release and FIFO are per lot; existing lots only receive reasoned sale returns',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-dated-lots-')),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const server=spawn(process.execPath,['server.js'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let errors='';server.stderr.on('data',s=>errors+=s);
 let cookie='';const api=async(path,body,session=cookie)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:session,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 let db;
 try{
  await new Promise((r,j)=>{server.stdout.once('data',r);server.once('exit',()=>j(Error(errors)));server.once('error',j);setTimeout(()=>j(Error('Startup timeout')),10000).unref();});
  const person={name:'Pessoa Teste',bi:'009763932CA042',birth_date:'1990-01-01',email:'owner@gmail.com'};
  const setup=await api('setup',person);cookie=(await api('login',{identifier:person.email,password:setup.body.password})).cookie;await api('password',{password:'SenhaPessoal123!'});
  const vendor=await api('users',{...person,bi:'009763933CA042',email:'seller@gmail.com',role:'vendedor'});const seller=(await api('login',{identifier:'seller@gmail.com',password:vendor.body.password})).cookie;await api('password',{password:'SenhaPessoal123!'},seller);
  const supplier=await api('partners',{name:'Fornecedor Teste',kind:'fornecedor',phone:'923456789',email:'compra@example.com',location:'Luanda'});
  const minimalSupplier=await api('suppliers',{name:'Fornecedor Sem Contactos',location:'Benguela'});assert.equal(minimalSupplier.status,200);
  const savedSupplier=(await api('partners')).body.partners.find(p=>p.id===minimalSupplier.body.id);assert.equal(savedSupplier.phone,'');assert.equal(savedSupplier.email,'');
  for(const fields of [{name:'Sem Local'},{location:'Luanda'},{name:'Teste',location:'Luanda',phone:'abc'},{name:'Teste',location:'Luanda',email:'invalido'}])assert.equal((await api('suppliers',fields)).status,400);
  const product={name:'Arroz',category:'Alimentares',unit:'kg',minimum:1,pack_type:'Saco',pack_size:1,pack_cost:50,price:100,expiry_warning_days:7};const created=await api('products',product);assert.equal(created.status,200);const id=created.body.id;
  // Reject zero prices on creation and editing, including values that round to zero cents.
  for(const price of [0,'0',-1,0.001]){
   for(const fields of [{name:'Preço Inválido'},{id}]){
    const rejected=await api('products',{...product,...fields,price});
    assert.equal(rejected.status,400);
   }
  }
  assert.equal((await api('state')).body.products.find(p=>p.id===id).price,10000);
  const cheapest=await api('products',{...product,name:'Preço Mínimo',price:0.01});assert.equal(cheapest.status,200);
  assert.equal((await api('state')).body.products.find(p=>p.id===cheapest.body.id).price,1);
  assert.equal((await api('products',{...product,name:'Produto Livre',pack_type:'Tambor',expiry_warning_days:0})).status,200);
  assert.equal((await api('products',{...product,pack_type:''})).status,400);assert.equal((await api('products',{...product,pack_size:0})).status,400);
  const zeroDefault=await api('products',{...product,name:'Sem Aviso Prévio',expiry_warning_days:undefined});assert.equal(zeroDefault.status,200);assert.equal((await api('state')).body.products.find(p=>p.id===zeroDefault.body.id).expiry_warning_days,0);
  db=new DatabaseSync(join(dir,'loja.sqlite'));
  const purchase={product_id:id,supplier_id:supplier.body.id,packs:2,purchased_on:'2022-01-01',expires_on:'2090-01-01'};
  for(const input of [{...purchase,purchased_on:undefined},{...purchase,expires_on:undefined},{...purchase,purchased_on:'2026-02-30'},{...purchase,purchased_on:'2099-01-01'},{...purchase,expires_on:'2021-12-31'},{...purchase,lot_id:1},{...purchase,id:1},{...purchase,sale_enabled:true}])assert.equal((await api('stock',input)).status,400);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lots').get().n,0);
  const newer=await api('stock',purchase),older=await api('stock',{...purchase,purchased_on:'2020-01-01',expires_on:'2099-01-01'});assert.equal(newer.status,200);assert.equal(older.status,200);assert.notEqual(newer.body.id,older.body.id);
  assert.equal(newer.body.sale_enabled,false);assert.equal(older.body.sale_enabled,false);assert.equal((await api('state')).body.sale_products.length,0);
  let details=(await api('warehouse/products/'+id)).body;assert.equal(details.product.physical_stock,4);assert.equal(details.product.stock,0);assert.equal(details.lots[0].id,older.body.id);assert.equal(details.lots[0].purchased_on,'2020-01-01');
  assert.equal((await api('products',{...product,id,sale_enabled:true})).status,400);assert.equal((await api('products/availability',{id,enabled:true})).status,404);
  assert.equal((await api('lots/availability',{id:newer.body.id,enabled:true},seller)).status,403);
  assert.equal((await api('lots/availability',{id:newer.body.id,enabled:true})).status,200);assert.equal((await api('state')).body.sale_products[0].stock,2);
  const pending=await api('stock',{...purchase,purchased_on:'2021-01-01'});assert.equal(pending.status,200);assert.equal(pending.body.sale_enabled,false);
  details=(await api('warehouse/products/'+id)).body;assert.equal(details.product.physical_stock,6);assert.equal(details.product.stock,2);assert.equal(details.lots.find(l=>l.id===pending.body.id).sale_enabled,0);
  const shiftPin=(await api('account/pin')).body.code,register=(await api('registers')).body.registers[0];assert.equal((await api('shifts/open',{opening:100,register_id:register.id,pin:shiftPin})).status,200);
  const basket={items:[{product_id:id,quantity:1}],discount:0,paid:100,method:'dinheiro'};
  const firstSale=await api('sales',basket);assert.equal(firstSale.status,200);assert.equal(firstSale.body.items[0].lots[0].lot_id,newer.body.id);
  assert.equal((await api('lots/availability',{id:older.body.id,enabled:true})).status,200);
  const nextSale=await api('sales',basket);assert.equal(nextSale.status,200);assert.equal(nextSale.body.items[0].lots[0].lot_id,older.body.id,'FIFO must use purchase date, not arrival ID or expiration date');
  for(const field of ['remaining','initial','quantity','packs','purchased_on','sale_enabled'])assert.equal((await api('lots/update',{id:older.body.id,supplier_id:supplier.body.id,expires_on:'2099-01-01',[field]:field==='purchased_on'?'2000-01-01':3})).status,400);
  const count=db.prepare('SELECT COUNT(*) AS n FROM lots').get().n,initial=db.prepare('SELECT initial FROM lots WHERE id=?').get(older.body.id).initial;
  for(const reason of [undefined,'','   '])assert.equal((await api('warehouse/return',{sale_id:nextSale.body.id,lot_id:older.body.id,reason})).status,400);
  assert.equal((await api('warehouse/return',{sale_id:nextSale.body.id,lot_id:older.body.id,quantity:0.5,reason:'Devolução parcial'})).status,400);
  assert.equal((await api('warehouse/return',{sale_id:nextSale.body.id,lot_id:pending.body.id,reason:'Cliente devolveu'})).status,400);
  assert.equal((await api('warehouse/return',{sale_id:nextSale.body.id,lot_id:older.body.id,reason:'Cliente devolveu'},seller)).status,403);
  assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(older.body.id).remaining,1000);
  assert.equal((await api('warehouse/return',{sale_id:nextSale.body.id,lot_id:older.body.id,reason:'Cliente devolveu'})).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lots').get().n,count);assert.equal(db.prepare('SELECT initial FROM lots WHERE id=?').get(older.body.id).initial,initial);assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(older.body.id).remaining,2000);
  const movement=db.prepare("SELECT * FROM movements WHERE kind='devolucao' AND lot_id=?").get(older.body.id);assert.equal(movement.quantity,1);assert.match(movement.reason,/Cliente Devolveu/);assert.equal(movement.sale_id,nextSale.body.id);
  assert.equal((await api('warehouse/return',{sale_id:nextSale.body.id,lot_id:older.body.id,reason:'Repetido'})).status,409);
  // Selected lots are honored exactly, without silently falling back to older stock.
  const offered=(await api('sales/lots/'+id,undefined,seller)).body.lots;assert.deepEqual(offered.map(l=>l.id),[older.body.id,newer.body.id]);assert.ok(offered.every(l=>!Object.hasOwn(l,'purchase_cost')&&!Object.hasOwn(l,'supplier_id')));
  const oldRemaining=db.prepare('SELECT remaining FROM lots WHERE id=?').get(older.body.id).remaining;
  const chosen=await api('sales',{...basket,items:[{product_id:id,lot_id:newer.body.id,quantity:0.5}],paid:50});assert.equal(chosen.status,200);assert.equal(chosen.body.items[0].lots[0].lot_id,newer.body.id);assert.equal(db.prepare('SELECT remaining FROM lots WHERE id=?').get(older.body.id).remaining,oldRemaining);
  const salesBefore=db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  assert.equal((await api('sales',{...basket,items:[{product_id:id,lot_id:newer.body.id,quantity:1}]})).status,400);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,salesBefore);
  const mixed=await api('sales',{...basket,items:[{product_id:id,lot_id:older.body.id,quantity:0.25},{product_id:id,lot_id:newer.body.id,quantity:0.25}],paid:50});assert.equal(mixed.status,200);assert.equal(mixed.body.items.length,2);assert.deepEqual(mixed.body.items.flatMap(i=>i.lots.map(l=>l.lot_id)).sort(),[older.body.id,newer.body.id].sort());
  assert.equal((await api('sales',{...basket,items:[{product_id:id,lot_id:older.body.id,quantity:0.25},{product_id:id,lot_id:older.body.id,quantity:0.25}],paid:50})).status,400);
  assert.equal((await api('sales',{...basket,items:[{product_id:id,lot_id:pending.body.id,quantity:1}]})).status,409);
  assert.equal((await api('sales',{...basket,items:[{product_id:id,lot_id:'1',quantity:1}]})).status,400);
  const other=await api('products',{...product,name:'Feijão'});assert.equal((await api('sales',{...basket,items:[{product_id:other.body.id,lot_id:newer.body.id,quantity:0.25}],paid:25})).status,409);
  // A released lot can pass from orange to red without masking other valid stock.
  const dateOffset=n=>new Date(Date.now()+3600000+n*86400000).toISOString().slice(0,10);
  await api('lots/update',{id:older.body.id,supplier_id:supplier.body.id,expires_on:dateOffset(1)});assert.equal((await api('state')).body.products.find(p=>p.id===id).expiry_status,'warning');
  await api('lots/update',{id:older.body.id,supplier_id:supplier.body.id,expires_on:dateOffset(-1)});const red=(await api('state')).body.products.find(p=>p.id===id);assert.equal(red.expiry_status,'expired');assert.ok(red.stock>0);
  assert.ok(!(await api('sales/lots/'+id)).body.lots.some(l=>l.id===older.body.id));assert.equal((await api('sales',{...basket,items:[{product_id:id,lot_id:older.body.id,quantity:0.25}],paid:25})).status,409);
  await api('lots/availability',{id:older.body.id,enabled:false});assert.equal((await api('state')).body.products.find(p=>p.id===id).expiry_status,'healthy');
  await api('lots/availability',{id:newer.body.id,enabled:false});assert.equal((await api('sales',{...basket,items:[{product_id:id,lot_id:newer.body.id,quantity:0.1}],paid:10})).status,409);assert.equal((await api('state')).body.products.find(p=>p.id===id).expiry_status,'pending');
  // Historical purchases may already have expired; they remain physical stock and can never be released.
  const expired=await api('stock',{...purchase,purchased_on:'2020-01-01',expires_on:'2020-02-01'});assert.equal(expired.status,200);assert.equal((await api('lots/availability',{id:expired.body.id,enabled:true})).status,400);
  assert.equal((await api('warehouse/products/'+id,undefined,seller)).body.lots.length,0);
  const ordinary=(await api('state',undefined,seller)).body.products[0];assert.equal(ordinary.pack_cost,undefined);assert.equal(ordinary.sale_enabled,undefined);
  assert.equal((await api('users/access',{id:vendor.body.id,role:'armazem',active:true,permissions:{stock_entry:false,stock_exit:false,supplier_create:false}})).status,200);
  const reader=(await api('login',{identifier:'seller@gmail.com',password:'SenhaPessoal123!'})).cookie;
  const today=new Date(Date.now()+3600000).toISOString().slice(0,10);await api('stock',{...purchase,purchased_on:today,expires_on:today});
  const readState=(await api('state',undefined,reader)).body;assert.ok(readState.expiry_alerts.length>0);assert.ok(readState.expiry_alerts.every(l=>!Object.hasOwn(l,'purchase_cost')));
  const readDetails=(await api('warehouse/products/'+id,undefined,reader)).body;assert.ok(readDetails.lots.length>0);assert.equal(readDetails.product.pack_cost,undefined);assert.ok(readDetails.lots.every(l=>!Object.hasOwn(l,'purchase_cost')&&!Object.hasOwn(l,'returnable_sales')));
  assert.ok(!errors.includes('Error:'),errors);
 }finally{db?.close();const exited=new Promise(r=>server.once('exit',r));if(server.exitCode===null){server.kill();await exited;}rmSync(dir,{recursive:true,force:true});}
});
