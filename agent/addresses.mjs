import {isIP} from 'node:net';
export const isVirtualInterface=name=>/^(docker|br-|veth[0-9a-f]+$|cni|flannel|virbr|lo$)/i.test(name);
export function hostAddresses(interfaces){return [...new Set(Object.entries(interfaces).filter(([name])=>!isVirtualInterface(name)).flatMap(([,values])=>(values||[]).filter(v=>!v.internal&&isIP(v.address)).map(v=>v.address)))].slice(0,64);}
