import {randomBytes,randomInt,createCipheriv,createDecipheriv,createHmac,timingSafeEqual} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {descriptiveText} from './public/validation.js';
import {expiryStatus,productExpiryStatus} from './public/stock-status.js';
import {fiscalDate} from './fiscal.js';
const day=()=>new Date(Date.now()+3600000).toISOString().slice(0,10);
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const text=(v,label,max=500)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)throw error(`${label} inválido.`);return v.trim();};
const recordId=(value,label='Identificador')=>{if(!Number.isSafeInteger(value)||value<1)throw error(`${label} inválido.`);return value;};
const units=value=>{if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e7||Math.abs(value*1000-Math.round(value*1000))>1e-6)throw error('Quantidade inválida.');return Math.round(value*1000);};
export function operations(db,dir,audit){
 const fold=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt');
 db.function('warehouse_search',{deterministic:true},fold);
 const all=(q,...p)=>db.prepare(q).all(...p),one=(q,...p)=>db.prepare(q).get(...p),run=(q,...p)=>db.prepare(q).run(...p);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const add=(table,name,type)=>{if(!all(`PRAGMA table_info(${table})`).some(c=>c.name===name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
 tx(()=>{
 add('users','job_type',"TEXT NOT NULL DEFAULT 'atendente'");
 run("UPDATE users SET job_type=role WHERE role IN ('gerente','proprietario') AND job_type='atendente'");
 add('products','sale_enabled','INTEGER NOT NULL DEFAULT 1');
 add('products','expiry_required','INTEGER NOT NULL DEFAULT 0');add('products','expiry_warning_days','INTEGER NOT NULL DEFAULT 7');
 db.exec(`CREATE TABLE IF NOT EXISTS registers(id INTEGER PRIMARY KEY,number INTEGER NOT NULL UNIQUE,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS partners(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('fornecedor','outro')),phone TEXT NOT NULL,email TEXT NOT NULL,location TEXT NOT NULL,created_by INTEGER REFERENCES users(id),created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS cash_pins(user_id INTEGER PRIMARY KEY REFERENCES users(id),cipher TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0,blocked_until INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS lots(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),supplier_id INTEGER REFERENCES partners(id),received TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_on TEXT,initial INTEGER NOT NULL,remaining INTEGER NOT NULL CHECK(remaining>=0),legacy INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS allocations(item_id INTEGER REFERENCES items(id),lot_id INTEGER REFERENCES lots(id),quantity INTEGER NOT NULL CHECK(quantity>0),PRIMARY KEY(item_id,lot_id));
 CREATE TABLE IF NOT EXISTS sale_cancellations(sale_id INTEGER PRIMARY KEY REFERENCES sales(id),actor_id INTEGER NOT NULL REFERENCES users(id),reason TEXT NOT NULL,created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,refund_shift_id INTEGER REFERENCES shifts(id),cash_refund INTEGER NOT NULL DEFAULT 0);`);
 add('lots','purchased_on','TEXT');
 add('lots','sale_enabled','INTEGER NOT NULL DEFAULT 0');
 add('allocations','expires_on_snapshot','TEXT');
 add('shifts','register_id','INTEGER REFERENCES registers(id)');
 add('movements','sale_id','INTEGER REFERENCES sales(id)');
 add('movements','lot_id','INTEGER REFERENCES lots(id)');add('movements','kind',"TEXT NOT NULL DEFAULT 'entrada'");
 // An additive marker makes migration repeatable and preserves all earlier quantities.
 db.exec('CREATE TABLE IF NOT EXISTS operations_migrations(name TEXT PRIMARY KEY)');
 if(!one("SELECT name FROM operations_migrations WHERE name='lots-registers-v1'")){
  for(const p of all('SELECT id,stock FROM products WHERE stock>0'))run('INSERT INTO lots(product_id,initial,remaining,legacy) VALUES(?,?,?,1)',p.id,Math.round(p.stock*1000),Math.round(p.stock*1000));
  let number=0;
  for(const u of all('SELECT DISTINCT user_id FROM shifts ORDER BY user_id')){number++;const id=Number(run('INSERT INTO registers(number,name) VALUES(?,?)',number,'Balcão '+number).lastInsertRowid);run('UPDATE shifts SET register_id=? WHERE user_id=?',id,u.user_id);}
  if(!number)run("INSERT INTO registers(number,name) VALUES(1,'Balcão 1')");
  run("INSERT INTO operations_migrations VALUES('lots-registers-v1')");
 }
 // The legacy product flag seeds existing lots once; new purchases always start pending.
 if(!one("SELECT name FROM operations_migrations WHERE name='lot-availability-v2'")){
  run('UPDATE lots SET sale_enabled=COALESCE((SELECT sale_enabled FROM products WHERE id=lots.product_id),0)');
  run("INSERT INTO operations_migrations VALUES('lot-availability-v2')");
 }
 db.exec(`CREATE INDEX IF NOT EXISTS lot_purchase_fifo ON lots(product_id,purchased_on,received,id);
 CREATE UNIQUE INDEX IF NOT EXISTS register_occupied ON shifts(register_id) WHERE closed IS NULL;
 CREATE INDEX IF NOT EXISTS lot_fifo ON lots(product_id,received,id);
 CREATE INDEX IF NOT EXISTS movement_history ON movements(created DESC,id DESC);
 CREATE INDEX IF NOT EXISTS movement_sale ON movements(sale_id);
 CREATE INDEX IF NOT EXISTS sale_shift ON sales(shift_id);
 CREATE INDEX IF NOT EXISTS sale_person ON sales(user_id);`);
 if(!one("SELECT name FROM operations_migrations WHERE name='sale-movements-v1'")){
  run(`INSERT INTO movements(product_id,user_id,created,quantity,cost,reason,lot_id,kind,sale_id) SELECT i.product_id,s.user_id,s.created,-a.quantity/1000.0,0,'Venda - recibo #'||s.id,a.lot_id,'venda',s.id FROM allocations a JOIN items i ON i.id=a.item_id JOIN sales s ON s.id=i.sale_id`);
  run(`INSERT INTO movements(product_id,user_id,created,quantity,cost,reason,kind,sale_id) SELECT i.product_id,s.user_id,s.created,-i.quantity,0,'Venda antiga - recibo #'||s.id,'venda',s.id FROM items i JOIN sales s ON s.id=i.sale_id WHERE NOT EXISTS(SELECT 1 FROM allocations a WHERE a.item_id=i.id)`);
  run("INSERT INTO operations_migrations VALUES('sale-movements-v1')");
 }
 for(const table of ['sales','items','movements','audit','allocations','sale_cancellations'])db.exec(`CREATE TRIGGER IF NOT EXISTS preserve_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Histórico não pode ser apagado'); END; CREATE TRIGGER IF NOT EXISTS preserve_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Histórico não pode ser alterado'); END;`);
 });
 const path=join(dir,'cash-pin.key');if(!existsSync(path)&&one('SELECT user_id FROM cash_pins LIMIT 1'))throw Error('Restaure a chave cash-pin.key do backup antes de iniciar: existem códigos cifrados na base de dados.');if(!existsSync(path))writeFileSync(path,randomBytes(32),{mode:0o600,flag:'wx'});const key=readFileSync(path);if(key.length!==32)throw Error('Chave local de proteção dos códigos inválida.');
 const digest=pin=>createHmac('sha256',key).update(pin).digest('hex');
 const encrypt=pin=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(pin,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');};
 const decrypt=stored=>{const b=Buffer.from(stored,'base64'),cipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));return Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString('utf8');};
 function refreshPins(){return tx(()=>{const now=Date.now();for(const u of all('SELECT id FROM users WHERE active=1 AND deleted_at IS NULL ORDER BY id')){const old=one('SELECT * FROM cash_pins WHERE user_id=?',u.id);if(old&&old.expires_at>now)continue;const occupied=new Set(all('SELECT digest FROM cash_pins').map(p=>p.digest));let pin;const available=[];for(let i=0;i<10000;i++){const value=String(i).padStart(4,'0');if(!occupied.has(digest(value)))available.push(value);}if(!available.length)throw error('Não há códigos disponíveis. Contacte o proprietário.',409);pin=available[randomInt(available.length)];run('INSERT INTO cash_pins(user_id,cipher,digest,issued_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET cipher=excluded.cipher,digest=excluded.digest,issued_at=excluded.issued_at,expires_at=excluded.expires_at,failures=0,blocked_until=0',u.id,encrypt(pin),digest(pin),now,now+7*86400000);}});}
 function pinFor(id){refreshPins();const p=one('SELECT * FROM cash_pins WHERE user_id=?',id);if(!p)throw error('Conta indisponível.',404);return {code:decrypt(p.cipher),issued_at:p.issued_at,expires_at:p.expires_at};}
 function checkPin(user,pin){refreshPins();const p=one('SELECT * FROM cash_pins WHERE user_id=?',user.id),now=Date.now();if(p.blocked_until>now)throw error('Código bloqueado por 5 minutos após tentativas incorretas.',429);if(typeof pin!=='string'||!/^\d{4}$/.test(pin)||!timingSafeEqual(Buffer.from(digest(pin)),Buffer.from(p.digest))){const n=p.blocked_until&&p.blocked_until<=now?1:p.failures+1;run('UPDATE cash_pins SET failures=?,blocked_until=? WHERE user_id=?',n,n>=5?now+300000:0,user.id);throw error('Código pessoal incorreto. Consulte A minha conta.',403);}run('UPDATE cash_pins SET failures=0,blocked_until=0 WHERE user_id=?',user.id);}
 function registers(){return all('SELECT r.*,s.id AS shift_id,s.user_id,u.name AS operator,s.opened FROM registers r LEFT JOIN shifts s ON s.register_id=r.id AND s.closed IS NULL LEFT JOIN users u ON u.id=s.user_id WHERE r.active=1 OR s.id IS NOT NULL ORDER BY r.number');}
 function configureRegisters(body,user){const count=body.count;if(!Number.isInteger(count)||count<1||count>100)throw error('Defina entre 1 e 100 balcões.');return tx(()=>{if(one('SELECT s.id FROM shifts s JOIN registers r ON r.id=s.register_id WHERE s.closed IS NULL AND r.number>?',count))throw error('Feche os balcões ocupados antes de reduzir a quantidade.');for(let n=1;n<=count;n++)run('INSERT INTO registers(number,name,active) VALUES(?,?,1) ON CONFLICT(number) DO UPDATE SET active=1',n,'Balcão '+n);run('UPDATE registers SET active=0 WHERE number>?',count);audit(user,'Balcões',`Configurou ${count} balcões.`);return {ok:true};});}
 const suppliers=()=>all("SELECT id,name FROM partners WHERE kind='fornecedor' AND active=1 ORDER BY name");
 function partner(body,user,supplierOnly=false){const kind=supplierOnly?'fornecedor':body.kind;if(!['fornecedor','outro'].includes(kind))throw error('Tipo de parceiro inválido.');const name=descriptiveText(text(body.name,'Nome')),location=descriptiveText(text(body.location,'Localização'));
 const optional=(value,label,max)=>{if(value===undefined||value===null)return '';if(typeof value!=='string'||value.trim().length>max)throw error(`${label} inválido.`);return value.trim();};
 const phone=optional(body.phone,'Telefone',30),email=optional(body.email,'Email',254).toLowerCase();
 if(phone&&!/^\+?[0-9 ()-]{7,30}$/.test(phone))throw error('Telefone do parceiro inválido.');if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw error('Email do parceiro inválido.');
 return tx(()=>{let id=body.id;if(id){if(supplierOnly)throw error('Sem permissão para editar parceiros.',403);if(!one('SELECT id FROM partners WHERE id=?',id))throw error('Parceiro inexistente.',404);run('UPDATE partners SET name=?,kind=?,phone=?,email=?,location=? WHERE id=?',name,kind,phone,email,location,id);}else id=Number(run('INSERT INTO partners(name,kind,phone,email,location,created_by) VALUES(?,?,?,?,?,?)',name,kind,phone,email,location,user.id).lastInsertRowid);audit(user,'Parceiro',`${body.id?'Atualizou':'Criou'} ${kind} #${id}: ${name}`);return {id,name};});}
 function supplierId(id){id=Number(id);if(!Number.isSafeInteger(id)||!one("SELECT id FROM partners WHERE id=? AND kind='fornecedor' AND active=1",id))throw error('Escolha um fornecedor registado.');return id;}
 function receive(body,user){
  if(['id','lot_id','initial','remaining','quantity','sale_enabled'].some(key=>Object.hasOwn(body,key)))throw error('Uma compra cria sempre um novo lote indisponível. Para devolver a um lote existente, registe uma devolução com motivo.');
  const p=one('SELECT * FROM products WHERE id=? AND active=1',recordId(body.product_id,'Produto'));if(!p)throw error('Produto inexistente.',404);
  const purchased=fiscalDate(body.purchased_on,'Data da compra'),expiry=fiscalDate(body.expires_on,'Data de expiração');
  if(purchased<'1900-01-01'||purchased>day())throw error('A data da compra deve ser válida e não pode estar no futuro.');
  if(expiry<purchased)throw error('A data de expiração não pode ser anterior à compra.');
  const packs=body.packs;if(typeof packs!=='number'||!Number.isFinite(packs)||packs<=0||packs>1e7)throw error('Número de embalagens inválido.');
  const quantity=units(Math.round(packs*p.pack_size*1000)/1000);if(p.unit==='un'&&quantity%1000)throw error('São necessárias unidades inteiras.');
  const supplier=supplierId(body.supplier_id),reason=body.reason===undefined||body.reason===null||typeof body.reason==='string'&&!body.reason.trim()?'Compra':descriptiveText(text(body.reason,'Referência'));
  if(body.pack_cost!==undefined&&(typeof body.pack_cost!=='number'||!Number.isFinite(body.pack_cost)))throw error('Custo da compra inválido.');
  const cost=body.pack_cost===undefined?p.pack_cost:Math.round(body.pack_cost*100);if(!Number.isSafeInteger(cost)||cost<0||cost>1e12||!Number.isSafeInteger(Math.round(packs*cost)))throw error('Custo da compra inválido.');
  return tx(()=>{
   const lot=Number(run('INSERT INTO lots(product_id,supplier_id,purchased_on,expires_on,initial,remaining,sale_enabled) VALUES(?,?,?,?,?,?,0)',p.id,supplier,purchased,expiry,quantity,quantity).lastInsertRowid);
   run('UPDATE products SET stock=ROUND(stock+?,3) WHERE id=?',quantity/1000,p.id);
   run("INSERT INTO movements(product_id,user_id,quantity,cost,reason,lot_id,kind) VALUES(?,?,?,?,?,?,'entrada')",p.id,user.id,quantity/1000,Math.round(packs*cost),reason,lot);
   audit(user,'Compra',`${p.name}: +${quantity/1000} ${p.unit}; lote #${lot}; compra ${purchased}; expiração ${expiry}; indisponível até autorização.`);
   return {id:lot,sale_enabled:false,purchased_on:purchased,expires_on:expiry};
  });
 }
 function lots(productId=null,includeEmpty=false){
  const clauses=[],args=[];if(!includeEmpty)clauses.push('l.remaining>0');if(productId!==null){clauses.push('l.product_id=?');args.push(recordId(productId,'Produto'));}
  return all(`SELECT l.*,p.name AS product,p.unit,p.expiry_warning_days,p.expiry_required,v.name AS supplier${includeEmpty?",(SELECT SUM(cost) FROM movements m WHERE m.lot_id=l.id AND m.kind='entrada') AS purchase_cost":''} FROM lots l JOIN products p ON p.id=l.product_id LEFT JOIN partners v ON v.id=l.supplier_id ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY COALESCE(l.purchased_on,date(l.received,'+1 hour')),l.received,l.id`,...args).map(l=>({...l,expiry_status:expiryStatus(l.expires_on,l.expiry_warning_days,day()),quantity:l.remaining/1000,expired:!!l.expires_on&&l.expires_on<day(),warning:!!l.expires_on&&l.expires_on<=new Date(Date.parse(day())+l.expiry_warning_days*86400000).toISOString().slice(0,10),unknown:!!l.legacy&&!l.expires_on}));
 }
 function productDetails(id,user){
  id=recordId(id,'Produto');const p=one('SELECT * FROM products WHERE id=? AND active=1',id);if(!p)throw error('Produto inexistente.',404);
  delete p.sale_enabled;p.physical_stock=p.stock;p.stock=available(id);p.expiry_status=stockHealth(id);
  if(!user.permissions.stock_edit&&!user.permissions.stock_entry)delete p.pack_cost;
  const details=user.permissions.warehouse||user.permissions.stock_entry?lots(id,true):[];
  if(!user.permissions.stock_edit&&!user.permissions.stock_entry)for(const lot of details)delete lot.purchase_cost;
  if(user.permissions.sales_cancel)for(const lot of details)lot.returnable_sales=all('SELECT DISTINCT s.id,s.created FROM sales s JOIN items i ON i.sale_id=s.id JOIN allocations a ON a.item_id=i.id WHERE a.lot_id=? AND NOT EXISTS(SELECT 1 FROM sale_cancellations c WHERE c.sale_id=s.id) ORDER BY s.id DESC',lot.id);
  return {product:p,lots:details};
 }
 function updateLot(body,user){
  if(['quantity','packs','initial','remaining','product_id','received','purchased_on','sale_enabled'].some(key=>Object.hasOwn(body,key)))throw error('Não pode acrescentar quantidades nem alterar a compra de um lote. Use Nova compra ou uma devolução com motivo.');
  const expiry=fiscalDate(body.expires_on,'Validade'),supplier=supplierId(body.supplier_id);
  return tx(()=>{const old=one('SELECT * FROM lots WHERE id=?',recordId(body.id,'Lote'));if(!old)throw error('Lote inexistente.',404);if(old.purchased_on&&expiry<old.purchased_on)throw error('A validade não pode ser anterior à compra.');
   run('UPDATE lots SET supplier_id=?,expires_on=?,legacy=0 WHERE id=?',supplier,expiry,old.id);
   audit(user,'Correção de lote',`Lote #${old.id}: fornecedor ${old.supplier_id||'desconhecido'} → ${supplier}; validade ${old.expires_on||'desconhecida'} → ${expiry}. Quantidades e data de compra preservadas.`);return {ok:true};
  });
 }
 function dispose(body,user){const quantity=units(body.quantity),reason=descriptiveText(text(body.reason,'Motivo')),kind=body.kind;if(!['desperdicio','expirado','outra_saida'].includes(kind))throw error('Tipo de saída inválido.');return tx(()=>{const lot=one('SELECT l.*,p.unit,p.name FROM lots l JOIN products p ON p.id=l.product_id WHERE l.id=?',recordId(body.lot_id,'Lote'));if(!lot)throw error('Lote inexistente.',404);if(quantity>lot.remaining)throw error('Quantidade insuficiente neste lote.');if(lot.unit==='un'&&quantity%1000)throw error('Use unidades inteiras.');if(kind==='expirado'&&(!lot.expires_on||lot.expires_on>=day()))throw error('O lote ainda não expirou.');run('UPDATE lots SET remaining=remaining-? WHERE id=?',quantity,lot.id);run('UPDATE products SET stock=ROUND(stock-?,3) WHERE id=?',quantity/1000,lot.product_id);run('INSERT INTO movements(product_id,user_id,quantity,cost,reason,lot_id,kind) VALUES(?,?,?,0,?,?,?)',lot.product_id,user.id,-quantity/1000,reason,lot.id,kind);audit(user,'Saída de armazém',`${kind}: ${lot.name}, lote #${lot.id}, ${quantity/1000} ${lot.unit}; motivo: ${reason}`);return {ok:true};});}
 function available(id){return (one('SELECT COALESCE(SUM(remaining),0) AS n FROM lots WHERE product_id=? AND sale_enabled=1 AND (expires_on>=? OR (expires_on IS NULL AND EXISTS(SELECT 1 FROM products p WHERE p.id=lots.product_id AND p.expiry_required=0)))',id,day()).n)/1000;}
 function stockHealth(id){
  const p=one('SELECT expiry_warning_days FROM products WHERE id=?',id);
  return productExpiryStatus(all('SELECT sale_enabled,remaining,expires_on FROM lots WHERE product_id=?',id),p.expiry_warning_days,day());
 }
 function saleLots(productId=null){
  const args=[day()];let filter='';if(productId!==null){filter=' AND l.product_id=?';args.push(recordId(productId,'Produto'));}
  return all(`SELECT l.id,l.product_id,l.purchased_on,l.received,l.expires_on,l.remaining/1000.0 AS quantity,p.expiry_warning_days FROM lots l JOIN products p ON p.id=l.product_id WHERE p.active=1 AND l.sale_enabled=1 AND l.remaining>0 AND (l.expires_on>=? OR (l.expires_on IS NULL AND p.expiry_required=0))${filter} ORDER BY COALESCE(l.purchased_on,date(l.received,'+1 hour')),l.received,l.id`,...args).map(l=>({...l,expiry_status:expiryStatus(l.expires_on,l.expiry_warning_days,day())}));
 }
 // Explicit selection consumes only that lot. Clients without a selection use FIFO.
 function allocate(itemId,product,quantity,user,saleId,selectedLot=null){
  let left=units(quantity);const args=[product,day()];if(selectedLot!==null)args.push(recordId(selectedLot,'Lote'));
  const lots=all(`SELECT * FROM lots WHERE product_id=? AND sale_enabled=1 AND remaining>0 AND (expires_on>=? OR (expires_on IS NULL AND EXISTS(SELECT 1 FROM products p WHERE p.id=lots.product_id AND p.expiry_required=0))) ${selectedLot===null?'':'AND id=?'} ORDER BY COALESCE(purchased_on,date(received,'+1 hour')),received,id`,...args);
  for(const lot of lots){const take=Math.min(left,lot.remaining);
   run('UPDATE lots SET remaining=remaining-? WHERE id=?',take,lot.id);
   run('INSERT INTO allocations(item_id,lot_id,quantity,expires_on_snapshot) VALUES(?,?,?,?)',itemId,lot.id,take,lot.expires_on);
   run("INSERT INTO movements(product_id,user_id,quantity,cost,reason,lot_id,kind,sale_id) VALUES(?,?,?,0,?,?,'venda',?)",product,user.id,-take/1000,`Venda - recibo #${saleId}`,lot.id,saleId);
   left-=take;if(!left)break;
  }
  if(left)throw error('O lote ou o stock mudou. Atualize a venda e confirme o lote e a quantidade.',409);
 }
 function cancel(body,user){const reason=descriptiveText(text(body.reason,body.lot_id!==undefined?'Motivo da devolução':'Motivo do cancelamento'));return tx(()=>{const sale=one('SELECT s.*,sh.closed FROM sales s JOIN shifts sh ON sh.id=s.shift_id WHERE s.id=?',body.id);if(!sale)throw error('Venda inexistente.',404);if(body.lot_id!==undefined&&!one('SELECT a.lot_id FROM allocations a JOIN items i ON i.id=a.item_id WHERE i.sale_id=? AND a.lot_id=?',sale.id,recordId(body.lot_id,'Lote')))throw error('O recibo não contém produtos deste lote.');if(one('SELECT sale_id FROM sale_cancellations WHERE sale_id=?',sale.id))throw error('Esta venda já foi cancelada.',409);let refund=null;if(sale.method==='dinheiro'){refund=sale.closed?one('SELECT id FROM shifts WHERE user_id=? AND closed IS NULL',user.id):{id:sale.shift_id};if(!refund)throw error('Abra um caixa seu para registar o reembolso de uma venda de turno já fechado.');const sh=one('SELECT opening FROM shifts WHERE id=?',refund.id);if(sh.opening+cashNet(refund.id)<sale.total)throw error('Dinheiro insuficiente no caixa escolhido para reembolsar a venda.');}
 run('INSERT INTO sale_cancellations(sale_id,actor_id,reason,refund_shift_id,cash_refund) VALUES(?,?,?,?,?)',sale.id,user.id,reason,refund?.id??null,sale.method==='dinheiro'?sale.total:0);
 for(const item of all('SELECT * FROM items WHERE sale_id=?',sale.id)){const allocations=all('SELECT * FROM allocations WHERE item_id=?',item.id);if(allocations.length){for(const a of allocations){run('UPDATE lots SET remaining=remaining+? WHERE id=?',a.quantity,a.lot_id);run("INSERT INTO movements(product_id,user_id,quantity,cost,reason,lot_id,kind,sale_id) VALUES(?,?,?,0,?,?,'devolucao',?)",item.product_id,user.id,a.quantity/1000,`Cancelamento do recibo #${sale.id}: ${reason}`,a.lot_id,sale.id);}}else {const lot=Number(run('INSERT INTO lots(product_id,initial,remaining,legacy) VALUES(?,?,?,1)',item.product_id,Math.round(item.quantity*1000),Math.round(item.quantity*1000)).lastInsertRowid);run("INSERT INTO movements(product_id,user_id,quantity,cost,reason,lot_id,kind,sale_id) VALUES(?,?,?,0,?,?,'devolucao',?)",item.product_id,user.id,item.quantity,`Cancelamento do recibo #${sale.id}: ${reason}`,lot,sale.id);}run('UPDATE products SET stock=ROUND(stock+?,3) WHERE id=?',item.quantity,item.product_id);}
 audit(user,'Cancelamento de venda',`Recibo #${sale.id}; ${sale.total/100} Kz; motivo: ${reason}; reembolso no turno #${refund?.id??'eletrónico'}.`);return {ok:true};});}
 function setAvailability(body,user){
  if(typeof body.enabled!=='boolean')throw error('Disponibilidade inválida.');
  return tx(()=>{const lot=one('SELECT l.*,p.name,p.active,p.expiry_required FROM lots l JOIN products p ON p.id=l.product_id WHERE l.id=?',recordId(body.id,'Lote'));if(!lot||!lot.active)throw error('Lote inexistente.',404);
   if(body.enabled&&(!lot.remaining||lot.expires_on&&lot.expires_on<day()||!lot.expires_on&&lot.expiry_required))throw error('Este lote não tem stock válido para disponibilizar.');
   run('UPDATE lots SET sale_enabled=? WHERE id=?',Number(body.enabled),lot.id);
   audit(user,'Disponibilidade de lote',`${lot.name}, lote #${lot.id}: ${body.enabled?'disponibilizado':'retirado da venda'}.`);return {ok:true};
  });
 }
 function history(body,user){
  const clauses=[],args=[],kinds=['entrada','venda','devolucao','desperdicio','expirado','outra_saida'];
  if(body.kind){if(!kinds.includes(body.kind))throw error('Tipo de movimento inválido.');clauses.push('m.kind=?');args.push(body.kind);}
  if(body.direction){if(!['entrada','saida'].includes(body.direction))throw error('Direção inválida.');clauses.push(body.direction==='entrada'?'m.quantity>0':'m.quantity<0');}
  for(const [key,column] of [['product_id','m.product_id'],['lot_id','m.lot_id'],['sale_id','m.sale_id']])if(body[key]){const id=Number(body[key]);if(!Number.isSafeInteger(id)||id<1)throw error('Identificador de filtro inválido.');clauses.push(column+'=?');args.push(id);}
  for(const [key,op] of [['start','>='],['end','<=']])if(body[key]){clauses.push(`date(m.created,'+1 hour')${op}?`);args.push(fiscalDate(body[key],'Data do filtro'));}
  if(body.start&&body.end&&body.start>body.end)throw error('A data inicial não pode ser posterior à final.');
  if(body.q){const q=fold(text(body.q,'Pesquisa',150));clauses.push("instr(warehouse_search(p.name||' '||COALESCE(p.barcode,'')||' '||u.name||' '||m.reason||' '||COALESCE(m.sale_id,'')||' '||COALESCE(m.lot_id,'')),?)>0");args.push(q);}
  const page=Number(body.page??1);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw error('Página inválida.');
  const from='FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id'+(clauses.length?' WHERE '+clauses.join(' AND '):'');
  const count=one('SELECT COUNT(*) AS n '+from,...args).n,pages=Math.max(1,Math.ceil(count/50)),current=Math.min(page,pages);
  const movements=all('SELECT m.*,p.name AS product,p.unit,u.name AS actor '+from+' ORDER BY m.created DESC,m.id DESC LIMIT 50 OFFSET ?',...args,(current-1)*50);
  if(!user.permissions.stock_edit&&!user.permissions.stock_entry)for(const m of movements)delete m.cost;
  return {movements,count,page:current,pages,page_size:50};
 }
 function cashNet(id){return one("SELECT COALESCE((SELECT SUM(total) FROM sales WHERE shift_id=? AND method='dinheiro'),0)-COALESCE((SELECT SUM(cash_refund) FROM sale_cancellations WHERE refund_shift_id=?),0) AS n",id,id).n;}
 return {stockHealth,saleLots,history,productDetails,setAvailability,registers,configureRegisters,pinFor,checkPin,allPins:()=>{refreshPins();return all('SELECT u.id,u.name,p.cipher,p.expires_at FROM users u JOIN cash_pins p ON p.user_id=u.id WHERE u.active=1 AND u.deleted_at IS NULL').map(u=>({id:u.id,name:u.name,code:decrypt(u.cipher),expires_at:u.expires_at}));},suppliers,partner,partners:()=>all('SELECT * FROM partners ORDER BY name'),receive,lots,updateLot,dispose,available,allocate,cancel,cashNet};
}
