import test from 'node:test';
import assert from 'node:assert/strict';
import {closestSample,chartUnit} from '../web/charts.js';
test('hover selects the nearest actual sample including time-range boundaries',()=>{const rows=[{t:100},{t:160},{t:400}];assert.equal(closestSample(rows,90),0);assert.equal(closestSample(rows,159),1);assert.equal(closestSample(rows,390),2);assert.equal(closestSample(rows,900),2);});
test('IO chart units scale without changing percentage units',()=>{assert.deepEqual(chartUnit('B/s',2048),{unit:'KB/s',divisor:1024});assert.deepEqual(chartUnit('%',98),{unit:'%',divisor:1});});
