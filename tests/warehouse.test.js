import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// Exercise the API with actual password onboarding, no permission/session bypasses.
test('warehouse releases stock, sells FIFO atomically, records every movement and reconciles cancelled VAT',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'warehouse-review-'));
 const net=await import('node:net'),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const server=spawn(process.execPath,['server.js'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
 let stderr='';server.stderr.on('data',s=>stderr+=s);
 let cookie='';
 async function request(path,body,session=cookie){const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',cookie:session},body:body===undefined?undefined:JSON.stringify(body)});const result={status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};return result;}
 const identity={name:'Pessoa Teste',bi:'009763932CA042',birth_date:'1990-01-01',email:'owner@gmail.com'};
 try{
 await new Promise((r,j)=>{server.stdout.once('data',r);server.once('exit',()=>j(Error(stderr)));server.once('error',j)});
 const setup=await request('setup',identity);cookie=(await request('login',{identifier:identity.email,password:setup.body.password})).cookie;assert.equal((await request('password',{password:'SenhaPessoal123!'})).status,200);
 const manager=await request('users',{...identity,bi:'009763933CA042',email:'manager@gmail.com',role:'gerente'});
 const employee=await request('users',{...identity,bi:'009763934CA042',email:'staff@gmail.com',role:'vendedor'});
 const managerCookie=(await request('login',{identifier:'manager@gmail.com',password:manager.body.password})).cookie;await request('password',{password:'SenhaPessoal123!'},managerCookie);
 // Omitted and partial permissions cannot grant default accesses that the manager lacks.
 for(const permissions of [undefined,{}, {products:true}]){const result=await request('users/access',{id:employee.body.id,role:'armazem',active:true,...(permissions===undefined?{}:{permissions})},managerCookie);assert.equal(result.status,403);}
 const staffCookie=(await request('login',{identifier:'staff@gmail.com',password:employee.body.password})).cookie;await request('password',{password:'SenhaPessoal123!'},staffCookie);
 const supplier=await request('partners',{name:'Fornecedor Teste',kind:'fornecedor',phone:'923456789',email:'compras@example.com',location:'Luanda'});assert.equal(supplier.status,200);
 const productBody={name:'Óleo',category:'Alimentares',unit:'kg',pack_type:'Saco',pack_size:1,pack_cost:50,price:114,minimum:1,expiry_required:true};
 const product=await request('products',productBody);assert.equal(product.status,200);const id=product.body.id;
 const future=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
 const entry={purchased_on:'2000-01-01',product_id:id,packs:1,supplier_id:supplier.body.id,reason:'Compra inicial'};
 const first=await request('stock',{...entry,expires_on:future(90)}),second=await request('stock',{...entry,expires_on:future(10)});assert.equal(first.status,200);assert.equal(second.status,200);
 const fixture=new DatabaseSync(join(dir,'loja.sqlite'));fixture.prepare("UPDATE lots SET received='2020-01-01 10:00:00' WHERE id=?").run(first.body.id);
 assert.equal((await request('state')).body.sale_products.length,0);
 const pin=(await request('account/pin')).body.code,register=(await request('registers')).body.registers[0];assert.equal((await request('shifts/open',{opening:100,register_id:register.id,pin})).status,200);
 const saleBody={items:[{product_id:id,quantity:1.5}],discount:0,paid:171,method:'dinheiro'};
 const before=fixture.prepare('SELECT COUNT(*) AS n FROM movements').get().n;
 assert.equal((await request('sales',saleBody)).status,400);assert.equal(fixture.prepare('SELECT COUNT(*) AS n FROM movements').get().n,before);
 assert.equal((await request('lots/availability',{id:first.body.id,enabled:true},staffCookie)).status,403);
 assert.equal((await request('lots/availability',{id:first.body.id,enabled:'true'})).status,400);
 assert.equal((await request('lots/availability',{enabled:true})).status,400);
 for(const items of [[null],[{}],[{product_id:String(id),quantity:1}]])assert.equal((await request('sales',{...saleBody,items})).status,400);
 assert.equal((await request('warehouse/dispose',{quantity:1,kind:'desperdicio',reason:'Teste'})).status,400);
 assert.equal((await request('lots/availability',{id:first.body.id,enabled:true})).status,200);assert.equal((await request('lots/availability',{id:second.body.id,enabled:true})).status,200);assert.equal((await request('state')).body.sale_products[0].id,id);
 const rule=await request('fiscal/rules',{name:'IVA teste',kind:'tributado',rate:14,start_date:'2000-01-01',legal_basis:'Teste automatizado',active:true});
 await request('products/tax',{ids:[id],tax_rule_id:rule.body.id});
 assert.equal((await request('fiscal/settings',{enabled:true,regime:'geral',price_mode:'included',company_nif:'123456789',company_address:'Luanda',legal_basis:'Teste automatizado',confirmed:true})).status,200);
 const revision=(await request('state')).body.fiscal.revision;
 const sale=await request('sales',{...saleBody,expected_fiscal_revision:revision});assert.equal(sale.status,200);
 assert.equal(fixture.prepare('SELECT remaining FROM lots WHERE id=?').get(first.body.id).remaining,0);
 assert.equal(fixture.prepare('SELECT remaining FROM lots WHERE id=?').get(second.body.id).remaining,500);
 let history=await request('warehouse/history',{kind:'venda',sale_id:sale.body.id});assert.equal(history.status,200);assert.equal(history.body.count,2);assert.equal(history.body.movements.reduce((n,m)=>n+m.quantity,0),-1.5);assert.ok(history.body.movements.every(m=>m.sale_id===sale.body.id&&m.lot_id&&m.reason));
 const day=new Date(Date.now()+3600000).toISOString().slice(0,10);
 const report=await request('fiscal/report',{start:day,end:day});assert.equal(report.body.groups.reduce((n,g)=>n+g.tax_amount,0),report.body.tax_total);assert.ok(report.body.tax_total>0);
 // A later stock failure rolls back sale, allocations and warehouse movement together.
 const moves=fixture.prepare('SELECT COUNT(*) AS n FROM movements').get().n;
 assert.equal((await request('sales',{...saleBody,expected_fiscal_revision:revision})).status,400);assert.equal(fixture.prepare('SELECT COUNT(*) AS n FROM movements').get().n,moves);
 assert.equal((await request('sales/cancel',{id:sale.body.id,reason:'Cliente desistiu'})).status,200);
 const cancelled=await request('fiscal/report',{start:day,end:day});assert.equal(cancelled.body.total,0);assert.equal(cancelled.body.tax_total,0);assert.deepEqual(cancelled.body.groups,[]);
 const returns=await request('warehouse/history',{kind:'devolucao',sale_id:sale.body.id});assert.equal(returns.body.count,2);assert.equal(returns.body.movements.reduce((n,m)=>n+m.quantity,0),1.5);
 const afterCancel=fixture.prepare('SELECT COUNT(*) AS n FROM movements').get().n;assert.equal((await request('sales/cancel',{id:sale.body.id,reason:'Repetido'})).status,409);assert.equal(fixture.prepare('SELECT COUNT(*) AS n FROM movements').get().n,afterCancel);
 // Disposals require a reason and preserve stock on validation failures.
 for(const reason of ['', '   '])assert.equal((await request('warehouse/dispose',{lot_id:first.body.id,quantity:0.25,kind:'desperdicio',reason})).status,400);
 assert.equal((await request('warehouse/dispose',{lot_id:first.body.id,quantity:2,kind:'desperdicio',reason:'Embalagem danificada'})).status,400);
 assert.equal((await request('warehouse/dispose',{lot_id:first.body.id,quantity:0.25,kind:'desperdicio',reason:'Embalagem danificada'})).status,200);
 assert.equal((await request('warehouse/dispose',{lot_id:second.body.id,quantity:0.1,kind:'expirado',reason:'Prazo terminado'})).status,400);
 assert.equal((await request('lots/update',{id:second.body.id,supplier_id:supplier.body.id,expires_on:'2000-01-01'})).status,200);
 assert.equal((await request('warehouse/dispose',{lot_id:second.body.id,quantity:1,kind:'expirado',reason:'Prazo terminado'})).status,200);
 const stock=(await request('state')).body.products[0];assert.equal(stock.stock,0.75);assert.equal(stock.physical_stock,0.75);
 assert.equal((await request('lots/availability',{id:first.body.id,enabled:false})).status,200);assert.equal((await request('state')).body.sale_products.length,0);assert.equal((await request('sales',{...saleBody,items:[{product_id:id,quantity:0.25}],paid:28.5,expected_fiscal_revision:revision})).status,400);
 assert.equal((await request('warehouse/dispose',{lot_id:first.body.id,quantity:0.25,kind:'outra_saida',reason:'Amostra para controlo'})).status,200);
 // Filters are applied before pagination and accept Angola dates.
 assert.equal((await request('warehouse/history',{q:'oleo'})).body.count,(await request('warehouse/history',{product_id:id})).body.count);
 for(const query of [{kind:'venda',direction:'saida'},{product_id:id,q:'Cliente Desistiu',direction:'entrada'},{kind:'expirado',start:day,end:day}]){const filtered=await request('warehouse/history',query);assert.equal(filtered.status,200);assert.ok(filtered.body.count>0);}
 for(const query of [{kind:'invalido'},{direction:'invalido'},{start:'2026-02-30'},{start:'2026-11-02',end:'2026-11-01'},{page:0},{product_id:'abc'}])assert.equal((await request('warehouse/history',query)).status,400);
 assert.equal((await request('warehouse/history',{},staffCookie)).status,403);
 assert.equal((await request('users/access',{id:employee.body.id,role:'armazem',active:true,permissions:{stock_entry:false,stock_exit:false,supplier_create:false}})).status,200);
 const reader=(await request('login',{identifier:'staff@gmail.com',password:'SenhaPessoal123!'})).cookie;
 const readOnly=await request('warehouse/history',{},reader);assert.equal(readOnly.status,200);assert.ok(readOnly.body.movements.every(m=>!Object.hasOwn(m,'cost')));
 assert.ok((await request('state',undefined,reader)).body.products.every(p=>!Object.hasOwn(p,'pack_cost')));
 assert.equal((await request('lots/availability',{id:first.body.id,enabled:true},reader)).status,403);
 for(let i=0;i<55;i++)assert.equal((await request('stock',{...entry,expires_on:future(90),reason:`Compra de teste ${i}`})).status,200);
 const page1=await request('warehouse/history',{kind:'entrada',product_id:id}),page2=await request('warehouse/history',{kind:'entrada',product_id:id,page:2});assert.equal(page1.body.count,57);assert.equal(page1.body.movements.length,50);assert.equal(page2.body.movements.length,7);assert.ok(!page1.body.movements.some(m=>page2.body.movements.some(n=>n.id===m.id)));
 assert.equal(fixture.prepare('SELECT stock FROM products WHERE id=?').get(id).stock,fixture.prepare('SELECT SUM(remaining)/1000.0 AS n FROM lots WHERE product_id=?').get(id).n);
 fixture.close();
 assert.ok(!stderr.includes('Error:'),stderr);
 }finally{const exited=new Promise(r=>server.once('exit',r));server.kill();await exited;rmSync(dir,{recursive:true,force:true});}
});
