import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTags} from '../backend/tags.mjs';
test('labels trim whitespace, deduplicate and preserve Chinese text',()=>{assert.deepEqual(normalizeTags([' 生产 ','Ubuntu','生产','']),['生产','Ubuntu']);});
test('labels reject invalid types, oversized values and control characters',()=>{for(const input of ['生产',[42],['a'.repeat(33)],['bad\nlabel'],Array(9).fill('a')])assert.throws(()=>normalizeTags(input));});
