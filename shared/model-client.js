const formats=new Map();
const modelError=(code,message)=>Object.assign(new Error(message),{public_error:true,code});
export function modelHeaders(settings,json=true){const headers={...(json?{'content-type':'application/json'}:{}),...(settings.api_key?{authorization:'Bearer '+settings.api_key}:{})};return headers;}
export function approvalContext(messages,jobs){const byId=new Map(jobs.map(job=>[job.id,job]));return messages.map(message=>{if(message.role!=='tool')return message;try{const value=JSON.parse(message.content),job=byId.get(value?.id);if(!job||value.command!==job.command)return message;const approved=job.mode==='manual'&&!!job.approved_by;return {...message,content:JSON.stringify({...value,execution_mode:job.mode,human_approved:approved,approval_status:job.mode==='auto'?'not_required':approved?'approved':job.status==='rejected'?'rejected':'not_approved',approval_time:approved?job.started_at:null,result_delivery:'平台在必要的网页人工审批和命令执行结束后，才把最终结果返回给模型；这不表示跳过审批。'})};}catch{return message;}});}
export function parseModelPayload(text,contentType){
  if(!contentType.includes('text/event-stream')){try{return JSON.parse(text);}catch{throw modelError('invalid_json','模型接口未返回有效 JSON，请检查接口协议');}}
  let completed,finishReason,content='',done=false;const calls=new Map();
  for(const block of text.replaceAll('\r\n','\n').split('\n\n')){const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;if(data==='[DONE]'){done=true;continue;}let value;try{value=JSON.parse(data);}catch{throw modelError('invalid_stream','模型接口返回了无效的流数据');}
    if(value.type==='response.completed'||value.type==='response.incomplete')completed=value.response;
    const choice=value.choices?.[0];if(choice){if(choice.finish_reason)finishReason=choice.finish_reason;if(typeof choice.delta?.content==='string')content+=choice.delta.content;for(const delta of choice.delta?.tool_calls||[]){let call=calls.get(delta.index);if(!call){call={id:'',type:'function',function:{name:'',arguments:''}};calls.set(delta.index,call);}if(delta.id)call.id=delta.id;if(delta.function?.name)call.function.name+=delta.function.name;if(delta.function?.arguments)call.function.arguments+=delta.function.arguments;}}
  }
  if(completed)return completed;
  if(done&&finishReason)return {choices:[{finish_reason:finishReason,message:{content,tool_calls:[...calls.values()]}}]};
  throw modelError('incomplete_stream','模型流式回复未完整结束，未执行工具');
}
export function responsesInput(messages){const input=[];for(const m of messages){if(m.role==='system')continue;if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.tool_call_id,output:m.content});continue;}if(m.role==='assistant'&&m.response_items){for(const item of m.response_items)input.push(item);continue;}if(m.content)input.push({role:m.role,content:m.content});if(m.role==='assistant')for(const call of m.tool_calls||[])input.push({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments});}return input;}
export function normalizeModel(value,format){
  if(format==='responses'){
    if(value.status==='incomplete')throw modelError('token_limit','模型回复达到输出限制，请调整模型推理设置后重试');
    if(!Array.isArray(value.output)||value.error)throw modelError('response_format','模型接口的 Responses 回复格式不兼容');
    const content=value.output.filter(item=>item.type==='message').flatMap(item=>item.content||[]).map(part=>part.type==='output_text'?part.text:part.type==='refusal'?part.refusal:'').join('\n');
    const calls=value.output.filter(item=>item.type==='function_call').map(item=>({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}}));
    return {content,tool_calls:calls,response_items:value.output.filter(item=>['message','reasoning','function_call'].includes(item.type))};
  }
  const choice=value.choices?.[0],message=choice?.message;if(!message||choice.finish_reason==='length')throw modelError('chat_format','模型回复不完整或 Chat Completions 格式不兼容');
  const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'):message.refusal||'';return {content,tool_calls:message.tool_calls||[]};
}
export async function callModel(settings,prepared,{fetcher=fetch,signal}={}){
  const base=new URL(settings.base_url);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('AI 接口地址须为不含凭据的 HTTPS 地址');
  if(!settings.model)throw new Error('请先在 AI 设置填写模型名称');
  const cacheKey=settings.base_url+':'+settings.model,hasResponseHistory=prepared.messages.some(m=>m.response_items),preferred=hasResponseHistory?'responses':formats.get(cacheKey)||'responses';
  const attempt=async format=>{
    const common={model:settings.model,stream:false,store:false,parallel_tool_calls:false,tool_choice:'auto'};
    const payload=format==='responses'?{...common,instructions:prepared.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),input:responsesInput(prepared.messages),tools:prepared.tools.map(t=>({type:'function',...t.function})),include:['reasoning.encrypted_content'],max_output_tokens:8192}:{...common,messages:prepared.messages.map(({role,content,tool_calls,tool_call_id})=>({role,content,...(tool_calls?{tool_calls}:{}),...(tool_call_id?{tool_call_id}:{})})),tools:prepared.tools,max_completion_tokens:8192};
    const url=settings.base_url.replace(/\/+$/,'')+(format==='responses'?'/responses':'/chat/completions');
    let response;try{response=await fetcher(url,{method:'POST',headers:modelHeaders(settings),body:JSON.stringify(payload),redirect:'manual',signal:signal&&typeof AbortSignal.any==='function'?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});}catch(e){let detail=String(e.message||e.name||'网络错误');for(const secret of [settings.api_key])if(secret)detail=detail.replaceAll(secret,'[已隐藏]');throw modelError('network','模型请求失败：'+detail.replace(/[\r\n]/g,' ').slice(0,180));}
    if(response.status>=300&&response.status<400){await response.body?.cancel();throw modelError('redirect','模型接口返回重定向，已停止转发密钥；请填写最终 HTTPS 接口地址');}
    if(!response.ok){let detail='';try{const reader=response.body?.getReader();if(reader){let raw='';const decoder=new TextDecoder();for(;;){const part=await reader.read();if(part.done)break;raw+=decoder.decode(part.value,{stream:true});if(raw.length>8192){await reader.cancel();break;}}const value=JSON.parse(raw);const text=value.error?.message||value.message||value.detail;if(typeof text==='string')detail=text;}}catch{}for(const secret of [settings.api_key])if(secret)detail=detail.replaceAll(secret,'[已隐藏]');detail=detail.replace(/sk-[A-Za-z0-9_-]{8,}/g,'[已隐藏]').replace(/[\r\n]/g,' ').slice(0,220);throw Object.assign(new Error('模型接口 HTTP '+response.status+'（'+(format==='responses'?'Responses':'Chat Completions')+'）'+(detail?'：'+detail:'；请检查接口、模型、余额和密钥')),{http_status:response.status});}
    let size=0;const parts=[];if(response.body){const reader=response.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw new Error('模型回复超过大小限制');}parts.push(value);}}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}const value=parseModelPayload(new TextDecoder().decode(bytes),response.headers.get('content-type')||'');return normalizeModel(value,format);
  };
  try{try{const result=await attempt(preferred);formats.set(cacheKey,preferred);if(formats.size>50)formats.delete(formats.keys().next().value);return result;}catch(e){if(preferred==='responses'&&!hasResponseHistory&&[404,405,501].includes(e.http_status)){const result=await attempt('chat');formats.set(cacheKey,'chat');return result;}throw e;}}catch(e){
    if(e.http_status===404)try{const response=await fetcher(settings.base_url.replace(/\/+$/,'')+'/models',{headers:modelHeaders(settings,false),redirect:'manual',signal:AbortSignal.timeout(10000)});if(response.ok){const value=await response.json(),ids=Array.isArray(value.data)?value.data.map(m=>m.id).filter(id=>typeof id==='string'):[];e.message+=ids.includes(settings.model)?'；密钥验证通过且模型列表包含 '+settings.model+'，请检查该模型的上游生成渠道':ids.length?'；当前密钥的模型列表不包含 '+settings.model:'；模型列表返回空，请检查模型授权';}else{await response.body?.cancel();e.message+='；模型列表接口 HTTP '+response.status;}}catch{}
    throw e;
  }
}
