import {test} from 'node:test';
import assert from 'node:assert/strict';
import {expiryStatus,productExpiryStatus,unavailableStockStatus} from '../public/stock-status.js';

test('unavailable stock colors use available stock as the baseline, including threshold boundaries',()=>{
 for(const [unavailable,available,status] of [[0,100,'low'],[4.999,100,'low'],[5,100,'warning'],[30,100,'warning'],[30.001,100,'healthy'],[0.005,0.1,'warning'],[0,0,'low'],[10,0,'healthy']]){
  assert.equal(unavailableStockStatus(unavailable,available),status,`${unavailable}/${available}`);
 }
});

test('expiry colors respect the Angola day, warning window and end-of-day validity',()=>{
 assert.equal(expiryStatus('2026-11-10',7,'2026-11-02'),'healthy');
 assert.equal(expiryStatus('2026-11-09',7,'2026-11-02'),'warning');
 assert.equal(expiryStatus('2026-11-02',7,'2026-11-02'),'warning');
 assert.equal(expiryStatus('2026-11-01',7,'2026-11-02'),'expired');
 assert.equal(expiryStatus('2027-01-01',7,'2026-12-29'),'warning');
 assert.equal(expiryStatus(null,7,'2026-11-02'),'healthy');
 assert.equal(expiryStatus('2026-11-03',0,'2026-11-02'),'healthy');assert.equal(expiryStatus('2026-11-02',0,'2026-11-02'),'warning');
});
test('product alarm prioritizes expired released lots, ignoring pending and exhausted lots',()=>{
 const healthy={sale_enabled:1,remaining:1000,expires_on:'2026-12-31'},warning={sale_enabled:1,remaining:500,expires_on:'2026-11-05'},expired={sale_enabled:1,remaining:100,expires_on:'2026-11-01'};
 const status=lots=>productExpiryStatus(lots,7,'2026-11-02');
 assert.equal(status([healthy]),'healthy');assert.equal(status([healthy,warning]),'warning');assert.equal(status([healthy,warning,expired]),'expired');
 assert.equal(status([healthy,{...expired,sale_enabled:0}]),'healthy');assert.equal(status([healthy,{...expired,remaining:0}]),'healthy');
 assert.equal(status([{...expired,sale_enabled:0}]),'pending');
});
