import {operations} from './operations.js';
import {permissions,permissionLabels,sellerKeys,permissionKeys,profileLabels} from './public/permissions.js';
import {titleName,descriptiveText,nameError,gmailValid} from './public/validation.js';
import http from 'node:http';
import {calculateTaxBasket} from './public/tax.js';
import {migrateFiscal,fiscalState,saveFiscalSettings,saveTaxRule,taxReport} from './fiscal.js';
import { settlement, compareAmounts, formatMoney } from './public/calculations.js';
import { Recovery, deliveryStatus, sendRecovery } from './recovery.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const dir = process.env.DATA_DIR || './data';
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(resolve(dir, 'loja.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('proprietario','gerente','vendedor')),active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,unit TEXT NOT NULL,barcode TEXT UNIQUE,stock REAL NOT NULL DEFAULT 0 CHECK(stock>=0),minimum REAL NOT NULL DEFAULT 5,pack_type TEXT NOT NULL,pack_size REAL NOT NULL CHECK(pack_size>0),pack_cost INTEGER NOT NULL,price INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),opened TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,closed TEXT,opening INTEGER NOT NULL,closing INTEGER,expected INTEGER);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),shift_id INTEGER REFERENCES shifts(id),created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,customer TEXT NOT NULL,subtotal INTEGER NOT NULL,discount INTEGER NOT NULL,total INTEGER NOT NULL,paid INTEGER NOT NULL,change_due INTEGER NOT NULL,method TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY,sale_id INTEGER REFERENCES sales(id),product_id INTEGER REFERENCES products(id),name TEXT NOT NULL,unit TEXT NOT NULL,quantity REAL NOT NULL,price INTEGER NOT NULL,total INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),created TEXT DEFAULT CURRENT_TIMESTAMP,action TEXT NOT NULL,detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY,product_id INTEGER REFERENCES products(id),user_id INTEGER REFERENCES users(id),created TEXT DEFAULT CURRENT_TIMESTAMP,quantity REAL NOT NULL,cost INTEGER NOT NULL,reason TEXT NOT NULL);
`);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
migrateFiscal(db);
// Additive migration preserves existing shop records.
const columns=new Set(all('PRAGMA table_info(users)').map(c=>c.name));
for(const column of ['email','bi','birth_date','phone']) if(!columns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS users_bi ON users(bi COLLATE NOCASE);
CREATE TRIGGER IF NOT EXISTS immutable_identity BEFORE UPDATE OF name,bi,birth_date ON users
WHEN NEW.name IS NOT OLD.name OR (OLD.bi IS NOT NULL AND NEW.bi IS NOT OLD.bi) OR (OLD.birth_date IS NOT NULL AND NEW.birth_date IS NOT OLD.birth_date)
BEGIN SELECT RAISE(ABORT,'Identidade imutável'); END;`);
const extraColumns=new Set(all('PRAGMA table_info(users)').map(c=>c.name));
if(!extraColumns.has('deleted_at')) db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
if(!extraColumns.has('permissions')) db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}'");
if(!extraColumns.has('must_change_password')) transaction(()=>{
 db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
 UPDATE users SET must_change_password=1
 WHERE COALESCE((SELECT MAX(id) FROM audit WHERE user_id=users.id AND action='Segurança' AND detail='Alterou a sua palavra-passe'),0)
 <= COALESCE((SELECT MAX(id) FROM audit WHERE action='Segurança' AND detail='Repôs a palavra-passe da conta #'||users.id),0);`);
});
const sessionColumns=new Set(all('PRAGMA table_info(sessions)').map(c=>c.name));
if(!sessionColumns.has('recovery')) db.exec('ALTER TABLE sessions ADD COLUMN recovery INTEGER NOT NULL DEFAULT 0');
// Preserve historical accounts while normalising legacy duplicate leadership roles.
transaction(()=>{
 for(const role of ['proprietario','gerente']) {
  const holders=all('SELECT id FROM users WHERE role=? AND deleted_at IS NULL ORDER BY active DESC,id',role);
  for(const holder of holders.slice(1)){run("UPDATE users SET role='vendedor' WHERE id=?",holder.id);audit({id:holders[0].id},'Migração de permissões',`Conta #${holder.id} passou a vendedor: apenas um ${role} permitido.`);}
 }
 run("UPDATE users SET username='account:'||id WHERE username NOT LIKE 'account:%'");
});
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users(role) WHERE role='proprietario' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_manager ON users(role) WHERE role='gerente' AND deleted_at IS NULL;`);
const ops=operations(db,dir,audit);
function generatePassword(){return 'Tt!'+randomBytes(12).toString('base64url')+randomInt(10,100);}
function validPassword(value){
 if(typeof value!=='string' || value.length<8 || value.length>200 || !/[a-zA-Z]/.test(value) || !/\d/.test(value) || !/[^a-zA-Z0-9\s]/.test(value)) fail('A palavra-passe deve ter pelo menos 8 caracteres, letras, números e um carácter especial.');
 return value;
}
function session(res,id,recovery=false){
 const token=randomBytes(32).toString('hex');
 run('DELETE FROM sessions WHERE expires<?',Date.now());
 run('INSERT INTO sessions(token,user_id,expires,recovery) VALUES(?,?,?,?)',token,id,Date.now()+(recovery?600000:43200000),Number(recovery));
 res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${recovery?600:43200}${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);
}
const recovery=new Recovery(db);
function contacts(body) {
 const email=text(body.email,'Email',254).toLowerCase();
 if(!gmailValid(email)) fail('Use um email Gmail válido, por exemplo nome@gmail.com.');
 const phone=String(body.phone??'').trim();
 if(!phone)return {email,phone:''};
 if(phone.length>30)fail('Telefone inválido.');
 if(!/^\+?[\d ()-]{7,30}$/.test(phone)) fail('Telefone inválido.');
 const digits=phone.replace(/\D/g,'');
 const normalised=phone.startsWith('+')?'+'+digits:digits.length===9?'+244'+digits:'+'+digits;
 if(!/^\+[1-9]\d{6,14}$/.test(normalised)) fail('Use um telefone válido com indicativo, por exemplo +244 923 456 789.');
 return {email,phone:normalised};
}
function identity(body) {
 const name=titleName(text(body.name,'Nome')),bi=text(body.bi,'BI',14).toUpperCase(),birth_date=text(body.birth_date,'Data de nascimento',10);
 if(nameError(name))fail(nameError(name));
 if(!/^\d{9}[A-Z]{2}\d{3}$/.test(bi)) fail('BI inválido. Exemplo: 009763932CA042.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(birth_date) || Number.isNaN(Date.parse(birth_date)) || new Date(birth_date).toISOString().slice(0,10)!==birth_date || birth_date>new Date().toISOString().slice(0,10) || birth_date<'1900-01-01') fail('Data de nascimento inválida.');
 return {name,bi,birth_date,...contacts(body)};
}
function rejectIdentity(body) { if(['name','bi','birth_date'].some(k=>Object.hasOwn(body,k))) fail('Nome, BI e data de nascimento não podem ser alterados.'); }
function createUser(body,role) {
 const p=identity(body), password=generatePassword();
 if(role!=='vendedor' && one('SELECT id FROM users WHERE role=? AND deleted_at IS NULL',role)) fail(`Já existe um ${role==='gerente'?'gerente':'proprietário'}.`,409);
 const id=Number(run('INSERT INTO users(name,username,password,role,email,bi,birth_date,phone,must_change_password) VALUES(?,?,?,?,?,?,?,?,1)',p.name,'account:'+randomBytes(16).toString('hex'),hash(password),role,p.email,p.bi,p.birth_date,p.phone).lastInsertRowid);
 return {id,email:p.email,password};
}
function hash(password) { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); }
function verify(password, stored) { const [salt, key] = stored.split(':'); return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, 'hex')); }
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(v, label, max = 150) { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(`${label} inválido.`); return v.trim(); }
function number(v, label, min = 0, max = 1e10) { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${label} inválido.`); return v; }
const money = (v, label) => Math.round(number(v, label) * 100);
function audit(user, action, detail) { run('INSERT INTO audit(user_id,action,detail) VALUES(?,?,?)', user.id, action, detail); }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function manage(user) { if (!['gerente','proprietario'].includes(user.role)) fail('Acesso reservado ao gerente e proprietário.', 403); }
function receipt(id) {
 const sale=one('SELECT s.*,u.name AS seller,(SELECT created FROM sale_cancellations WHERE sale_id=s.id) AS cancelled_at,(SELECT r.number FROM registers r JOIN shifts sh ON sh.register_id=r.id WHERE sh.id=s.shift_id) AS register_number FROM sales s JOIN users u ON u.id=s.user_id WHERE s.id=?',id);
 return {...sale,register:one('SELECT r.number,r.name FROM registers r JOIN shifts sh ON sh.register_id=r.id WHERE sh.id=?',sale?.shift_id??0),cancellation:one('SELECT c.*,u.name AS actor FROM sale_cancellations c JOIN users u ON u.id=c.actor_id WHERE c.sale_id=?',id),fiscal_snapshot:sale?.fiscal_snapshot?JSON.parse(sale.fiscal_snapshot):null,items:all('SELECT * FROM items WHERE sale_id=?',id).map(i=>({...i,lots:all('SELECT a.lot_id,a.quantity/1000.0 AS quantity,a.expires_on_snapshot AS expires_on FROM allocations a WHERE a.item_id=?',i.id),tax_snapshot:i.tax_snapshot?JSON.parse(i.tax_snapshot):null}))};
}
const attempts = new Map();
async function api(req, res, path, body) {
  if (path === '/api/setup' && req.method === 'GET') return { required: !one('SELECT id FROM users LIMIT 1') };
  if (path === '/api/setup' && req.method === 'POST') {
    if (one('SELECT id FROM users LIMIT 1')) fail('Configuração já concluída.', 409);
    return transaction(()=>{const result=createUser(body,'proprietario');audit({id:result.id},'Conta inicial','Criou o proprietário');return result;});
  }
  if(path==='/api/recovery/options' && req.method==='GET') return deliveryStatus();
  if(path==='/api/recovery/request' && req.method==='POST') {
    const channel=body.channel;if(!['email','sms'].includes(channel)) fail('Escolha email ou SMS.');
    if(!deliveryStatus()[channel]) fail('O envio por este canal ainda não está configurado. Contacte o proprietário para repor o acesso.',503);
    const identifier=text(body.identifier,'Email ou BI',254);
    const result=await recovery.request(identifier,channel,req.socket.remoteAddress,sendRecovery);
    return result;
  }
  if(path==='/api/recovery/verify' && req.method==='POST') {
    const id=recovery.verify(body.challenge,body.code,req.socket.remoteAddress);
    if(!id) fail('Código inválido, expirado ou já utilizado. Solicite outro código.',400);
    session(res,id,true);audit({id},'Recuperação de acesso','Entrou com código temporário; alteração da palavra-passe pendente.');
    return {ok:true,reset_required:true};
  }
  if (path === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress, now = Date.now();
    const attempt = attempts.get(ip) || { count: 0, until: now + 600000 };
    if (attempt.until < now) { attempt.count = 0; attempt.until = now + 600000; }
    if (attempt.count >= 15) fail('Muitas tentativas. Aguarde 10 minutos.',429);
    attempt.count++; attempts.set(ip,attempt);
    const identifier=String(body.identifier || '').trim();
    const user = one('SELECT * FROM users WHERE (email=? COLLATE NOCASE OR bi=? COLLATE NOCASE) AND active=1 AND deleted_at IS NULL',identifier,identifier);
    if (!user || !verify(String(body.password || ''), user.password)) fail('Email / BI ou palavra-passe incorretos.',401);
    attempts.delete(ip);
    session(res,user.id);
    return { ok: true };
  }
  const token = /(?:^|;\s*)session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const user = one('SELECT u.id,u.name,u.email,u.bi,u.birth_date,u.phone,u.role,u.permissions,u.job_type,u.must_change_password,s.recovery FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1 AND u.deleted_at IS NULL',token || '',Date.now());
  if (!user) fail('Inicie sessão para continuar.',401);
  user.permissions=permissions(user.role,JSON.parse(user.permissions||'{}'),user.job_type);
  const allow=key=>{if(!user.permissions[key])fail('Sem permissão para esta área ou operação.',403);};
  if (path === '/api/logout' && req.method === 'POST') { run('DELETE FROM sessions WHERE token=?',token); res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return { ok:true }; }
  if((user.recovery||user.must_change_password) && !['/api/state','/api/password','/api/logout'].includes(path)) fail('Defina uma nova palavra-passe para aceder à loja.',403);
  if((user.recovery||user.must_change_password) && path==='/api/state' && req.method==='GET') return {user,recovery_required:!!user.recovery,password_change_required:!!user.must_change_password};
  if(path==='/api/account/pin'&&req.method==='GET')return ops.pinFor(user.id);
  if(path==='/api/cash/pins'&&req.method==='GET'){allow('view_all_pins');return {pins:ops.allPins()};}
  if(path==='/api/registers'&&req.method==='GET'){if(!user.permissions.cash&&!user.permissions.cash_manage)fail('Sem acesso aos balcões.',403);return {registers:ops.registers()};}
  if(path==='/api/registers/config'&&req.method==='POST'){allow('cash_manage');if(!['proprietario','gerente'].includes(user.role))fail('Apenas a direção configura balcões.',403);return ops.configureRegisters(body,user);}
  if(path==='/api/partners'&&req.method==='GET'){allow('partners_view');return {partners:ops.partners()};}
  if(path==='/api/partners'&&req.method==='POST'){allow('partners_edit');return ops.partner(body,user);}
  if(path==='/api/suppliers'&&req.method==='GET'){allow('stock_entry');return {suppliers:ops.suppliers()};}
  if(path==='/api/suppliers'&&req.method==='POST'){allow('supplier_create');allow('stock_entry');return ops.partner(body,user,true);}
  if(path==='/api/warehouse/history'&&req.method==='POST'){allow('warehouse');return ops.history(body,user);}
  if(path==='/api/lots/availability'&&req.method==='POST'){allow('stock_entry');return ops.setAvailability(body,user);}
  if(/^\/api\/warehouse\/products\/\d+$/.test(path)&&req.method==='GET'){if(!user.permissions.products&&!user.permissions.warehouse&&!user.permissions.stock_entry)fail('Sem acesso ao armazém.',403);return ops.productDetails(Number(path.split('/').pop()),user);}
  if(path==='/api/warehouse/return'&&req.method==='POST'){allow('sales_cancel');if(['quantity','items','packs'].some(key=>Object.hasOwn(body,key)))fail('A devolução é integral e usa as quantidades originais do recibo.');if(!Number.isSafeInteger(body.sale_id)||!Number.isSafeInteger(body.lot_id))fail('Indique o recibo e o lote da devolução.');return ops.cancel({id:body.sale_id,lot_id:body.lot_id,reason:body.reason},user);}
  if(path==='/api/warehouse'&&req.method==='GET'){allow('warehouse');const lots=ops.lots();if(!user.permissions.stock_edit&&!user.permissions.stock_entry)for(const lot of lots)delete lot.purchase_cost;return {lots};}
  if(path==='/api/lots/update'&&req.method==='POST'){allow('stock_entry');return ops.updateLot(body,user);}
  if(path==='/api/warehouse/dispose'&&req.method==='POST'){allow('stock_exit');return ops.dispose(body,user);}
  if(path==='/api/sales/cancel'&&req.method==='POST'){allow('sales_cancel');return ops.cancel(body,user);}
  if(path==='/api/stock'&&req.method==='POST'){allow('stock_entry');return ops.receive(body,user);}
  // PIN failures must commit outside the opening transaction to prevent retry bypass.
  if(path==='/api/shifts/open'&&req.method==='POST'){allow('cash');ops.checkPin(user,body.pin);}
  if(req.method==='POST'){
   if(path.startsWith('/api/users')&&path!=='/api/users/transfer-owner')allow('users');
   if(path==='/api/products')allow('stock_edit');
   if(path==='/api/products/tax'){allow('stock_edit');allow('fiscal');}
   if(path.startsWith('/api/fiscal/'))allow('fiscal');
   if(path.startsWith('/api/shifts/'))allow('cash');
   if(path==='/api/sales')allow('sales');
  }
  if(/^\/api\/sales\/\d+$/.test(path)&&!['sales','cash','history','dashboard'].some(key=>user.permissions[key]))fail('Sem acesso aos recibos.',403);
  if(path==='/api/sales/history'&&req.method==='POST'){
    allow('history');
    const leader=user.role!=='vendedor'||user.permissions.sales_cancel,scope=body.scope??(leader?'all':'mine');
    if(!leader&&scope!=='mine')fail('Só pode consultar as vendas dos seus próprios caixas.',403);
    if(scope!=='all'&&scope!=='mine'&&(!/^\d+$/.test(String(scope))||!Number.isSafeInteger(Number(scope))||Number(scope)<1))fail('Filtro de vendedor inválido.');
    const clauses=[],args=[];
    if(scope!=='all'){const actor=scope==='mine'?user.id:Number(scope);clauses.push('s.user_id=? AND EXISTS (SELECT 1 FROM shifts sh WHERE sh.id=s.shift_id AND sh.user_id=?)');args.push(actor,actor);}
    for(const [key,operator] of [['start','>='],['end','<=']])if(body[key]){
      const day=String(body[key]);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)fail('Data de filtro inválida.');
      clauses.push(`date(s.created,'+1 hour')${operator}?`);args.push(day);
    }
    if(body.start&&body.end&&body.start>body.end)fail('A data inicial não pode ser posterior à data final.');
    if(body.method){if(!['dinheiro','tpa','transferencia'].includes(body.method))fail('Pagamento inválido.');clauses.push('s.method=?');args.push(body.method);}
    if(body.shift_id){const id=Number(body.shift_id);if(!Number.isSafeInteger(id)||id<1)fail('Caixa inválido.');clauses.push('s.shift_id=?');args.push(id);}
    if(body.register_id){const id=Number(body.register_id);if(!Number.isSafeInteger(id)||id<1)fail('Balcão inválido.');clauses.push('s.shift_id IN(SELECT id FROM shifts WHERE register_id=?)');args.push(id);}
    const searchBy=body.search_by??'receipt',searchColumns={receipt:"printf('%05d',s.id)",customer:'s.customer',seller:'u.name'};
    if(!Object.hasOwn(searchColumns,searchBy))fail('Filtro de pesquisa inválido.');
    if(body.q){const q=String(body.q).trim();if(q.length>150)fail('Pesquisa demasiado longa.');clauses.push(`instr(lower(${searchColumns[searchBy]}),lower(?))>0`);args.push(q);}
    const page=Number(body.page??1),size=50;if(!Number.isSafeInteger(page)||page<1||page>1000000)fail('Página inválida.');
    const from='FROM sales s JOIN users u ON u.id=s.user_id'+(clauses.length?' WHERE '+clauses.join(' AND '):'');
    const summary=one('SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM sale_cancellations c WHERE c.sale_id=s.id) THEN s.total ELSE 0 END),0) AS total '+from,...args);
    const pages=Math.max(1,Math.ceil(summary.count/size)),current=Math.min(page,pages);
    return {sales:all('SELECT s.*,u.name AS seller,(SELECT created FROM sale_cancellations WHERE sale_id=s.id) AS cancelled_at,(SELECT r.number FROM registers r JOIN shifts sh ON sh.register_id=r.id WHERE sh.id=s.shift_id) AS register_number '+from+' ORDER BY s.id DESC LIMIT ? OFFSET ?',...args,size,(current-1)*size),summary,page:current,pages,page_size:size,
      sellers:leader?all("SELECT id,name,deleted_at FROM users WHERE id=? OR EXISTS (SELECT 1 FROM sales s WHERE s.user_id=users.id) ORDER BY name",user.id):[]};
  }
  if (path === '/api/state' && req.method === 'GET') {
    const manager = user.role !== 'vendedor'||user.permissions.sales_cancel,p=user.permissions;
    const viewSales=p.history||p.dashboard;
    const products = all('SELECT * FROM products WHERE active=1 ORDER BY name');
    if(!p.products&&!p.sales&&!p.dashboard&&!p.stock_entry&&!p.warehouse)products.length=0;
    for(const product of products){product.physical_stock=product.stock;product.stock=ops.available(product.id);delete product.sale_enabled;}
    if (!p.stock_edit&&!p.stock_entry) for (const product of products) delete product.pack_cost;
    const currentShift=one("SELECT s.*,(SELECT COALESCE(SUM(total),0) FROM sales WHERE shift_id=s.id AND method='dinheiro') AS cash_sales FROM shifts s WHERE user_id=? AND closed IS NULL",user.id);
    if(currentShift)currentShift.cash_sales=ops.cashNet(currentShift.id);
    const cashSummary=currentShift?one("SELECT COUNT(*) AS sales_count,COALESCE(SUM(total),0) AS total_sales,COALESCE(SUM(CASE WHEN method='dinheiro' THEN total ELSE 0 END),0) AS cash_total,COALESCE(SUM(CASE WHEN method='tpa' THEN total ELSE 0 END),0) AS tpa_total,COALESCE(SUM(CASE WHEN method='transferencia' THEN total ELSE 0 END),0) AS transfer_total,MAX(created) AS last_sale_at FROM sales WHERE shift_id=? AND NOT EXISTS(SELECT 1 FROM sale_cancellations c WHERE c.sale_id=sales.id)",currentShift.id):null;
    if(cashSummary)cashSummary.cash_total=ops.cashNet(currentShift.id);
    const cashRecent=currentShift?all('SELECT s.*,u.name AS seller,(SELECT created FROM sale_cancellations WHERE sale_id=s.id) AS cancelled_at,(SELECT r.number FROM registers r JOIN shifts sh ON sh.register_id=r.id WHERE sh.id=s.shift_id) AS register_number FROM sales s JOIN users u ON u.id=s.user_id WHERE shift_id=? ORDER BY s.id DESC LIMIT 5',currentShift.id):[];
    return { user, products, registers:(p.cash||p.cash_manage)?ops.registers():[],expiry_alerts:p.warehouse?ops.lots().filter(l=>l.warning||l.unknown):[],sale_products:products.filter(product=>product.stock>0),fiscal:fiscalState(db), current_shift:p.cash?currentShift:null,cash_summary:p.cash?cashSummary:null,cash_recent:p.cash?cashRecent:[], sales: viewSales?all(`SELECT s.*,u.name AS seller,(SELECT created FROM sale_cancellations WHERE sale_id=s.id) AS cancelled_at,(SELECT r.number FROM registers r JOIN shifts sh ON sh.register_id=r.id WHERE sh.id=s.shift_id) AS register_number FROM sales s JOIN users u ON u.id=s.user_id ${manager ? '' : 'WHERE s.user_id=? AND EXISTS (SELECT 1 FROM shifts own WHERE own.id=s.shift_id AND own.user_id=s.user_id)'} ORDER BY s.id DESC LIMIT ${p.history?100:5}`, ...(manager ? [] : [user.id])):[],
      shifts: p.cash?all(`SELECT s.*,u.name AS seller,(SELECT COALESCE(SUM(total),0) FROM sales WHERE shift_id=s.id AND method='dinheiro') - (SELECT COALESCE(SUM(cash_refund),0) FROM sale_cancellations WHERE refund_shift_id=s.id) AS cash_sales FROM shifts s JOIN users u ON u.id=s.user_id ${manager ? '' : 'WHERE s.user_id=?'} ORDER BY s.id DESC LIMIT 50`,...(manager ? [] : [user.id])):[],
      users: p.users ? all('SELECT id,name,email,bi,birth_date,phone,role,active,permissions,job_type FROM users WHERE deleted_at IS NULL ORDER BY id').map(u=>({...u,permissions:permissions(u.role,JSON.parse(u.permissions||'{}'),u.job_type)})) : [],
      purchases: (p.stock_edit||p.stock_entry) ? all("SELECT m.*,p.name AS product,p.unit,u.name AS actor FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id WHERE m.kind='entrada' ORDER BY m.id DESC LIMIT 100") : [],
      audit: p.activity ? all('SELECT a.*,u.name AS actor FROM audit a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100') : [],
      chart: p.dashboard?all(`SELECT date(created,'+1 hour') AS day, SUM(total) AS total,COUNT(*) AS count FROM sales WHERE NOT EXISTS(SELECT 1 FROM sale_cancellations c WHERE c.sale_id=sales.id) AND datetime(created,'+1 hour')>=date('now','+1 hour','-13 days') ${manager ? '' : 'AND user_id=?'} GROUP BY date(created,'+1 hour') ORDER BY day`,...(manager ? [] : [user.id])):[],
      metrics: p.dashboard?one(`SELECT COALESCE(SUM(CASE WHEN date(created,'+1 hour')=date('now','+1 hour') THEN total ELSE 0 END),0) AS today,COUNT(CASE WHEN date(created,'+1 hour')=date('now','+1 hour') THEN 1 END) AS count,COALESCE(SUM(CASE WHEN datetime(created,'+1 hour')>=date('now','+1 hour','-6 days') THEN total ELSE 0 END),0) AS current_week,COALESCE(SUM(CASE WHEN datetime(created,'+1 hour')>=date('now','+1 hour','-13 days') AND datetime(created,'+1 hour')<date('now','+1 hour','-6 days') THEN total ELSE 0 END),0) AS previous_week FROM sales WHERE NOT EXISTS(SELECT 1 FROM sale_cancellations c WHERE c.sale_id=sales.id) ${manager ? '' : 'AND user_id=?'}`,...(manager ? [] : [user.id])):{today:0,count:0,current_week:0,previous_week:0} };
  }
  if(path==='/api/fiscal/settings' && req.method==='POST') return transaction(()=>{
    const result=saveFiscalSettings(db,body,user);audit(user,'Configuração fiscal',`Regime ${body.regime}; cálculo de IVA ${body.enabled?'ativo':'pendente'}; preços ${body.price_mode==='included'?'com IVA incluído':'sem IVA'}.`);return result;
  });
  if(path==='/api/fiscal/rules' && req.method==='POST') return transaction(()=>{
    const previous=body.id?one('SELECT * FROM tax_rules WHERE id=?',body.id):null;
    const result=saveTaxRule(db,body,user);audit(user,'Regra de IVA',`${body.id?'Alterou':'Criou'} regra #${result.id}: ${body.name}, ${body.rate}%, ${body.kind}; anterior ${previous?previous.rate_bps/100+'%':'nenhuma'}.`);return result;
  });
  if(path==='/api/fiscal/report' && req.method==='POST'){allow('fiscal');return taxReport(db,body);}
  if(path==='/api/products/tax' && req.method==='POST') return transaction(()=>{
    allow('stock_edit');const rule=one('SELECT * FROM tax_rules WHERE id=? AND active=1',body.tax_rule_id);
    if(!rule)fail('Escolha uma regra fiscal ativa.');
    if(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>500||body.ids.some(id=>!Number.isSafeInteger(id)))fail('Escolha de 1 a 500 produtos.');
    for(const id of new Set(body.ids)){if(!one('SELECT id FROM products WHERE id=?',id))fail('Produto inexistente.');run('UPDATE products SET tax_rule_id=? WHERE id=?',rule.id,id);}
    audit(user,'Classificação fiscal',`Aplicou a regra #${rule.id} a ${new Set(body.ids).size} produtos.`);return {ok:true};
  });
  if (path === '/api/products' && req.method === 'POST') {
    allow('stock_edit');
    if(nameError(body.name,true))fail(nameError(body.name,true));
    const name=titleName(text(body.name,'Produto')), category=descriptiveText(text(body.category,'Categoria')), unit=text(body.unit,'Unidade'), pack=descriptiveText(text(body.pack_type,'Embalagem'));
    if (!['un','kg','L','g','mL'].includes(unit)) fail('Unidade não suportada.');
    const size=number(body.pack_size,'Conteúdo da embalagem',0.001), cost=money(body.pack_cost,'Custo'), price=money(body.price,'Preço'), minimum=number(body.minimum,'Stock mínimo'), barcode=body.barcode ? text(body.barcode,'Código de barras',80) : null;
    return transaction(()=>{
      let taxRule=body.tax_rule_id===undefined?(body.id?one('SELECT tax_rule_id FROM products WHERE id=?',body.id)?.tax_rule_id:null):body.tax_rule_id;
      if(taxRule!==null&&taxRule!==''&&taxRule!==undefined){taxRule=Number(taxRule);if(!Number.isSafeInteger(taxRule)||!one('SELECT id FROM tax_rules WHERE id=? AND active=1',taxRule))fail('Regra fiscal inválida ou inativa.');}else taxRule=null;
      const oldRule=body.id?one('SELECT tax_rule_id FROM products WHERE id=?',body.id)?.tax_rule_id:null;
      if(taxRule!==(oldRule??null))allow('fiscal');
      let id;
      if (body.id) {
        const existing=one('SELECT * FROM products WHERE id=?',body.id);
        if (!existing) fail('Produto inexistente.',404);
        if (existing.unit!==unit && (existing.stock>0 || one('SELECT id FROM items WHERE product_id=? LIMIT 1',body.id))) fail('Não pode alterar a unidade de um produto com stock ou vendas. Crie outro produto.');
        run('UPDATE products SET name=?,category=?,unit=?,barcode=?,minimum=?,pack_type=?,pack_size=?,pack_cost=?,price=? WHERE id=?',name,category,unit,barcode,minimum,pack,size,cost,price,body.id); id=body.id;
      } else { id=Number(run('INSERT INTO products(name,category,unit,barcode,minimum,pack_type,pack_size,pack_cost,price) VALUES(?,?,?,?,?,?,?,?,?)',name,category,unit,barcode,minimum,pack,size,cost,price).lastInsertRowid); }
      if(body.sale_enabled!==undefined)fail('A disponibilidade é definida por lote, depois de guardar a compra.');
      if(body.expiry_required!==undefined&&typeof body.expiry_required!=='boolean')fail('Indique se o produto tem validade.');
      const expiryRequired=body.expiry_required===undefined?(body.id?one('SELECT expiry_required FROM products WHERE id=?',id).expiry_required:0):Number(body.expiry_required===true);
      const warning=body.expiry_warning_days??(body.id?one('SELECT expiry_warning_days FROM products WHERE id=?',id).expiry_warning_days:7);if(!Number.isInteger(warning)||warning<1||warning>3650)fail('O alerta de validade deve estar entre 1 e 3650 dias.');
      run('UPDATE products SET tax_rule_id=?,expiry_required=?,expiry_warning_days=? WHERE id=?',taxRule,expiryRequired,warning,id);
      audit(user,'Produto',`${body.id ? 'Atualizou' : 'Criou'} ${name}`); return {id};
    });
  }
  if (path === '/api/shifts/open' && req.method === 'POST') return transaction(()=>{
    if (one('SELECT id FROM shifts WHERE user_id=? AND closed IS NULL',user.id)) fail('Já tem um caixa aberto.');
    const register=one('SELECT * FROM registers WHERE id=? AND active=1',body.register_id);if(!register)fail('Escolha um balcão disponível.');
    if(one('SELECT id FROM shifts WHERE register_id=? AND closed IS NULL',register.id))fail('Este balcão já está ocupado.',409);
    const id=Number(run('INSERT INTO shifts(user_id,opening,register_id) VALUES(?,?,?)',user.id,money(body.opening,'Fundo inicial'),register.id).lastInsertRowid);audit(user,'Abertura de caixa',`Balcão ${register.number}; turno #${id}`);return {id,register_id:register.id};
  });
  if (path === '/api/shifts/close' && req.method === 'POST') return transaction(()=>{
    const shift=one('SELECT * FROM shifts WHERE user_id=? AND closed IS NULL',user.id); if (!shift) fail('Não tem caixa aberto.');
    const expected=shift.opening+ops.cashNet(shift.id);
    const closing=money(body.closing,'Valor contado'),comparison=compareAmounts(expected,closing);if(!comparison.ok)fail(comparison.error); run('UPDATE shifts SET closed=CURRENT_TIMESTAMP,closing=?,expected=? WHERE id=?',closing,expected,shift.id); audit(user,'Fecho de caixa',`Caixa #${shift.id}; diferença ${(closing-expected)/100} Kz`); return {expected,closing,difference:comparison.difference,warning:comparison.shortfall?`Valor em caixa insuficiente. Faltam ${formatMoney(comparison.shortfall)} face ao esperado.`:comparison.excess?`Existem ${formatMoney(comparison.excess)} a mais no caixa.`:null};
  });
  if (path === '/api/sales' && req.method === 'POST') return transaction(()=>{
    const shift=one('SELECT id FROM shifts WHERE user_id=? AND closed IS NULL',user.id); if (!shift) fail('Abra o caixa antes de vender.');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length>100) fail('Adicione produtos à venda.');
    const seen=new Set();
    const items=body.items.map(i=>{ if(!i||typeof i!=='object'||!Number.isSafeInteger(i.product_id)||i.product_id<1)fail('Produto inválido na venda.');if (seen.has(i.product_id)) fail('Produto repetido.'); seen.add(i.product_id); const p=one('SELECT * FROM products WHERE id=? AND active=1',i.product_id); if (!p) fail('Produto indisponível.'); const quantity=number(i.quantity,'Quantidade',0.001,1e7); if (Math.abs(quantity*1000-Math.round(quantity*1000))>1e-6 || (p.unit==='un' && !Number.isInteger(quantity))) fail('Quantidade inválida para a unidade.'); p.stock=ops.available(p.id);if (quantity>p.stock) fail(`Stock insuficiente: ${p.name}. Disponível: ${p.stock} ${p.unit}; pedido: ${quantity} ${p.unit}. Faltam ${Math.round((quantity-p.stock)*1000)/1000} ${p.unit}.`); return {...p,quantity,total:Math.round(p.price*quantity)}; });
    const discount=money(body.discount,'Desconto'),paid=money(body.paid,'Valor recebido'),fiscal=fiscalState(db);
    if(body.expected_fiscal_revision!==undefined&&body.expected_fiscal_revision!==fiscal.revision)fail('As regras fiscais mudaram. Atualize os preços/IVA no ponto de venda e confirme os valores antes de finalizar.',409);
    if(fiscal.settings.enabled&&body.expected_fiscal_revision!==fiscal.revision)fail('Atualize os preços/IVA para confirmar o enquadramento fiscal antes de vender.',409);
    const basket=calculateTaxBasket(items,discount,fiscal.settings,fiscal.rules);if(!basket.ok)fail(basket.error);
    if(body.expected_total!==undefined&&body.expected_total!==basket.total)fail('Os preços ou impostos mudaram. Atualize os preços/IVA e confirme o novo total antes de finalizar.',409);
    const result=settlement(basket.total,0,paid,body.method);if(!result.ok)fail(result.error);
    const total=result.total,subtotal=basket.subtotal;
    const snapshot={company_name:'TT LEBILA',company_nif:fiscal.settings.company_nif,company_address:fiscal.settings.company_address,regime:fiscal.settings.regime,price_mode:fiscal.settings.price_mode,legal_basis:fiscal.settings.legal_basis,confirmed_by:fiscal.settings.confirmed_by,confirmed_at:fiscal.settings.confirmed_at,revision:fiscal.revision,groups:basket.groups};
    const id=Number(run('INSERT INTO sales(user_id,shift_id,customer,subtotal,discount,total,paid,change_due,method,tax_base,tax_total,fiscal_state,fiscal_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',user.id,shift.id,descriptiveText(body.customer || 'Consumidor final').slice(0,150),subtotal,discount,total,paid,paid-total,body.method,basket.tax_base,basket.tax_total,basket.fiscal_state,JSON.stringify(snapshot)).lastInsertRowid);
    for(const i of basket.lines){const itemId=Number(run('INSERT INTO items(sale_id,product_id,name,unit,quantity,price,total,discount_amount,tax_base,tax_amount,taxed_total,tax_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,i.id,i.name,i.unit,i.quantity,i.price,i.total,i.discount_amount,i.tax_base,i.tax_amount,i.taxed_total,i.tax_snapshot?JSON.stringify(i.tax_snapshot):null).lastInsertRowid);ops.allocate(itemId,i.id,i.quantity,user,id);run('UPDATE products SET stock=ROUND(stock-?,3) WHERE id=?',i.quantity,i.id);}
    audit(user,'Venda',`Recibo #${id}; total ${total/100} Kz`);return receipt(id);
  });
  if (/^\/api\/sales\/\d+$/.test(path) && req.method==='GET') { const r=receipt(Number(path.split('/').pop())); if(!r.id) fail('Recibo inexistente.',404); if(((user.role==='vendedor'&&!user.permissions.sales_cancel)||(!user.permissions.history&&!user.permissions.dashboard&&!user.permissions.sales_cancel)) && (r.user_id!==user.id||!one('SELECT id FROM shifts WHERE id=? AND user_id=?',r.shift_id,user.id))) fail('Sem permissão.',403); return r; }
  if(path==='/api/users' && req.method==='POST') {
    manage(user); const profile=text(body.role,'Perfil'),role=profile==='gerente'?'gerente':'vendedor'; if(!Object.hasOwn(profileLabels,profile)) fail('Escolha um perfil de equipa válido. Para mudar o proprietário, use a transferência de propriedade.');
    if(user.role==='gerente' && role!=='vendedor') fail('Apenas o proprietário pode gerir gerentes e proprietários.',403);
    return transaction(()=>{const result=createUser(body,role);const job=profile==='vendedor'?'atendente':profile;run('UPDATE users SET job_type=? WHERE id=?',job,result.id);if(user.role==='gerente'){const defaults=permissions(role,{},job);const initial=Object.fromEntries(Object.keys(defaults).map(key=>[key,defaults[key]&&user.permissions[key]]));run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(initial),result.id);}audit(user,'Utilizador',`Criou a conta #${result.id} (${role})`);return result;});
  }
  if(path==='/api/profile' && req.method==='POST') return transaction(()=>{
    rejectIdentity(body);const p=contacts(body);
    run('UPDATE users SET email=?,phone=? WHERE id=?',p.email,p.phone,user.id);
    audit(user,'Perfil','Atualizou os seus contactos');return {ok:true};
  });
  if(path==='/api/password' && req.method==='POST') return transaction(()=>{
    const current=one('SELECT password FROM users WHERE id=?',user.id);
    if(!user.recovery && !user.must_change_password && !verify(String(body.current_password || ''),current.password)) fail('Palavra-passe atual incorreta.');
    const password=validPassword(body.password);
    if(verify(password,current.password)) fail('Escolha uma palavra-passe diferente da atual.');
    run('UPDATE users SET password=?,must_change_password=0 WHERE id=?',hash(password),user.id);
    run('DELETE FROM sessions WHERE user_id=? AND token<>?',user.id,token);
    run('UPDATE sessions SET recovery=0,expires=? WHERE token=?',Date.now()+43200000,token);
    run('UPDATE recoveries SET used=1 WHERE user_id=?',user.id);
    res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);
    audit(user,'Segurança','Alterou a sua palavra-passe');return {ok:true};
  });
  if(path==='/api/users/profile' && req.method==='POST') return transaction(()=>{
    manage(user);rejectIdentity(body);const target=one('SELECT * FROM users WHERE id=? AND deleted_at IS NULL',body.id);
    if(!target) fail('Utilizador inexistente.',404);
    if(user.role==='gerente' && target.role!=='vendedor' && target.id!==user.id) fail('Apenas o proprietário pode gerir este perfil.',403);
    const p=contacts(body);run('UPDATE users SET email=?,phone=? WHERE id=?',p.email,p.phone,target.id);
    audit(user,'Perfil',`Atualizou contactos da conta #${target.id}`);return {ok:true};
  });
  if(path==='/api/users/reset-password' && req.method==='POST') return transaction(()=>{
    manage(user);rejectIdentity(body);const target=one('SELECT * FROM users WHERE id=? AND deleted_at IS NULL',body.id);
    if(!target) fail('Utilizador inexistente.',404);
    if(target.id===user.id || (user.role==='gerente' && target.role!=='vendedor')) fail('Sem permissão para repor esta palavra-passe.',403);
    const password=generatePassword();run('UPDATE users SET password=?,must_change_password=1 WHERE id=?',hash(password),target.id);
    run('DELETE FROM sessions WHERE user_id=?',target.id);run('UPDATE recoveries SET used=1 WHERE user_id=?',target.id);audit(user,'Segurança',`Repôs a palavra-passe da conta #${target.id}`);
    return {email:target.email,password};
  });
  if(path==='/api/users/access' && req.method==='POST') return transaction(()=>{
    manage(user);rejectIdentity(body);const target=one('SELECT * FROM users WHERE id=? AND deleted_at IS NULL',body.id); if(!target) fail('Utilizador inexistente.'); if(target.id===user.id) fail('Não pode alterar o seu próprio acesso.');
    const profile=body.role,role=profile==='gerente'?'gerente':'vendedor',job=profile==='vendedor'?'atendente':profile; if(!Object.hasOwn(profileLabels,profile) || typeof body.active!=='boolean') fail('Acesso inválido.');
    if(user.role==='gerente' && (target.role!=='vendedor' || role!=='vendedor')) fail('Apenas o proprietário pode gerir este perfil.',403);
    if(target.role==='proprietario') fail('O proprietário só pode ser substituído por transferência de propriedade.',403);
    if(role==='gerente' && one("SELECT id FROM users WHERE role='gerente' AND deleted_at IS NULL AND id<>?",target.id)) fail('Já existe um gerente. Remova ou altere o gerente atual primeiro.',409);
    let configured=role===target.role&&job===target.job_type?JSON.parse(target.permissions||'{}'):{};
    if(body.permissions!==undefined){
      if(!body.permissions||typeof body.permissions!=='object'||Array.isArray(body.permissions))fail('Permissões inválidas.');
      for(const [key,value] of Object.entries(body.permissions)){
        if(!Object.hasOwn(permissionLabels,key)||typeof value!=='boolean')fail('Permissão inválida.');
        if(role==='vendedor'&&!permissionKeys(role,job).includes(key)&&value)fail('Vendedores não podem gerir stock, equipa, atividades ou regras fiscais.',403);
        if(key==='view_all_pins'&&user.role!=='proprietario'&&value)fail('Só o proprietário delega consulta de códigos.',403);
        if(user.role==='gerente'&&value&&!user.permissions[key])fail('Não pode conceder um acesso que não possui.',403);
      }
      configured={...configured,...body.permissions};
    }
    const effective=permissions(role,configured,job);
    if(user.role==='gerente')for(const [key,value] of Object.entries(effective)){
      const previous=permissions(target.role,JSON.parse(target.permissions||'{}'),target.job_type);
      if(value&&!user.permissions[key]&&!previous[key])fail('Não pode conceder um acesso que não possui.',403);
    }
    if((!effective.cash||!body.active)&&one('SELECT id FROM shifts WHERE user_id=? AND closed IS NULL',target.id))fail('Feche primeiro o caixa deste utilizador antes de retirar o acesso ao caixa.');
    run('UPDATE users SET role=?,active=?,permissions=?,job_type=? WHERE id=?',role,Number(body.active),JSON.stringify(effective),job,target.id);run('DELETE FROM sessions WHERE user_id=?',target.id);audit(user,'Permissões',`${target.name}: ${role}, ${body.active ? 'ativo' : 'inativo'}; acessos ${JSON.stringify(effective)}`);return {ok:true};
  });
  if(path==='/api/users/remove' && req.method==='POST') return transaction(()=>{
    manage(user);const target=one('SELECT * FROM users WHERE id=? AND deleted_at IS NULL',body.id);
    if(!target) fail('Utilizador inexistente.',404);
    if(target.id===user.id || target.role==='proprietario' || (user.role==='gerente' && target.role!=='vendedor')) fail('Não pode remover este utilizador.',403);
    if(one('SELECT id FROM shifts WHERE user_id=? AND closed IS NULL',target.id)) fail('Este utilizador precisa de fechar o caixa antes de ser removido.');
    run("UPDATE users SET active=0,deleted_at=CURRENT_TIMESTAMP,role='vendedor' WHERE id=?",target.id);
    run('DELETE FROM sessions WHERE user_id=?',target.id);run('DELETE FROM cash_pins WHERE user_id=?',target.id);run('UPDATE recoveries SET used=1 WHERE user_id=?',target.id);
    audit(user,'Remoção de utilizador',`Removeu a conta #${target.id}; histórico preservado.`);return {ok:true};
  });
  if(path==='/api/users/transfer-owner' && req.method==='POST') return transaction(()=>{
    if(user.role!=='proprietario') fail('Apenas o proprietário pode transferir a propriedade.',403);
    if(!verify(String(body.password||''),one('SELECT password FROM users WHERE id=?',user.id).password)) fail('Palavra-passe atual incorreta.');
    const target=one('SELECT * FROM users WHERE id=? AND active=1 AND deleted_at IS NULL',body.id);
    if(!target || target.id===user.id) fail('Escolha outra pessoa ativa para assumir a propriedade.');
    run("UPDATE users SET role='vendedor',job_type='atendente' WHERE id=?",user.id);run("UPDATE users SET role='proprietario',job_type='proprietario' WHERE id=?",target.id);
    run('DELETE FROM sessions WHERE user_id IN (?,?)',user.id,target.id);
    audit(user,'Transferência de propriedade',`Transferiu a propriedade para a conta #${target.id}; proprietário anterior passou a vendedor.`);return {ok:true};
  });
  fail('Recurso não encontrado.',404);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  // A web preview embeds the application in a frame. Restrict its parents with
  // CSP instead of X-Frame-Options DENY, which blocks even trusted preview hosts.
  const frameAncestors=process.env.FRAME_ANCESTORS || "'self' https://chatgpt.com https://*.chatgpt.com";
  res.setHeader('Content-Security-Policy',`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${frameAncestors}`);
  res.setHeader('Cache-Control','no-store');
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) {
      if(!['GET','POST'].includes(req.method)) fail('Método não permitido.',405);
      if(req.method==='POST' && req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`) fail('Origem não autorizada.',403);
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536) fail('Pedido demasiado grande.',413);}
      let body={};try{body=raw ? JSON.parse(raw) : {};}catch{fail('JSON inválido.');}if(!body || typeof body!=='object' || Array.isArray(body)) fail('Pedido inválido.');
      const result=await api(req,res,url.pathname,body);res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(result));
    } else {
      const files={'/':'index.html','/app.js':'app.js','/calculations.js':'calculations.js','/tax.js':'tax.js','/validation.js':'validation.js','/permissions.js':'permissions.js','/style.css':'style.css'};const file=files[url.pathname];if(!file) fail('Página não encontrada.',404);
      res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(file)]);res.end(readFileSync(new URL(`./public/${file}`,import.meta.url)));
    }
  } catch(e){res.statusCode=e.status || (String(e.message).includes('UNIQUE') ? 409 : 500);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.status ? e.message : res.statusCode===409 ? 'Já existe um registo com esse email, BI ou código de barras.' : 'Erro interno. Tente novamente.'}));if(res.statusCode===500) console.error(e);}
});
server.listen(Number(process.env.PORT || 3000),process.env.HOST || '0.0.0.0',()=>console.log(`TT LEBILA pronta na porta ${process.env.PORT || 3000}`));
