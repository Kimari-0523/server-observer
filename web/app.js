import {openAuthSettings} from "./auth-settings.js";
import {installationCommands} from './install-commands.js';
import {displayIPs,composeGroups,cardMetrics} from './model.js';
import {renderCharts} from './charts.js';
import {serverHealth} from './health.js';
import {renderDiskDetails} from './disks.js';
import {openAI,openAISettings,copyButton} from './ai.js';
import {openAssistant} from './assistant-ui.js';
const $=id=>document.getElementById(id);
function updateThemeLabel(){const pastel=document.documentElement.dataset.theme==='pastel';$('theme-mono').setAttribute('aria-pressed',String(!pastel));$('theme-pastel').setAttribute('aria-pressed',String(pastel));}
for(const theme of ['mono','pastel'])$('theme-'+theme).onclick=()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('server-observer-theme',theme);}catch{}updateThemeLabel();};updateThemeLabel();
let servers=[],selected=null,passwordConfigured=true,maintenanceToken='',maintenanceActive=false,terminalCleanup,aiCleanup;
function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
async function api(path,body,options={}){const headers={'x-maintenance-token':maintenanceToken};if(body!==undefined)headers['content-type']='application/json';const r=await fetch(path,{headers,signal:options.signal,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});const value=await r.json();if(!r.ok){if(r.status===401){location.assign('/login');$('notice').replaceChildren(element('span','请登录后查看。 '));const a=element('a','前往登录');a.href='/login';$('notice').append(a);}throw new Error(value.error||'请求失败');}return value;}
function showError(e){$('notice').textContent=e.message;}
function modal(title,content){aiCleanup?.();aiCleanup=null;$('modal-title').textContent=title;$('modal-body').replaceChildren(content);$('modal').showModal();}
function pct(v){return Number.isFinite(v)?v.toFixed(1)+'%':'—';}
async function refresh(){try{const me=await api('/api/me');passwordConfigured=me.password_configured;maintenanceActive=me.maintenance;$('unlock').hidden=maintenanceActive;$('lock').hidden=!maintenanceActive;for(const id of ['ai-assistant','ai-operations','ai-settings'])$(id).hidden=!maintenanceActive;$('user').textContent=me.name+(maintenanceActive?' · 维护已验证（当前网页）':'');$('auth-settings').hidden=!maintenanceActive||!me.admin;servers=await api('/api/servers');$('notice').textContent='';render();if(selected){selected=servers.find(s=>s.id===selected.id)||selected;updateTerminalButton();renderHeading();renderDiskDetails(selected,$('disks'),element);}}catch(e){if(!e.message.includes('飞书登录'))showError(e);}}
function render(){
  const states=servers.map(s=>serverHealth(s)),online=states.filter(s=>s.online).length,degraded=states.filter(s=>s.degraded).length;
  $('summary').textContent=servers.length+' 台服务器 · '+online+' 台在线 · '+(servers.length-online)+' 台失联或待上报'+(degraded?' · '+degraded+' 台指标采集异常':'');
  $('cards').replaceChildren();
  if(!servers.length)$('cards').append(element('div','暂无服务器。完成维护验证后，生成一次性接入令牌。','empty'));
  for(const s of servers){
    const card=element('article',undefined,'card'),health=serverHealth(s),ips=displayIPs(s);card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label','查看服务器 '+(ips.public_ip||s.name));
    card.append(element('span',health.label,'badge'+(!health.online?' offline':health.degraded?' degraded':'')),element('small','公网 IPv4','ip-label'),element('h2',ips.public_ip||'未检测到'),element('div','内网 IPv4：'+(ips.private_ip||'未检测到'),'ip'),element('div',s.name,'server-name'));
    if(health.note)card.append(element('p',health.note,'collection-note'));
    const tags=element('div',undefined,'server-tags');for(const tag of s.tags||[])tags.append(element('span',tag,'server-tag'));const edit=element('button',(s.tags||[]).length?'编辑标签':'+ 添加标签','edit-tags');edit.type='button';edit.setAttribute('aria-label','编辑 '+(ips.public_ip||s.name)+' 的标签');edit.onclick=event=>{event.stopPropagation();editTags(s);};tags.append(edit);card.prepend(tags);
    if(maintenanceActive){const ipEdit=element('button','修改 IPv4','edit-ip');ipEdit.type='button';ipEdit.setAttribute('aria-label','修改 '+s.name+' 的 IPv4');ipEdit.onclick=event=>{event.stopPropagation();editIPs(s);};card.append(ipEdit);}
    const m=s.latest?.metrics||{},grid=element('div',undefined,'metrics');
    for(const {label,value,note,compact} of cardMetrics(s)){
      const cell=element('div',undefined,'metric');cell.append(element('small',label),element('b',value,compact?'compact-value':undefined));if(note)cell.append(element('span',note,'metric-note'));grid.append(cell);
    }
    card.append(grid);if(maintenanceActive){const terminal=element('button',s.platform==='win32'?'PowerShell 终端':'SSH / Shell 终端','terminal-button');terminal.type='button';terminal.onclick=event=>{event.stopPropagation();openTerminal(s);};card.append(terminal);}card.onclick=()=>openServer(s);card.onkeydown=event=>{if(event.target===card&&['Enter',' '].includes(event.key)){event.preventDefault();openServer(s);}};$('cards').append(card);
  }
}
async function editTags(server){try{await api('/api/maintenance/authorize');const form=element('form'),input=element('input'),result=element('p'),save=element('button','保存标签');input.value=(server.tags||[]).join('，');input.placeholder='例如：生产，日本，API';input.maxLength=300;save.type='submit';form.append(element('p','使用逗号分隔，最多 8 个标签，每个最多 32 个字符。'),input,save,result);form.onsubmit=async event=>{event.preventDefault();try{const value=await api('/api/servers/'+server.id+'/tags',{tags:input.value.split(/[,，]/).map(v=>v.trim()).filter(Boolean)});server.tags=value.tags;$('modal').close();render();}catch(error){result.textContent=error.message;}};modal('编辑服务器标签',form);}catch(error){showError(error);}}
async function editIPs(server){try{await api('/api/maintenance/authorize');const form=element('form'),pub=element('input'),priv=element('input'),save=element('button','保存 IPv4'),result=element('p'),detected=displayIPs({...server,ip_overrides:{}});pub.value=server.ip_overrides?.public_ipv4||'';priv.value=server.ip_overrides?.private_ipv4||'';pub.placeholder='自动检测：'+(detected.public_ip||'未检测到');priv.placeholder='自动检测：'+(detected.private_ip||'未检测到');pub.setAttribute('aria-label','手动公网 IPv4');priv.setAttribute('aria-label','手动内网 IPv4');pub.maxLength=priv.maxLength=15;pub.inputMode=priv.inputMode='decimal';save.type='submit';form.append(element('p','手动填写后，后续上报不会覆盖。留空恢复自动检测。'),element('label','公网 IPv4'),pub,element('label','内网 IPv4'),priv,save,result);form.onsubmit=async event=>{event.preventDefault();try{server.ip_overrides=await api('/api/servers/'+server.id+'/ip-overrides',{public_ipv4:pub.value,private_ipv4:priv.value});$('modal').close();render();if(selected?.id===server.id)renderHeading();}catch(e){result.textContent=e.message;}};modal('修改服务器 IPv4 · '+server.name,form);}catch(e){showError(e);}}
function renderServices(server){
  renderDiskDetails(server,$('disks'),element);
  const target=$('services');target.replaceChildren();
  const services=server.latest?.services||[];
  if(services.length){const list=element('div',undefined,'service-list');for(const service of services){const row=element('div',undefined,'service-row');row.append(element('span',service.name),element('span',service.state,'badge'+(['active','Running','running'].includes(service.state)?'':' offline')));list.append(row);}target.append(list);}
  target.append(element('h3','Docker 容器编排'));
  const containers=server.latest?.containers||[];
  if(!containers.length){target.append(element('p',server.latest?.docker_status==='unavailable'?'Docker 未安装或暂不可访问':'暂无 Docker 容器','empty-note'));return;}
  for(const group of composeGroups(containers)){
    const details=element('details',undefined,'compose-group'),summary=element('summary');
    const running=group.containers.filter(c=>c.state==='running').length;
    summary.append(element('strong',group.name),element('span',group.containers.length+' 个容器 · '+running+' 个运行中','compose-count'));
    const scroll=element('div',undefined,'table-scroll'),table=element('table'),head=element('thead'),headRow=element('tr');
    for(const name of ['容器名称','编排服务','镜像','状态','端口'])headRow.append(element('th',name));head.append(headRow);table.append(head);
    const body=element('tbody');for(const c of group.containers){const row=element('tr');for(const value of [c.name,c.service||'—',c.image,c.status||c.state,c.ports||'—'])row.append(element('td',value));body.append(row);}table.append(body);scroll.append(table);details.append(summary,scroll);target.append(details);
  }
}
function updateTerminalButton(){$('open-terminal').hidden=!maintenanceActive;$('open-terminal').textContent=selected?.platform==='win32'?'进入 PowerShell 终端':'进入 SSH / Shell 终端';}
function renderHeading(){const identity=$('page-identity');identity.replaceChildren();identity.hidden=!selected;if(!selected){$('page-title').textContent='服务器总览';return;}const ips=displayIPs(selected);$('page-title').textContent=ips.public_ip||ips.private_ip||selected.name;identity.append(element('span','公网 IPv4：'+(ips.public_ip||'未检测到')),element('span','内网 IPv4：'+(ips.private_ip||'未检测到')),element('span','主机：'+selected.name));for(const tag of selected.tags||[])identity.append(element('span',tag,'server-tag'));}
async function openServer(s){selected=s;$('cards').hidden=true;$('summary').hidden=true;$('detail').hidden=false;renderHeading();updateTerminalButton();renderServices(s);await chart();}
async function openTerminal(s){try{const {ticket}=await api('/api/servers/'+s.id+'/terminal-ticket',{}),box=element('div'),status=element('p','正在连接 '+s.name+' · '+(s.platform==='win32'?'PowerShell':'Ubuntu Shell')+'（Agent 加密直通）'),screen=element('div',undefined,'terminal-screen');box.append(status,screen);modal('远程终端',box);$('modal').classList.add('terminal-modal');const term=new window.Terminal({cursorBlink:true,cols:100,rows:28,fontSize:14,fontFamily:'Consolas, monospace',scrollback:3000,theme:{background:'#111318',foreground:'#e8e8eb'}});term.open(screen);const url=new URL('/api/terminal/'+s.id,location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket);const socket=new WebSocket(url);let ready=false;const fit=()=>{if(!ready)return;const cols=Math.min(300,Math.max(20,Math.floor(screen.clientWidth/8.5))),rows=Math.min(150,Math.max(5,Math.floor(screen.clientHeight/17)));term.resize(cols,rows);socket.send(JSON.stringify({type:'resize',cols,rows}));};const observer=new ResizeObserver(fit);observer.observe(screen);term.onData(data=>{if(socket.readyState===1&&ready)socket.send(JSON.stringify({type:'input',data}));});socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.type==='data')term.write(m.data);if(m.type==='ready'){ready=true;status.textContent='已连接 · '+s.name+' · 关闭终端将结束 Shell';fit();term.focus();}if(m.type==='closed')status.textContent='终端已关闭：'+m.reason;};socket.onclose=()=>{ready=false;status.textContent='终端连接已结束';};socket.onerror=()=>{status.textContent='终端连接失败，请刷新服务器状态后重试';};terminalCleanup=()=>{observer.disconnect();socket.close();term.dispose();$('modal').classList.remove('terminal-modal');terminalCleanup=null;};}catch(e){showError(e);}}
$('open-terminal').onclick=()=>openTerminal(selected);
$('modal').addEventListener('close',()=>{terminalCleanup?.();aiCleanup?.();aiCleanup=null;});
const dialog=$('modal');let backdropPress=false;
function outsideDialog(event){const box=dialog.getBoundingClientRect();return event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom;}
dialog.addEventListener('pointerdown',event=>{backdropPress=event.target===dialog&&outsideDialog(event);});
dialog.addEventListener('click',event=>{if(backdropPress&&event.target===dialog&&outsideDialog(event))dialog.close();backdropPress=false;});
$('modal-x').onclick=()=>dialog.close();
$('ai-operations').onclick=async()=>{try{aiCleanup=await openAI({api,modal,element,servers});}catch(e){showError(e);}};
$('ai-settings').onclick=async()=>{try{await openAISettings({api,modal,element});}catch(e){showError(e);}};
$('ai-assistant').onclick=async()=>{try{aiCleanup=await openAssistant({api,modal,element,servers,selected});}catch(e){showError(e);}};
$('lock').onclick=async()=>{try{await api('/api/lock',{token:maintenanceToken});maintenanceToken='';terminalCleanup?.();$('modal').close();await refresh();}catch(e){showError(e);}};
addEventListener('pagehide',()=>{if(maintenanceToken){navigator.sendBeacon('/api/lock',new Blob([JSON.stringify({token:maintenanceToken})],{type:'application/json'}));maintenanceToken='';}terminalCleanup?.();});
async function chart(){try{const rows=await api(`/api/servers/${selected.id}/history?days=${$('days').value}`);renderCharts(rows,$('charts'));}catch(e){showError(e);}}
$('refresh').onclick=refresh;$('back').onclick=()=>{selected=null;$('detail').hidden=true;$('cards').hidden=false;$('summary').hidden=false;renderHeading();};$('days').onchange=chart;$('close-modal').onclick=()=>$('modal').close();
$('unlock').onclick=()=>{if(!passwordConfigured){modal('维护密码尚未设置',element('p','请由管理员使用安装配置工具设置维护密码。'));return;}const form=element('form'),input=element('input');input.type='password';input.autocomplete='current-password';input.placeholder='维护密码';input.required=true;const submit=element('button','验证'),result=element('p');submit.type='submit';form.append(element('p','验证后在当前网页持续有效；手动退出维护或关闭网页后失效。'),input,submit,result);form.onsubmit=async e=>{e.preventDefault();try{const value=await api('/api/unlock',{password:input.value});maintenanceToken=value.token;input.value='';$('modal').close();await refresh();}catch(err){result.textContent=err.message;}};modal('维护验证',form);};
$('add').onclick=async()=>{try{const result=await api('/api/enrollment',{});const box=element('div'),{ubuntu,windows}=installationCommands(result.token);box.append(element('p','在目标服务器的管理员终端运行对应命令。令牌一次有效，10 分钟后过期。每添加一台服务器请重新生成。'),element('h3','Ubuntu · SSH 终端'),copyButton('复制 Ubuntu 安装命令',ubuntu,element),element('pre',ubuntu),element('h3','Windows · 管理员 PowerShell'),copyButton('复制 PowerShell 安装命令',windows,element),element('pre',windows));modal('添加服务器',box);}catch(e){showError(e);}};
refresh();
$('notifications').onclick=async()=>{try{const saved=await api('/api/settings/notifications'),form=element('form'),hook=element('input'),sign=element('input'),result=element('p');hook.type='password';hook.autocomplete='off';hook.placeholder=saved.webhook_masked||'飞书群机器人 Webhook';sign.type='password';sign.autocomplete='new-password';sign.placeholder=saved.signature_configured?'签名密钥已配置，留空保留':'签名密钥（机器人未启用时留空）';const button=element('button','保存');button.type='submit';form.append(element('p','配置由当前部署的监控服务加密保存。留空将保留原配置。'),hook,sign,button,result);form.onsubmit=async e=>{e.preventDefault();try{await api('/api/settings/notifications',{webhook:hook.value,secret:sign.value});hook.value='';sign.value='';result.textContent='已保存';}catch(err){result.textContent=err.message;}};modal('飞书群告警设置',form);}catch(e){showError(e);}};

$('auth-settings').onclick=()=>openAuthSettings({api,modal,element}).catch(showError);
$('logout').onclick=async()=>{try{await api('/auth/logout',{});location.assign('/login');}catch(e){showError(e);}};
