const NS='http://www.w3.org/2000/svg';
const definitions=[['cpu_percent','CPU 使用率','%'],['memory_percent','内存使用率','%'],['disk_percent','磁盘空间使用率','%'],['io_pressure_percent','IO 压力停滞 · 10 秒平均','%'],['cpu_pressure_percent','CPU 压力停滞 · 10 秒平均','%'],['memory_pressure_percent','内存压力停滞 · 10 秒平均','%'],['disk_read_bps','磁盘读取','B/s'],['disk_write_bps','磁盘写入','B/s'],['disk_read_iops','磁盘读取 IOPS','次/秒'],['disk_write_iops','磁盘写入 IOPS','次/秒'],['network_rx_bps','网络接收','B/s'],['network_tx_bps','网络发送','B/s']];
export function closestSample(values,time){let lo=0,hi=values.length-1;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(values[mid].t<time)lo=mid+1;else hi=mid;}if(lo>0&&Math.abs(values[lo-1].t-time)<Math.abs(values[lo].t-time))return lo-1;return lo;}
export function chartUnit(unit,max){if(unit!=='B/s')return {unit,divisor:1};for(const[divisor,name]of [[1073741824,'GB/s'],[1048576,'MB/s'],[1024,'KB/s']])if(max>=divisor)return {unit:name,divisor};return {unit:'B/s',divisor:1};}
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function svgEl(tag,attrs={}){const e=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;}
function number(value){return value.toLocaleString('zh-CN',{maximumFractionDigits:2});}
function labelTime(t,span){const date=new Date(t*1000);return span<=172800?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):date.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'});}
function drawChart(rows,key,title,unit){
  const panel=el('div',undefined,'chart'),heading=el('div',undefined,'chart-heading');heading.append(el('h3',title));panel.append(heading);
  const values=rows.filter(r=>Number.isFinite(r.metrics[key])).sort((a,b)=>a.t-b.t);
  if(!values.length){panel.append(el('p','暂无采样数据','empty-note'));return panel;}
  const rawMax=values.reduce((m,r)=>Math.max(m,r.metrics[key],r.metrics[key+'_max']||0),0),scale=chartUnit(unit,rawMax);
  const maximum=unit==='%'&&!key.includes('_pressure_')?100:Math.max(1,rawMax/scale.divisor)*1.1;
  const min=values[0].t,max=values.at(-1).t,span=Math.max(max-min,60);
  const left=62,right=582,top=22,bottom=174;
  const x=t=>left+(t-min)/span*(right-left),y=v=>bottom-Math.min(v/scale.divisor,maximum)/maximum*(bottom-top);
  const svg=svgEl('svg',{viewBox:'0 0 600 220',role:'img',tabindex:0,'aria-label':title+'，横轴时间，纵轴'+scale.unit+'。使用左右方向键查看采样数值。'});
  heading.append(el('span','单位：'+scale.unit,'chart-unit'));
  for(let i=0;i<=4;i++){
    const value=maximum*i/4,cy=bottom-i/4*(bottom-top);
    svg.append(svgEl('line',{x1:left,x2:right,y1:cy,y2:cy,class:'chart-grid'}));
    const label=svgEl('text',{x:left-8,y:cy+4,'text-anchor':'end',class:'axis-text'});label.textContent=number(value);svg.append(label);
  }
  for(let i=0;i<=4;i++){
    const t=min+span*i/4,label=svgEl('text',{x:left+(right-left)*i/4,y:195,'text-anchor':i===0?'start':i===4?'end':'middle',class:'axis-text'});label.textContent=labelTime(t,span);svg.append(label);
  }
  const timeLabel=svgEl('text',{x:right,y:215,'text-anchor':'end',class:'axis-text'});timeLabel.textContent='时间';svg.append(timeLabel);
  function line(peak){let segment=[],previous;
    const flush=()=>{if(!segment.length)return;svg.append(svgEl('polyline',{points:segment.join(' '),fill:'none',stroke:peak?'var(--chart-peak)':'var(--chart-line)','stroke-width':peak?1.6:2,...(peak?{'stroke-dasharray':'5 4'}:{})}));segment=[];};
    for(const r of values){if(previous&&r.t-previous.t>Math.max(r.resolution,previous.resolution)*2)flush();segment.push(x(r.t)+','+y(peak?(r.metrics[key+'_max']??r.metrics[key]):r.metrics[key]));previous=r;}flush();
  }
  const hasPeak=values.some(r=>Number.isFinite(r.metrics[key+'_max'])&&r.metrics[key+'_max']!==r.metrics[key]);if(hasPeak)line(true);line(false);
  const cross=svgEl('line',{x1:left,x2:left,y1:top,y2:bottom,class:'chart-crosshair',visibility:'hidden'}),dot=svgEl('circle',{cx:left,cy:bottom,r:4,fill:'var(--chart-line)',visibility:'hidden'});
  svg.append(cross,dot,svgEl('rect',{x:left,y:top,width:right-left,height:bottom-top,fill:'transparent'}));
  const tooltip=el('div',undefined,'chart-tooltip');tooltip.setAttribute('role','tooltip');tooltip.hidden=true;
  const legend=el('div',undefined,'chart-legend'),sample=el('span','采样值 / 平均值','legend-value');legend.append(sample);if(hasPeak)legend.append(el('span','峰值','legend-peak'));
  const latest=values.at(-1),latestLabel=el('span','最新 '+number(latest.metrics[key]/scale.divisor)+' '+scale.unit,'chart-latest');legend.append(latestLabel);
  panel.append(svg,legend,el('small',new Date(min*1000).toLocaleString('zh-CN',{hour12:false})+' — '+new Date(max*1000).toLocaleString('zh-CN',{hour12:false})),tooltip);
  let selected=values.length-1;
  function show(index,event){selected=index;const r=values[index],value=r.metrics[key]/scale.divisor;
    tooltip.replaceChildren(el('strong',new Date(r.t*1000).toLocaleString('zh-CN',{hour12:false})),el('div',title+'：'+number(value)+' '+scale.unit));
    if(Number.isFinite(r.metrics[key+'_max']))tooltip.append(el('div','峰值：'+number(r.metrics[key+'_max']/scale.divisor)+' '+scale.unit));
    tooltip.append(el('small','采样精度：'+(r.resolution>=3600?'1 小时':r.resolution>=300?'5 分钟':'1 分钟')));tooltip.hidden=false;
    cross.setAttribute('x1',x(r.t));cross.setAttribute('x2',x(r.t));cross.setAttribute('visibility','visible');dot.setAttribute('cx',x(r.t));dot.setAttribute('cy',y(r.metrics[key]));dot.setAttribute('visibility','visible');
    const bounds=panel.getBoundingClientRect();const px=event?event.clientX-bounds.left:bounds.width/2,py=event?event.clientY-bounds.top:50;
    tooltip.style.left=Math.max(8,Math.min(px+14,bounds.width-tooltip.offsetWidth-10))+'px';tooltip.style.top=Math.max(8,Math.min(py+14,bounds.height-tooltip.offsetHeight-8))+'px';
  }
  function hide(){tooltip.hidden=true;cross.setAttribute('visibility','hidden');dot.setAttribute('visibility','hidden');}
  svg.addEventListener('pointermove',event=>{const bounds=svg.getBoundingClientRect(),cx=(event.clientX-bounds.left)/bounds.width*600,cy=(event.clientY-bounds.top)/bounds.height*220;if(cx<left||cx>right||cy<top||cy>bottom){hide();return;}const time=min+(cx-left)/(right-left)*span,index=closestSample(values,time);if(Math.abs(values[index].t-time)>Math.max(60,values[index].resolution)*1.2){hide();return;}show(index,event);});
  svg.addEventListener('pointerleave',hide);svg.addEventListener('focus',()=>show(selected));svg.addEventListener('blur',hide);svg.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();show(Math.max(0,Math.min(values.length-1,selected+(event.key==='ArrowLeft'?-1:1))));}});
  return panel;
}
export function renderCharts(rows,target){target.replaceChildren(...definitions.map(([key,title,unit])=>drawChart(rows,key,title,unit)));}
