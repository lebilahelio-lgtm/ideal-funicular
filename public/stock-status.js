// Angola calendar dates: expiration remains valid through the end of its day.
export const stockDay=()=>new Date(Date.now()+3600000).toISOString().slice(0,10);
export function expiryStatus(expiresOn,warningDays,day=stockDay()){
 if(!expiresOn)return 'healthy';
 if(expiresOn<day)return 'expired';
 const limit=new Date(Date.parse(day+'T00:00:00Z')+warningDays*86400000).toISOString().slice(0,10);
 return expiresOn<=limit?'warning':'healthy';
}
export function productExpiryStatus(lots,warningDays,day=stockDay()){
 const released=lots.filter(l=>l.sale_enabled&&l.remaining>0);
 if(!released.length)return 'pending';
 const states=released.map(l=>expiryStatus(l.expires_on,warningDays,day));
 return states.includes('expired')?'expired':states.includes('warning')?'warning':'healthy';
}
