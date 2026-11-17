import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverPublicIPv4,parseProbeIPv4,publicIPv4,validCachedAddress,probeRetryInterval} from '../agent/public-ip.mjs';
import {displayIPs} from '../web/model.js';

test('public interface takes priority and Docker/TUN/reserved addresses cannot become public identities',async()=>{
  const interfaces={tun0:[{address:'8.8.4.4'}],docker0:[{address:'172.17.0.1'}],ens18:[{address:'9.9.9.9'}]};
  assert.deepEqual(await discoverPublicIPv4({interfaces,probe:()=>{throw Error('must not probe');}}),{address:'9.9.9.9',source:'interface:ens18'});
  for(const value of ['192.168.1.14','100.64.1.2','198.18.0.1','127.0.0.1','169.254.1.2','224.0.0.1','::1',null,{}])assert.equal(publicIPv4(value),false);
});
test('NAT hosts use a separate IP probe, and failures never use the monitoring proxy exit',async()=>{
  const interfaces={Ethernet:[{address:'192.168.1.51'}]};
  assert.deepEqual(await discoverPublicIPv4({interfaces,probe:async()=> '198.51.100.5'}),{address:'198.51.100.5',source:'probe:myip.ipip.net'});
  assert.deepEqual(await discoverPublicIPv4({interfaces,probe:async()=>{throw Error('DNS unavailable');}}),{address:null,source:'unavailable'});
  assert.equal(displayIPs({public_ip:'198.51.100.40',latest:{public_ipv4:null}}).public_ip,null);
  assert.equal(displayIPs({public_ip:'198.51.100.40',latest:{public_ipv4:null},ip_overrides:{public_ipv4:'198.51.100.5'}}).public_ip,'198.51.100.5');
});
test('IP probe parser accepts the actual provider response but rejects HTML, invalid and private addresses',()=>{
  for(const body of ['198.51.100.5\n','当前 IP：198.51.100.5 来自于：中国 四川 成都 移动','当前 IP: 198.51.100.5 来自于：中国','{"ip":"198.51.100.5"}'])assert.equal(parseProbeIPv4(body),'198.51.100.5');
  for(const body of ['<html>198.51.100.5</html>','192.168.1.51','{"ip":{}}','198.51.100.999','unexpected 198.51.100.5'])assert.equal(parseProbeIPv4(body),null);
});
test('a failed primary probe uses the validated direct backup rather than the monitoring proxy',async()=>{const seen=[];const result=await discoverPublicIPv4({interfaces:{Ethernet:[{address:'192.168.1.3'}]},probe:async url=>{seen.push(url);if(seen.length===1)throw Error('timeout');return parseProbeIPv4('\n{"ip":"198.51.100.5","pro":"�Ĵ�ʡ"}\n');}});assert.equal(result.address,'198.51.100.5');assert.equal(result.source,'probe:whois.pconline.com.cn');assert.equal(seen.length,2);});
test('only recent verified addresses survive restarts, and empty discovery retries promptly',()=>{const cached={address:'198.51.100.5',source:'probe:myip.ipip.net',checked_at:100000};assert(validCachedAddress(cached,110000));assert(!validCachedAddress(cached,100000+86400000));assert(!validCachedAddress({...cached,address:'192.168.1.31'},110000));assert(!validCachedAddress({...cached,source:'transport'},110000));assert.equal(probeRetryInterval(null),30000);assert.equal(probeRetryInterval('198.51.100.5'),600000);});
