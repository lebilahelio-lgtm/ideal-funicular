import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from 'node:crypto';

const error=(message,status)=>Object.assign(new Error(message),{status});
export function deliveryStatus(){return {
  email:!!(process.env.RESEND_API_KEY && process.env.RECOVERY_EMAIL_FROM),
  sms:!!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER)
};}

// Only trusted provider endpoints; no user-controlled delivery address or URL.
export async function sendRecovery({channel,user,code}){
  const message=`TT LEBILA: o seu código de recuperação é ${code}. Expira em 2 minutos e só pode ser usado uma vez. Se não pediu este código, ignore esta mensagem.`;
  let response;
  try {
    if(channel==='email') response=await fetch('https://api.resend.com/emails',{
      method:'POST',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:process.env.RECOVERY_EMAIL_FROM,to:[user.email],subject:'TT LEBILA · Recuperação de acesso',text:message})
    });
    else response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}/Messages.json`,{
      method:'POST',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Basic '+Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({To:user.phone,From:process.env.TWILIO_FROM_NUMBER,Body:message})
    });
  } catch {throw error('Não foi possível contactar o serviço de envio. Tente novamente mais tarde ou contacte o proprietário.',503);}
  if(!response.ok) throw error('O serviço não aceitou o envio. Contacte o proprietário para verificar a configuração de email/SMS.',503);
}

export class Recovery {
  constructor(db,now=()=>Date.now()){
    this.db=db;this.now=now;this.secret=randomBytes(32);this.limits=new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS recoveries(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),subject TEXT NOT NULL,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS recovery_subject ON recoveries(subject,created);`);
  }
  digest(token,code){return createHmac('sha256',this.secret).update(token+':'+code).digest('hex');}
  limit(ip,kind,max){
    const now=this.now(),key=kind+':'+ip;
    for(const [k,v] of this.limits)if(v.until<=now)this.limits.delete(k);
    const value=this.limits.get(key)||{count:0,until:now+600000};
    if(value.count>=max)throw error('Demasiadas tentativas. Aguarde 10 minutos.',429);
    value.count++;this.limits.set(key,value);
  }
  async request(identifier,channel,ip,send){
    this.limit(ip,'request',10);
    const now=this.now(),subject=createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex');
    const recent=this.db.prepare('SELECT created FROM recoveries WHERE subject=? ORDER BY created DESC LIMIT 1').get(subject);
    if(recent && now-recent.created<60000)throw error('Aguarde 60 segundos antes de pedir outro código.',429);
    const user=this.db.prepare('SELECT id,email,phone FROM users WHERE (email=? COLLATE NOCASE OR bi=? COLLATE NOCASE) AND active=1 AND deleted_at IS NULL').get(identifier,identifier);
    const token=randomBytes(32).toString('hex'),code=String(randomInt(0,1000000)).padStart(6,'0');
    if(user)this.db.prepare('UPDATE recoveries SET used=1 WHERE user_id=?').run(user.id);
    this.db.prepare('DELETE FROM recoveries WHERE expires<?').run(now-86400000);
    this.db.prepare('INSERT INTO recoveries(token,user_id,subject,code_hash,expires,created) VALUES(?,?,?,?,?,?)').run(token,user?.id||null,subject,this.digest(token,code),now+120000,now);
    if(user){try{await send({channel,user,code});}catch(e){this.db.prepare('UPDATE recoveries SET used=1 WHERE token=?').run(token);throw e;}}
    return {challenge:token,expires_in:120,message:'Se existir uma conta ativa, o código será enviado para o contacto registado. O código é válido durante 2 minutos.'};
  }
  verify(token,code,ip){
    this.limit(ip,'verify',30);
    if(typeof token!=='string' || typeof code!=='string' || !/^\d{6}$/.test(code))return null;
    const row=this.db.prepare('SELECT r.*,u.active,u.deleted_at FROM recoveries r LEFT JOIN users u ON u.id=r.user_id WHERE token=?').get(token);
    if(!row || row.used || row.expires<=this.now() || row.attempts>=5 || !row.active || row.deleted_at)return null;
    this.db.prepare('UPDATE recoveries SET attempts=attempts+1 WHERE token=?').run(token);
    if(!timingSafeEqual(Buffer.from(row.code_hash,'hex'),Buffer.from(this.digest(token,code),'hex')))return null;
    this.db.prepare('UPDATE recoveries SET used=1 WHERE token=?').run(token);
    return row.user_id;
  }
}
