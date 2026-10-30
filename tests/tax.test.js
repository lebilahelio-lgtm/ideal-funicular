import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocateDiscount,calculateTaxBasket} from '../public/tax.js';

// Rates below are arithmetic fixtures, not assertions about Angolan legislation.
const day='2026-10-30';
const rules=[{id:1,name:'Fixture A',kind:'tributado',rate_bps:1400,start_date:'2026-01-01',end_date:null,active:1,legal_basis:'Apenas teste de cálculo'},
 {id:2,name:'Fixture B',kind:'tributado',rate_bps:500,start_date:'2026-01-01',end_date:null,active:1,legal_basis:'Apenas teste de cálculo'},
 {id:3,name:'Fixture isenta',kind:'isento',rate_bps:0,start_date:'2026-01-01',end_date:null,active:1,legal_basis:'Apenas teste de cálculo'}];
const settings={enabled:1,regime:'geral',price_mode:'included'};
const item=(total,tax_rule_id)=>({id:tax_rule_id,name:'Produto '+tax_rule_id,total,tax_rule_id});

test('included VAT is extracted, never added twice; discount precedes extraction',()=>{
 const r=calculateTaxBasket([item(11400,1)],1140,settings,rules,day);
 assert.equal(r.ok,true);assert.equal(r.subtotal,11400);assert.equal(r.total,10260);assert.equal(r.tax_base,9000);assert.equal(r.tax_total,1260);
 assert.equal(r.lines[0].discount_amount,1140);assert.equal(r.tax_base+r.tax_total,r.total);
});
test('excluded VAT is added by product after proportional discount',()=>{
 const r=calculateTaxBasket([item(10000,1),item(5000,2)],3000,{...settings,price_mode:'excluded'},rules,day);
 assert.equal(r.ok,true);assert.equal(r.tax_base,12000);assert.equal(r.tax_total,1320);assert.equal(r.total,13320);
 assert.deepEqual(r.lines.map(l=>l.discount_amount),[2000,1000]);
});
test('mixed rates and exemptions reconcile exactly with the receipt',()=>{
 const r=calculateTaxBasket([item(11400,1),item(10500,2),item(3000,3)],2490,settings,rules,day);
 assert.equal(r.ok,true);assert.equal(r.total,22410);assert.equal(r.tax_base,20700);assert.equal(r.tax_total,1710);
 assert.equal(r.groups.length,3);assert.equal(r.groups.reduce((s,g)=>s+g.total,0),r.total);
 assert.equal(r.lines[2].tax_amount,0);assert.equal(r.lines[2].tax_snapshot.kind,'isento');
});
test('rounding and largest remainders preserve every cent across many baskets',()=>{
 assert.deepEqual(allocateDiscount([1,1,1],1),[1,0,0]);
 for(let i=1;i<200;i++){
  const amounts=[i,i+1,i+7],discount=i%7,allocation=allocateDiscount(amounts,discount);
  assert.equal(allocation.reduce((a,b)=>a+b,0),discount);
  for(const price_mode of ['included','excluded']){
   const r=calculateTaxBasket(amounts.map((n,j)=>item(n,j+1)),discount,{...settings,price_mode},rules,day);
   assert.equal(r.ok,true);assert.equal(r.tax_base+r.tax_total,r.total);
   assert.equal(r.lines.reduce((s,l)=>s+l.taxed_total,0),r.total);
  }
 }
});
test('pending does not claim exemption; active rules require complete and current classification',()=>{
 const pending=calculateTaxBasket([item(10000,null)],1000,{enabled:0},[],day);
 assert.equal(pending.fiscal_state,'pending');assert.equal(pending.tax_total,null);assert.equal(pending.tax_base,null);assert.equal(pending.total,9000);
 assert.equal(calculateTaxBasket([item(10000,null)],0,settings,rules,day).ok,false);
 assert.equal(calculateTaxBasket([item(10000,1)],0,settings,[{...rules[0],active:0}],day).ok,false);
 assert.equal(calculateTaxBasket([item(10000,1)],0,settings,[{...rules[0],start_date:'2026-10-31'}],day).ok,false);
 assert.equal(calculateTaxBasket([item(10000,1)],0,settings,[{...rules[0],end_date:'2026-10-29'}],day).ok,false);
 assert.equal(calculateTaxBasket([item(10000,1)],0,{...settings,regime:'exclusao'},rules,day).ok,false);
 assert.equal(calculateTaxBasket([item(10000,3)],0,{...settings,regime:'exclusao'},rules,day).ok,true);
 assert.equal(calculateTaxBasket([item(10000,1)],10001,settings,rules,day).ok,false);
});
