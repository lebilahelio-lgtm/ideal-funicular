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
 legacy.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,user_id INTEGER,shift_id INTEGER,created TEXT,customer TEXT,subtotal INTEGER,discount INTEGER,total INTEGER,paid INTEGER,change_due INTEGER,method TEXT);
 INSERT INTO sales VALUES(1,1,1,'2026-10-29 20:00:00','Cliente histórico',10000,1000,9000,10000,1000,'dinheiro');
 CREATE TABLE items(id INTEGER PRIMARY KEY,sale_id INTEGER,product_id INTEGER,name TEXT,unit TEXT,quantity REAL,price INTEGER,total INTEGER);
 INSERT INTO items VALUES(1,1,1,'Produto histórico','un',1,10000,10000);`);
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
   assert.equal(users.filter(u=>u.role==='proprietario').length,1);assert.equal(users[0].role,'proprietario');
   assert.equal(users.filter(u=>u.role==='gerente').length,1);assert.equal(users[3].role,'gerente');
   assert.equal(users[1].role,'vendedor');assert.equal(users[2].role,'vendedor');
   assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE action='Migração de permissões'").get().n,2);
   const sale=db.prepare('SELECT * FROM sales WHERE id=1').get();assert.equal(sale.total,9000);assert.equal(sale.fiscal_state,'legacy');assert.equal(sale.tax_total,null);assert.equal(sale.tax_base,null);
   const item=db.prepare('SELECT * FROM items WHERE id=1').get();assert.equal(item.name,'Produto histórico');assert.equal(item.total,10000);assert.equal(item.tax_amount,null);
   assert.equal(db.prepare('SELECT enabled FROM fiscal_settings').get().enabled,0);assert.equal(db.prepare('SELECT count(*) AS n FROM tax_rules').get().n,0);

   assert.throws(()=>db.prepare("INSERT INTO users(name,username,password,role) VALUES('Outro','other','hash','gerente')").run());
   assert.throws(()=>db.prepare("UPDATE users SET name='Alterado' WHERE id=1").run());
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
