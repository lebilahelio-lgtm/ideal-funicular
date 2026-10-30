import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settlement,compareAmounts} from '../public/calculations.js';

test('payments distinguish shortfall, exact payment and change down to one cent',()=>{
 const short=settlement(100000,10000,89999,'dinheiro');assert.equal(short.ok,false);assert.equal(short.shortfall,1);assert.match(short.error,/insuficiente/);assert.equal(short.change,0);
 const exact=settlement(100000,10000,90000,'dinheiro');assert.equal(exact.ok,true);assert.equal(exact.change,0);assert.equal(exact.total,90000);
 const over=settlement(100000,10000,100000,'dinheiro');assert.equal(over.ok,true);assert.equal(over.change,10000);
 assert.equal(settlement(100000,10000,null,'dinheiro').ok,false);
});
test('all electronic payments reject shortages and excesses with precise messages',()=>{
 for(const method of ['tpa','transferencia']){
  assert.equal(settlement(100000,0,100000,method).ok,true);
  assert.match(settlement(100000,0,99999,method).error,/insuficiente/);
  assert.match(settlement(100000,0,100001,method).error,/excede/);
 }
});
test('discounts cannot exceed subtotal; full discount never creates negative totals',()=>{
 assert.match(settlement(100,101,0,'dinheiro').error,/desconto excede/);
 assert.equal(settlement(100,100,0,'dinheiro').total,0);
 assert.equal(settlement(100,100,50,'dinheiro').change,50);
 assert.equal(settlement(0,0,0,'dinheiro').ok,true);
 for(const value of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1]){
  assert.equal(settlement(100,0,value,'dinheiro').ok,false);
  assert.equal(compareAmounts(value,0).ok,false);
 }
});
test('cash discrepancies retain their sign and the counted truth',()=>{
 assert.deepEqual(compareAmounts(500000,490000),{ok:true,difference:-10000,shortfall:10000,excess:0});
 assert.deepEqual(compareAmounts(500000,510000),{ok:true,difference:10000,shortfall:0,excess:10000});
 assert.equal(compareAmounts(500000,500000).difference,0);
});
