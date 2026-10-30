import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
// Additive migration preserves existing shop records.
const columns=new Set(all('PRAGMA table_info(users)').map(c=>c.name));
for(const column of ['email','bi','birth_date','phone']) if(!columns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS users_bi ON users(bi COLLATE NOCASE);
CREATE TRIGGER IF NOT EXISTS immutable_identity BEFORE UPDATE OF name,bi,birth_date ON users
WHEN NEW.name IS NOT OLD.name OR (OLD.bi IS NOT NULL AND NEW.bi IS NOT OLD.bi) OR (OLD.birth_date IS NOT NULL AND NEW.birth_date IS NOT OLD.birth_date)
BEGIN SELECT RAISE(ABORT,'Identidade imutável'); END;`);
function contacts(body) {
 const email=text(body.email,'Email',254).toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email inválido.');
 const phone=text(body.phone,'Telefone',30);
 if(!/^\+?[\d ()-]{7,30}$/.test(phone) || phone.replace(/\D/g,'').length<7) fail('Telefone inválido.');
 return {email,phone};
}
function identity(body) {
 const name=text(body.name,'Nome'),bi=text(body.bi,'BI',14).toUpperCase(),birth_date=text(body.birth_date,'Data de nascimento',10);
 if(!/^\d{9}[A-Z]{2}\d{3}$/.test(bi)) fail('BI inválido. Exemplo: 009763932CA042.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(birth_date) || Number.isNaN(Date.parse(birth_date)) || new Date(birth_date).toISOString().slice(0,10)!==birth_date || birth_date>new Date().toISOString().slice(0,10) || birth_date<'1900-01-01') fail('Data de nascimento inválida.');
 return {name,bi,birth_date,...contacts(body)};
}
function rejectIdentity(body) { if(['name','bi','birth_date'].some(k=>Object.hasOwn(body,k))) fail('Nome, BI e data de nascimento não podem ser alterados.'); }
function createUser(body,role) {
 const p=identity(body), password=randomBytes(18).toString('base64url');
 const id=Number(run('INSERT INTO users(name,username,password,role,email,bi,birth_date,phone) VALUES(?,?,?,?,?,?,?,?)',p.name,p.email,hash(password),role,p.email,p.bi,p.birth_date,p.phone).lastInsertRowid);
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
function receipt(id) { return { ...one('SELECT s.*,u.name AS seller FROM sales s JOIN users u ON u.id=s.user_id WHERE s.id=?', id), items: all('SELECT * FROM items WHERE sale_id=?', id) }; }
const attempts = new Map();
async function api(req, res, path, body) {
  if (path === '/api/setup' && req.method === 'GET') return { required: !one('SELECT id FROM users LIMIT 1') };
  if (path === '/api/setup' && req.method === 'POST') {
    if (one('SELECT id FROM users LIMIT 1')) fail('Configuração já concluída.', 409);
    return transaction(()=>{const result=createUser(body,'proprietario');audit({id:result.id},'Conta inicial','Criou o proprietário');return result;});
  }
  if (path === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress, now = Date.now();
    const attempt = attempts.get(ip) || { count: 0, until: now + 600000 };
    if (attempt.until < now) { attempt.count = 0; attempt.until = now + 600000; }
    if (attempt.count >= 15) fail('Muitas tentativas. Aguarde 10 minutos.',429);
    attempt.count++; attempts.set(ip,attempt);
    const identifier=String(body.identifier || '').trim();
    const user = one('SELECT * FROM users WHERE (email=? COLLATE NOCASE OR bi=? COLLATE NOCASE) AND active=1',identifier,identifier);
    if (!user || !verify(String(body.password || ''), user.password)) fail('Email / BI ou palavra-passe incorretos.',401);
    attempts.delete(ip);
    const token = randomBytes(32).toString('hex');
    run('INSERT INTO sessions VALUES(?,?,?)',token,user.id,now + 43200000);
    res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
    return { ok: true };
  }
  const token = /(?:^|;\s*)session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const user = one('SELECT u.id,u.name,u.email,u.bi,u.birth_date,u.phone,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1',token || '',Date.now());
  if (!user) fail('Inicie sessão para continuar.',401);
  if (path === '/api/logout' && req.method === 'POST') { run('DELETE FROM sessions WHERE token=?',token); res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return { ok:true }; }
  if (path === '/api/state' && req.method === 'GET') {
    const manager = user.role !== 'vendedor';
    const products = all('SELECT * FROM products WHERE active=1 ORDER BY name');
    if (!manager) for (const p of products) delete p.pack_cost;
    return { user, products, sales: all(`SELECT s.*,u.name AS seller FROM sales s JOIN users u ON u.id=s.user_id ${manager ? '' : 'WHERE s.user_id=?'} ORDER BY s.id DESC LIMIT 100`, ...(manager ? [] : [user.id])),
      shifts: all(`SELECT s.*,u.name AS seller,(SELECT COALESCE(SUM(total),0) FROM sales WHERE shift_id=s.id AND method='dinheiro') AS cash_sales FROM shifts s JOIN users u ON u.id=s.user_id ${manager ? '' : 'WHERE s.user_id=?'} ORDER BY s.id DESC LIMIT 50`,...(manager ? [] : [user.id])),
      users: manager ? all('SELECT id,name,email,bi,birth_date,phone,role,active FROM users ORDER BY id') : [],
      purchases: manager ? all('SELECT m.*,p.name AS product,p.unit,u.name AS actor FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 100') : [],
      audit: manager ? all('SELECT a.*,u.name AS actor FROM audit a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100') : [],
      chart: all(`SELECT date(created) AS day, SUM(total) AS total,COUNT(*) AS count FROM sales WHERE created>=date('now','-13 days') ${manager ? '' : 'AND user_id=?'} GROUP BY date(created) ORDER BY day`,...(manager ? [] : [user.id])),
      metrics: one(`SELECT COALESCE(SUM(CASE WHEN date(created)=date('now') THEN total ELSE 0 END),0) AS today,COUNT(CASE WHEN date(created)=date('now') THEN 1 END) AS count,COALESCE(SUM(CASE WHEN created>=date('now','-6 days') THEN total ELSE 0 END),0) AS current_week,COALESCE(SUM(CASE WHEN created>=date('now','-13 days') AND created<date('now','-6 days') THEN total ELSE 0 END),0) AS previous_week FROM sales ${manager ? '' : 'WHERE user_id=?'}`,...(manager ? [] : [user.id])) };
  }
  if (path === '/api/products' && req.method === 'POST') {
    manage(user);
    const name=text(body.name,'Produto'), category=text(body.category,'Categoria'), unit=text(body.unit,'Unidade'), pack=text(body.pack_type,'Embalagem');
    if (!['un','kg','L','g','mL'].includes(unit)) fail('Unidade não suportada.');
    const size=number(body.pack_size,'Conteúdo da embalagem',0.001), cost=money(body.pack_cost,'Custo'), price=money(body.price,'Preço'), minimum=number(body.minimum,'Stock mínimo'), barcode=body.barcode ? text(body.barcode,'Código de barras',80) : null;
    return transaction(()=>{
      let id;
      if (body.id) {
        const existing=one('SELECT * FROM products WHERE id=?',body.id);
        if (!existing) fail('Produto inexistente.',404);
        if (existing.unit!==unit && (existing.stock>0 || one('SELECT id FROM items WHERE product_id=? LIMIT 1',body.id))) fail('Não pode alterar a unidade de um produto com stock ou vendas. Crie outro produto.');
        run('UPDATE products SET name=?,category=?,unit=?,barcode=?,minimum=?,pack_type=?,pack_size=?,pack_cost=?,price=? WHERE id=?',name,category,unit,barcode,minimum,pack,size,cost,price,body.id); id=body.id;
      } else { id=Number(run('INSERT INTO products(name,category,unit,barcode,minimum,pack_type,pack_size,pack_cost,price) VALUES(?,?,?,?,?,?,?,?,?)',name,category,unit,barcode,minimum,pack,size,cost,price).lastInsertRowid); }
      audit(user,'Produto',`${body.id ? 'Atualizou' : 'Criou'} ${name}`); return {id};
    });
  }
  if (path === '/api/stock' && req.method === 'POST') {
    manage(user);
    const p=one('SELECT * FROM products WHERE id=?',body.product_id); if (!p) fail('Produto inexistente.',404);
    const packs=number(body.packs,'Embalagens',0.001), quantity=Math.round(packs*p.pack_size*1000)/1000, reason=text(body.reason,'Motivo');
    return transaction(()=>{ run('UPDATE products SET stock=ROUND(stock+?,3) WHERE id=?',quantity,p.id); run('INSERT INTO movements(product_id,user_id,quantity,cost,reason) VALUES(?,?,?,?,?)',p.id,user.id,quantity,Math.round(packs*p.pack_cost),reason); audit(user,'Entrada de stock',`${p.name}: +${quantity} ${p.unit} • ${reason}`); return {ok:true}; });
  }
  if (path === '/api/shifts/open' && req.method === 'POST') return transaction(()=>{
    if (one('SELECT id FROM shifts WHERE user_id=? AND closed IS NULL',user.id)) fail('Já tem um caixa aberto.');
    const id=Number(run('INSERT INTO shifts(user_id,opening) VALUES(?,?)',user.id,money(body.opening,'Fundo inicial')).lastInsertRowid); audit(user,'Abertura de caixa',`Caixa #${id}`); return {id};
  });
  if (path === '/api/shifts/close' && req.method === 'POST') return transaction(()=>{
    const shift=one('SELECT * FROM shifts WHERE user_id=? AND closed IS NULL',user.id); if (!shift) fail('Não tem caixa aberto.');
    const expected=shift.opening+one("SELECT COALESCE(SUM(total),0) AS total FROM sales WHERE shift_id=? AND method='dinheiro'",shift.id).total;
    const closing=money(body.closing,'Valor contado'); run('UPDATE shifts SET closed=CURRENT_TIMESTAMP,closing=?,expected=? WHERE id=?',closing,expected,shift.id); audit(user,'Fecho de caixa',`Caixa #${shift.id}; diferença ${(closing-expected)/100} Kz`); return {expected,closing};
  });
  if (path === '/api/sales' && req.method === 'POST') return transaction(()=>{
    const shift=one('SELECT id FROM shifts WHERE user_id=? AND closed IS NULL',user.id); if (!shift) fail('Abra o caixa antes de vender.');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length>100) fail('Adicione produtos à venda.');
    const seen=new Set();
    const items=body.items.map(i=>{ if (seen.has(i.product_id)) fail('Produto repetido.'); seen.add(i.product_id); const p=one('SELECT * FROM products WHERE id=? AND active=1',i.product_id); if (!p) fail('Produto indisponível.'); const quantity=number(i.quantity,'Quantidade',0.001,1e7); if (Math.abs(quantity*1000-Math.round(quantity*1000))>1e-6 || (p.unit==='un' && !Number.isInteger(quantity))) fail('Quantidade inválida para a unidade.'); if (quantity>p.stock) fail(`Stock insuficiente: ${p.name}.`); return {...p,quantity,total:Math.round(p.price*quantity)}; });
    const subtotal=items.reduce((s,i)=>s+i.total,0),discount=money(body.discount,'Desconto'); if(discount>subtotal) fail('Desconto superior ao subtotal.');
    const total=subtotal-discount,paid=money(body.paid,'Valor recebido'); if(paid<total) fail('Valor recebido insuficiente.');
    if(!['dinheiro','transferencia','tpa'].includes(body.method)) fail('Pagamento inválido.'); if(body.method!=='dinheiro' && paid!==total) fail('Em pagamentos eletrónicos, o valor deve ser igual ao total.');
    const id=Number(run('INSERT INTO sales(user_id,shift_id,customer,subtotal,discount,total,paid,change_due,method) VALUES(?,?,?,?,?,?,?,?,?)',user.id,shift.id,String(body.customer || 'Consumidor final').slice(0,150),subtotal,discount,total,paid,paid-total,body.method).lastInsertRowid);
    for(const i of items){run('INSERT INTO items(sale_id,product_id,name,unit,quantity,price,total) VALUES(?,?,?,?,?,?,?)',id,i.id,i.name,i.unit,i.quantity,i.price,i.total);run('UPDATE products SET stock=ROUND(stock-?,3) WHERE id=?',i.quantity,i.id);}
    audit(user,'Venda',`Recibo #${id}; total ${total/100} Kz`);return receipt(id);
  });
  if (/^\/api\/sales\/\d+$/.test(path) && req.method==='GET') { const r=receipt(Number(path.split('/').pop())); if(!r.id) fail('Recibo inexistente.',404); if(user.role==='vendedor' && r.user_id!==user.id) fail('Sem permissão.',403); return r; }
  if(path==='/api/users' && req.method==='POST') {
    manage(user); const role=text(body.role,'Perfil'); if(!['proprietario','gerente','vendedor'].includes(role)) fail('Perfil inválido.');
    if(user.role==='gerente' && role!=='vendedor') fail('Apenas o proprietário pode gerir gerentes e proprietários.',403);
    return transaction(()=>{const result=createUser(body,role);audit(user,'Utilizador',`Criou a conta #${result.id} (${role})`);return result;});
  }
  if(path==='/api/profile' && req.method==='POST') return transaction(()=>{
    rejectIdentity(body);const p=contacts(body);
    run('UPDATE users SET email=?,phone=? WHERE id=?',p.email,p.phone,user.id);
    audit(user,'Perfil','Atualizou os seus contactos');return {ok:true};
  });
  if(path==='/api/password' && req.method==='POST') return transaction(()=>{
    const current=one('SELECT password FROM users WHERE id=?',user.id);
    if(!verify(String(body.current_password || ''),current.password)) fail('Palavra-passe atual incorreta.');
    const password=text(body.password,'Nova palavra-passe',200);if(password.length<10) fail('Use pelo menos 10 caracteres.');
    if(verify(password,current.password)) fail('Escolha uma palavra-passe diferente da atual.');
    run('UPDATE users SET password=? WHERE id=?',hash(password),user.id);
    run('DELETE FROM sessions WHERE user_id=? AND token<>?',user.id,token);
    audit(user,'Segurança','Alterou a sua palavra-passe');return {ok:true};
  });
  if(path==='/api/users/profile' && req.method==='POST') return transaction(()=>{
    manage(user);rejectIdentity(body);const target=one('SELECT * FROM users WHERE id=?',body.id);
    if(!target) fail('Utilizador inexistente.',404);
    if(user.role==='gerente' && target.role!=='vendedor' && target.id!==user.id) fail('Apenas o proprietário pode gerir este perfil.',403);
    const p=contacts(body);run('UPDATE users SET email=?,phone=? WHERE id=?',p.email,p.phone,target.id);
    audit(user,'Perfil',`Atualizou contactos da conta #${target.id}`);return {ok:true};
  });
  if(path==='/api/users/reset-password' && req.method==='POST') return transaction(()=>{
    manage(user);rejectIdentity(body);const target=one('SELECT * FROM users WHERE id=?',body.id);
    if(!target) fail('Utilizador inexistente.',404);
    if(target.id===user.id || (user.role==='gerente' && target.role!=='vendedor')) fail('Sem permissão para repor esta palavra-passe.',403);
    const password=randomBytes(18).toString('base64url');run('UPDATE users SET password=? WHERE id=?',hash(password),target.id);
    run('DELETE FROM sessions WHERE user_id=?',target.id);audit(user,'Segurança',`Repôs a palavra-passe da conta #${target.id}`);
    return {email:target.email,password};
  });
  if(path==='/api/users/access' && req.method==='POST') return transaction(()=>{
    manage(user);rejectIdentity(body);const target=one('SELECT * FROM users WHERE id=?',body.id); if(!target) fail('Utilizador inexistente.'); if(target.id===user.id) fail('Não pode alterar o seu próprio acesso.');
    const role=body.role; if(!['proprietario','gerente','vendedor'].includes(role) || typeof body.active!=='boolean') fail('Acesso inválido.');
    if(user.role==='gerente' && (target.role!=='vendedor' || role!=='vendedor')) fail('Apenas o proprietário pode gerir este perfil.',403);
    if(target.role==='proprietario' && (role!=='proprietario' || !body.active) && one("SELECT COUNT(*) AS n FROM users WHERE role='proprietario' AND active=1").n<=1) fail('Mantenha um proprietário ativo.');
    run('UPDATE users SET role=?,active=? WHERE id=?',role,Number(body.active),target.id);run('DELETE FROM sessions WHERE user_id=?',target.id);audit(user,'Permissões',`${target.name}: ${role}, ${body.active ? 'ativo' : 'inativo'}`);return {ok:true};
  });
  fail('Recurso não encontrado.',404);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  // A web preview embeds the application in a frame. Restrict its parents with
  // CSP instead of X-Frame-Options DENY, which blocks even trusted preview hosts.
  const frameAncestors=process.env.FRAME_ANCESTORS || "'self' https://chatgpt.com https://*.chatgpt.com";
  res.setHeader('Content-Security-Policy',`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${frameAncestors}`);
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) {
      if(!['GET','POST'].includes(req.method)) fail('Método não permitido.',405);
      if(req.method==='POST' && req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`) fail('Origem não autorizada.',403);
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536) fail('Pedido demasiado grande.',413);}
      let body={};try{body=raw ? JSON.parse(raw) : {};}catch{fail('JSON inválido.');}
      const result=await api(req,res,url.pathname,body);res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(result));
    } else {
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=files[url.pathname];if(!file) fail('Página não encontrada.',404);
      res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(file)]);res.end(readFileSync(new URL(`./public/${file}`,import.meta.url)));
    }
  } catch(e){res.statusCode=e.status || (String(e.message).includes('UNIQUE') ? 409 : 500);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.status ? e.message : res.statusCode===409 ? 'Já existe um registo com esse email, BI ou código de barras.' : 'Erro interno. Tente novamente.'}));if(res.statusCode===500) console.error(e);}
});
server.listen(Number(process.env.PORT || 3000),process.env.HOST || '0.0.0.0',()=>console.log(`Loja Clara pronta na porta ${process.env.PORT || 3000}`));
