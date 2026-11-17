import test from 'node:test';
import assert from 'node:assert/strict';
import {MaintenanceSessions} from '../backend/maintenance.mjs';
test('maintenance is scoped to one issued token and user, not a shared user flag',()=>{const m=new MaintenanceSessions(),a=m.create('user'),b=m.create('user');assert.notEqual(a,b);assert(m.key(a,'user'));assert.equal(m.key(a,'other'),null);m.revoke(a,'user');assert.equal(m.key(a,'user'),null);assert(m.key(b,'user'));});
test('manual logout revokes terminal authorization through the callback',()=>{let ended;const m=new MaintenanceSessions(key=>ended=key),token=m.create('user'),key=m.key(token,'user');assert(m.active(key,'user'));assert(m.revoke(token,'user'));assert.equal(ended,key);assert(!m.active(key,'user'));});
test('maintenance remains valid beyond ten minutes while the page session exists',()=>{const m=new MaintenanceSessions(),token=m.create('user'),original=Date.now;try{Date.now=()=>original()+24*3600000;assert(m.key(token,'user'));}finally{Date.now=original;}});
