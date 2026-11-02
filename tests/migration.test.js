import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

test('legacy accounts survive migration, duplicate leadership becomes sellers, restart is repeatable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-migration-')),path=join(dir,'loja.sqlite');
 const legacy=new DatabaseSync(path);
 legacy.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1)");
 const insert=legacy.prepare('INSERT INTO users(name,username,password,role,active) VALUES(?,?,?,?,?)');
 for(const [i,role,active] of [[1,'proprietario',1],[2,'proprietario',1],[3,'gerente',0],[4,'gerente',1],[5,'vendedor',1]]) insert.run('Pessoa '+i,'legacy'+i,'not-used-in-this-test',role,active);
 legacy.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,unit TEXT NOT NULL,barcode TEXT UNIQUE,stock REAL NOT NULL DEFAULT 0 CHECK(stock>=0),minimum REAL NOT NULL DEFAULT 5,pack_type TEXT NOT NULL,pack_size REAL NOT NULL CHECK(pack_size>0),pack_cost INTEGER NOT NULL,price INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 INSERT INTO products(id,name,category,unit,stock,pack_type,pack_size,pack_cost,price) VALUES(1,'Produto histórico','Geral','un',3,'Caixa',1,100,10000);
 CREATE TABLE sales(id INTEGER PRIMARY KEY,user_id INTEGER,shift_id INTEGER,created TEXT,customer TEXT,subtotal INTEGER,discount INTEGER,total INTEGER,paid INTEGER,change_due INTEGER,method TEXT);
 INSERT INTO sales VALUES(1,1,1,'2026-10-29 20:00:00','Cliente histórico',10000,1000,9000,10000,1000,'dinheiro');
 CREATE TABLE items(id INTEGER PRIMARY KEY,sale_id INTEGER,product_id INTEGER,name TEXT,unit TEXT,quantity REAL,price INTEGER,total INTEGER);
 INSERT INTO items VALUES(1,1,1,'Produto histórico','un',1,10000,10000);`);
 legacy.exec(`CREATE TABLE audit(id INTEGER PRIMARY KEY,user_id INTEGER,created TEXT DEFAULT CURRENT_TIMESTAMP,action TEXT NOT NULL,detail TEXT NOT NULL);
 INSERT INTO audit(user_id,action,detail) VALUES(2,'Segurança','Alterou a sua palavra-passe');
 INSERT INTO audit(user_id,action,detail) VALUES(3,'Segurança','Alterou a sua palavra-passe');
 INSERT INTO audit(user_id,action,detail) VALUES(1,'Segurança','Repôs a palavra-passe da conta #3');`);
 legacy.close();
 async function startAndStop(){
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  try{await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('Startup failed: '+code)));child.once('error',reject);setTimeout(()=>reject(Error('Startup timeout')),10000).unref();});}
  finally{const exited=new Promise(resolve=>child.once('exit',resolve));if(child.exitCode===null){child.kill();await exited;}}
 }
 try{
  await startAndStop();await startAndStop();
  const db=new DatabaseSync(path);
  try{
   const users=db.prepare('SELECT * FROM users ORDER BY id').all();assert.equal(users.length,5);
   assert.equal(users[0].must_change_password,1);assert.equal(users[1].must_change_password,0);assert.equal(users[2].must_change_password,1);
   assert.equal(users.filter(u=>u.role==='proprietario').length,1);assert.equal(users[0].role,'proprietario');
   assert.equal(users.filter(u=>u.role==='gerente').length,1);assert.equal(users[3].role,'gerente');
   assert.equal(users[1].role,'vendedor');assert.equal(users[2].role,'vendedor');
   assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE action='Migração de permissões'").get().n,2);
   const sale=db.prepare('SELECT * FROM sales WHERE id=1').get();assert.equal(sale.total,9000);assert.equal(sale.fiscal_state,'legacy');assert.equal(sale.tax_total,null);assert.equal(sale.tax_base,null);
   const item=db.prepare('SELECT * FROM items WHERE id=1').get();assert.equal(item.name,'Produto histórico');assert.equal(item.total,10000);assert.equal(item.tax_amount,null);
   const movements=db.prepare("SELECT * FROM movements WHERE kind='venda'").all();assert.equal(movements.length,1);assert.equal(movements[0].quantity,-1);assert.equal(movements[0].sale_id,1);assert.equal(movements[0].created,sale.created);
   assert.equal(db.prepare('SELECT stock,sale_enabled FROM products WHERE id=1').get().stock,3);assert.equal(db.prepare('SELECT sale_enabled FROM products WHERE id=1').get().sale_enabled,1);
   assert.equal(db.prepare('SELECT enabled FROM fiscal_settings').get().enabled,0);assert.equal(db.prepare('SELECT count(*) AS n FROM tax_rules').get().n,0);

   assert.throws(()=>db.prepare("INSERT INTO users(name,username,password,role) VALUES('Outro','other','hash','gerente')").run());
   assert.throws(()=>db.prepare("UPDATE users SET name='Alterado' WHERE id=1").run());
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('existing lot allocations gain sale movements once without changing stock or receipts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-lot-upgrade-'));
 async function startAndStop(){
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',s=>stderr+=s);
  try{await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error(`Startup ${code}: ${stderr}`)));child.once('error',reject);setTimeout(()=>reject(Error('Startup timeout')),10000).unref();});}
  finally{const exited=new Promise(resolve=>child.once('exit',resolve));if(child.exitCode===null){child.kill();await exited;}}
 }
 try{
  await startAndStop();
  const old=new DatabaseSync(join(dir,'loja.sqlite'));
  // Represent a previously deployed database whose sales already consumed lots.
  old.exec(`INSERT INTO users(id,name,username,password,role) VALUES(1,'Pessoa Teste','fixture','not-used','proprietario');
   INSERT INTO products(id,name,category,unit,stock,pack_type,pack_size,pack_cost,price) VALUES(1,'Arroz','Alimentares','kg',7,'Saco',1,50,100);
   INSERT INTO shifts(id,user_id,register_id,opening) VALUES(1,1,1,0);
   INSERT INTO sales(id,user_id,shift_id,created,customer,subtotal,discount,total,paid,change_due,method) VALUES(1,1,1,'2026-10-30 10:00:00','Cliente',300,0,300,300,0,'dinheiro');
   INSERT INTO items(id,sale_id,product_id,name,unit,quantity,price,total) VALUES(1,1,1,'Arroz','kg',3,100,300);
   INSERT INTO lots(id,product_id,initial,remaining) VALUES(1,1,1000,0),(2,1,9000,7000);
   INSERT INTO allocations(item_id,lot_id,quantity) VALUES(1,1,1000),(1,2,2000);
   DELETE FROM operations_migrations WHERE name='sale-movements-v1';`);
  old.close();await startAndStop();await startAndStop();
  const upgraded=new DatabaseSync(join(dir,'loja.sqlite'));
  try{
   const movements=upgraded.prepare("SELECT * FROM movements WHERE kind='venda' ORDER BY lot_id").all();assert.equal(movements.length,2);assert.deepEqual(movements.map(m=>m.quantity),[-1,-2]);assert.ok(movements.every(m=>m.sale_id===1&&m.created==='2026-10-30 10:00:00'));
   assert.equal(upgraded.prepare('SELECT stock FROM products').get().stock,7);assert.equal(upgraded.prepare('SELECT SUM(remaining) AS n FROM lots').get().n,7000);
   assert.equal(upgraded.prepare('SELECT total FROM sales').get().total,300);assert.equal(upgraded.prepare('SELECT quantity FROM items').get().quantity,3);assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM allocations').get().n,2);
  }finally{upgraded.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
