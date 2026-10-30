import {formatMoney} from './calculations.js';
const valid=value=>Number.isSafeInteger(value)&&value>=0;
export const angolaDay=()=>new Date(Date.now()+3600000).toISOString().slice(0,10);

// Largest remainder allocation preserves the exact invoice discount in cents.
export function allocateDiscount(amounts,discount){
 const total=amounts.reduce((a,b)=>a+b,0);
 if(!amounts.every(valid)||!valid(total)||!valid(discount)||discount>total)throw Error('Desconto ou valores dos produtos inválidos.');
 if(!total)return amounts.map(()=>0);
 const parts=amounts.map((amount,index)=>{const product=BigInt(amount)*BigInt(discount),divisor=BigInt(total);return {index,value:Number(product/divisor),remainder:product%divisor};});
 let remaining=discount-parts.reduce((sum,p)=>sum+p.value,0);
 const ordered=[...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
 for(let i=0;i<remaining;i++)ordered[i].value++;
 return parts.map(p=>p.value);
}
function roundRatio(amount,numerator,denominator){return Number((BigInt(amount)*BigInt(numerator)*2n+BigInt(denominator))/(BigInt(denominator)*2n));}

// Tax rates and legal classifications must be explicitly configured, never inferred from a category.
export function calculateTaxBasket(items,discount,settings,rules,day=angolaDay()){
 const subtotal=items.reduce((sum,item)=>sum+item.total,0);
 if(!valid(subtotal)||!valid(discount))return {ok:false,error:'Valores monetários inválidos.'};
 if(discount>subtotal)return {ok:false,error:`O desconto excede o subtotal em ${formatMoney(discount-subtotal)}. Reduza o desconto.`};
 const allocations=allocateDiscount(items.map(i=>i.total),discount);
 if(!settings.enabled)return {ok:true,fiscal_state:'pending',subtotal,discount,total:subtotal-discount,tax_base:null,tax_total:null,groups:[],lines:items.map((item,index)=>({...item,discount_amount:allocations[index],taxed_total:item.total-allocations[index],tax_base:null,tax_amount:null,tax_snapshot:null}))};
 if(!['geral','exclusao'].includes(settings.regime))return {ok:false,error:'O enquadramento fiscal necessita de validação antes de calcular IVA.'};
 const lines=[],groups=new Map();
 for(let index=0;index<items.length;index++){
  const item=items[index],rule=rules.find(r=>r.id===item.tax_rule_id);
  if(!rule||!rule.active)return {ok:false,error:`Defina uma regra fiscal ativa para ${item.name}.`};
  if(rule.start_date>day||(rule.end_date&&rule.end_date<day))return {ok:false,error:`A regra fiscal de ${item.name} não está em vigor na data desta venda.`};
  if(!valid(rule.rate_bps)||rule.rate_bps>10000||!['tributado','isento','nao_sujeito'].includes(rule.kind)||(rule.kind!=='tributado'&&rule.rate_bps!==0)||(rule.kind==='tributado'&&rule.rate_bps===0))return {ok:false,error:`A regra fiscal de ${item.name} é inválida.`};
  if(settings.regime==='exclusao'&&rule.kind==='tributado')return {ok:false,error:`O regime de exclusão não permite liquidar IVA na venda de ${item.name}. Reveja o enquadramento e a regra.`};
  const afterDiscount=item.total-allocations[index],included=settings.price_mode==='included';
  const base=included?roundRatio(afterDiscount,10000,10000+rule.rate_bps):afterDiscount;
  const tax=included?afterDiscount-base:roundRatio(base,rule.rate_bps,10000);
  if(!valid(base)||!valid(tax)||!valid(base+tax))return {ok:false,error:'O valor calculado ultrapassa o limite permitido.'};
  const snapshot={id:rule.id,name:rule.name,kind:rule.kind,rate_bps:rule.rate_bps,legal_basis:rule.legal_basis,start_date:rule.start_date,end_date:rule.end_date||null};
  lines.push({...item,discount_amount:allocations[index],tax_base:base,tax_amount:tax,taxed_total:base+tax,tax_snapshot:snapshot});
  const key=rule.id;const group=groups.get(key)||{...snapshot,tax_base:0,tax_amount:0,total:0};group.tax_base+=base;group.tax_amount+=tax;group.total+=base+tax;groups.set(key,group);
 }
 const total=lines.reduce((sum,line)=>sum+line.taxed_total,0);
 if(!valid(total))return {ok:false,error:'O total calculado ultrapassa o limite permitido.'};
 return {ok:true,fiscal_state:'applied',subtotal,discount,total,tax_base:lines.reduce((sum,line)=>sum+line.tax_base,0),tax_total:lines.reduce((sum,line)=>sum+line.tax_amount,0),lines,groups:[...groups.values()]};
}
