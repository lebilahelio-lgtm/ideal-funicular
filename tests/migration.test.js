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
   assert.throws(()=>db.prepare("INSERT INTO users(name,username,password,role) VALUES('Outro','other','hash','gerente')").run());
   assert.throws(()=>db.prepare("UPDATE users SET name='Alterado' WHERE id=1").run());
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
