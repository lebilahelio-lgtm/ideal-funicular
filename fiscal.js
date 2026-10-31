import {descriptiveText} from './public/validation.js';
import {createHash} from 'node:crypto';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
function text(value,label,max=1000){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw error(`${label} inválido.`);return value.trim();}
export function fiscalDate(value,label){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw error(`${label} inválida.`);return value;}
export function migrateFiscal(db){
 db.exec(`CREATE TABLE IF NOT EXISTS fiscal_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,regime TEXT NOT NULL DEFAULT 'pendente',price_mode TEXT NOT NULL DEFAULT 'included',company_nif TEXT NOT NULL DEFAULT '',company_address TEXT NOT NULL DEFAULT '',legal_basis TEXT NOT NULL DEFAULT '',confirmed_by INTEGER REFERENCES users(id),confirmed_at TEXT);
 INSERT OR IGNORE INTO fiscal_settings(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS tax_rules(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,rate_bps INTEGER NOT NULL,start_date TEXT NOT NULL,end_date TEXT,legal_basis TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
 const add=(table,columns)=>{const present=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const [name,type]of columns)if(!present.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
 add('products',[['tax_rule_id','INTEGER REFERENCES tax_rules(id)']]);
 add('sales',[['tax_total','INTEGER'],['tax_base','INTEGER'],['fiscal_state',"TEXT NOT NULL DEFAULT 'legacy'"],['fiscal_snapshot','TEXT']]);
 add('items',[['discount_amount','INTEGER'],['tax_base','INTEGER'],['tax_amount','INTEGER'],['taxed_total','INTEGER'],['tax_snapshot','TEXT']]);
}
export function fiscalState(db){const state={settings:db.prepare('SELECT * FROM fiscal_settings WHERE id=1').get(),rules:db.prepare('SELECT * FROM tax_rules ORDER BY id').all()};return {...state,revision:createHash('sha256').update(JSON.stringify(state)).digest('hex')};}
export function saveFiscalSettings(db,body,user){
 if(user.role!=='proprietario')throw error('Apenas o proprietário pode definir o enquadramento fiscal.',403);
 if(typeof body.enabled!=='boolean'||!['pendente','geral','exclusao','simplificado'].includes(body.regime)||!['included','excluded'].includes(body.price_mode))throw error('Configuração fiscal inválida.');
 if(body.enabled&&!['geral','exclusao'].includes(body.regime))throw error('O enquadramento está pendente ou exige apuramento específico do regime simplificado. Confirme-o com o contabilista antes de ativar.');
 const nif=String(body.company_nif||'').trim().toUpperCase(),address=descriptiveText(String(body.company_address||'').trim()),basis=String(body.legal_basis||'').trim();
 if(nif&&!/^[A-Z0-9]{9,14}$/.test(nif))throw error('Introduza o NIF registado da empresa (9 a 14 caracteres alfanuméricos).');
 if(address.length>500||basis.length>2000)throw error('A morada ou fundamento legal ultrapassa o limite permitido.');
 if(body.enabled&&(!nif||!address||!basis||body.confirmed!==true))throw error('Para ativar, preencha NIF, morada, fundamento legal e confirme a validação do enquadramento.');
 db.prepare('UPDATE fiscal_settings SET enabled=?,regime=?,price_mode=?,company_nif=?,company_address=?,legal_basis=?,confirmed_by=?,confirmed_at=CURRENT_TIMESTAMP WHERE id=1').run(Number(body.enabled),body.regime,body.price_mode,nif,address,basis,user.id);
 return {ok:true};
}
export function saveTaxRule(db,body,user){
 if(user.role!=='proprietario')throw error('Apenas o proprietário pode definir regras de IVA.',403);
 const name=descriptiveText(text(body.name,'Nome da regra',150)),basis=text(body.legal_basis,'Fundamento legal',2000),start=fiscalDate(body.start_date,'Data inicial'),end=body.end_date?fiscalDate(body.end_date,'Data final'):null;
 if(end&&end<start)throw error('A data final não pode ser anterior à data inicial.');
 if(!['tributado','isento','nao_sujeito'].includes(body.kind)||typeof body.rate!=='number'||!Number.isFinite(body.rate)||body.rate<0||body.rate>100||Math.abs(body.rate*100-Math.round(body.rate*100))>1e-6)throw error('Indique uma taxa de 0 a 100%, com até duas casas decimais.');
 if((body.kind==='tributado'&&body.rate===0)||(body.kind!=='tributado'&&body.rate!==0))throw error('Uma operação tributada precisa de taxa superior a zero; isenção e não sujeição usam 0%.');
 if(typeof body.active!=='boolean')throw error('Estado da regra inválido.');
 const values=[name,body.kind,Math.round(body.rate*100),start,end,basis,Number(body.active)];let id=body.id;
 if(id){if(!db.prepare('SELECT id FROM tax_rules WHERE id=?').get(id))throw error('Regra inexistente.',404);db.prepare('UPDATE tax_rules SET name=?,kind=?,rate_bps=?,start_date=?,end_date=?,legal_basis=?,active=? WHERE id=?').run(...values,id);}
 else id=Number(db.prepare('INSERT INTO tax_rules(name,kind,rate_bps,start_date,end_date,legal_basis,active) VALUES(?,?,?,?,?,?,?)').run(...values).lastInsertRowid);
 return {id};
}
export function taxReport(db,body){
 const start=fiscalDate(body.start,'Data inicial'),end=fiscalDate(body.end,'Data final');if(end<start)throw error('A data final não pode ser anterior à data inicial.');
 const sales=db.prepare("SELECT * FROM sales WHERE NOT EXISTS(SELECT 1 FROM sale_cancellations c WHERE c.sale_id=sales.id) AND date(created,'+1 hour') BETWEEN ? AND ? ORDER BY id").all(start,end),ids=new Set(sales.map(s=>s.id));
 const items=db.prepare("SELECT i.* FROM items i JOIN sales s ON s.id=i.sale_id WHERE date(s.created,'+1 hour') BETWEEN ? AND ? AND s.fiscal_state='applied'").all(start,end);
 const groups=new Map();for(const item of items){const rule=JSON.parse(item.tax_snapshot);const key=JSON.stringify([rule.id,rule.rate_bps,rule.kind,rule.legal_basis]);const group=groups.get(key)||{...rule,tax_base:0,tax_amount:0,total:0};group.tax_base+=item.tax_base;group.tax_amount+=item.tax_amount;group.total+=item.taxed_total;groups.set(key,group);}
 return {start,end,sales_count:ids.size,applied_count:sales.filter(s=>s.fiscal_state==='applied').length,pending_count:sales.filter(s=>s.fiscal_state!=='applied').length,total:sales.reduce((sum,s)=>sum+s.total,0),tax_total:sales.filter(s=>s.fiscal_state==='applied').reduce((sum,s)=>sum+s.tax_total,0),tax_base:sales.filter(s=>s.fiscal_state==='applied').reduce((sum,s)=>sum+s.tax_base,0),groups:[...groups.values()]};
}
