import {DatabaseSync} from 'node:sqlite';
import {initStore} from '../shared/store.mjs';
export {saveReport,compact} from '../shared/store.mjs';
export function openStore(path=':memory:'){const db=new DatabaseSync(path);db.transaction=fn=>{db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};return initStore(db);}
