import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '@earendil-works/pi-agent-core';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, normalizeContext, Type } from '@earendil-works/pi-ai';
import { createBudgetLedger } from '@oms/core';
import { createDispatchAllocator } from '@oms/core/dispatch';
import { createMeteredStream } from '../src/runtime/usage.ts';
import { ClaudeCodeSession, claudeCodeEnvironment, createClaudeCodeProvider, createClaudeCodeStream, inspectClaudeCode } from '../src/runtime/claude-code.ts';
const context = (content='FIRST_SECRET') => normalizeContext({ systemPrompt:'Trusted OMS',tools:[{name:'read',description:'Read',parameters:Type.Object({path:Type.String()})}],messages:[{role:'user',content,timestamp:1}] });
const rows=(path:string)=>readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
async function fixture(mode:string, run:(directory:string)=>Promise<void>) {
 const directory=mkdtempSync(join(tmpdir(),'oms-native-test-')); const originalPath=process.env.PATH;
 writeFileSync(join(directory,'claude'),`#!${process.execPath}
import{appendFileSync,existsSync,readFileSync,writeFileSync}from'node:fs';
import{spawn}from'node:child_process';import{createInterface}from'node:readline';
const mode=${JSON.stringify(mode)},root=${JSON.stringify(directory)},args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:mode==='api-auth'?'api_key':'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
const id=get(args.includes('--resume')?'--resume':'--session-id');appendFileSync(root+'/launch',JSON.stringify({args,pid:process.pid})+'\\n');
const file=root+'/'+id+'.json';if(args.includes('--resume')&&!existsSync(file))process.exit(1);
const history=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[],decl=JSON.parse(get('--mcp-config')).mcpServers.oms;
let bridge,response,seq=0;if(decl){bridge=spawn(decl.command,decl.args,{stdio:['pipe','pipe','ignore']});createInterface({input:bridge.stdout}).on('line',line=>{const x=JSON.parse(line);if(x.id===response?.id){const done=response;response=undefined;done.resolve(x.result);}});}
const mcp=()=>new Promise(resolve=>{response={id:++seq,resolve};bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:seq,method:'tools/call',params:{name:'read',arguments:{path:'src/main.ts'}}})+'\\n');});
if(mode==='stubborn')process.on('SIGTERM',()=>{});
const emit=x=>process.stdout.write(JSON.stringify({session_id:id,...x})+'\\n');
const tools=decl?JSON.parse(readFileSync(decl.args[1],'utf8')).map(t=>'mcp__oms__'+t.name):[];
const usage={input_tokens:20,output_tokens:10,cache_read_input_tokens:30,cache_creation_input_tokens:40,cache_creation:{ephemeral_1h_input_tokens:40}};let n=0;
function assistant(block,stop='end_turn'){
 const mid='msg_'+ ++n,u={...usage,output_tokens:mode==='overflow'?128001:10};
 const start={type:'stream_event',event:{type:'message_start',message:{id:mid,model:'claude-haiku-5-5',usage:u}}};emit(start);if(mode==='duplicate-start')emit(start);
 emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:block.type==='text'?{type:'text',text:''}:block}});
 if(block.type==='text')emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:block.text}}});
 emit({type:'assistant',message:{id:mid,model:'claude-haiku-5-5',content:[block],usage:u}});
 emit({type:'stream_event',event:{type:'content_block_stop',index:0}});
 emit({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:stop},usage:u}});
 emit({type:'stream_event',event:{type:'message_stop'}});
}
function receipt(mult){const u={input_tokens:20*mult,output_tokens:10*mult,cache_read_input_tokens:30*mult,cache_creation_input_tokens:40*mult,cache_creation:{ephemeral_1h_input_tokens:40*mult}};
 if(mode==='larger')u.input_tokens++;if(mode==='smaller')u.input_tokens--;
 const x={type:'result',subtype:'success',is_error:false,usage:u,modelUsage:{'claude-haiku-5-5':{provider:'firstParty',contextWindow:1000000,maxOutputTokens:128000},...(mode==='fallback'?{'other':{}}:{})}};emit(x);if(mode==='duplicate-receipt')emit(x);
}
const input=createInterface({input:process.stdin});input.on('line',async line=>{
 const x=JSON.parse(line);if(x.type==='control_request'){emit({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});return;}history.push(x.message.content);writeFileSync(file,JSON.stringify(history));appendFileSync(root+'/input',JSON.stringify(x)+'\\n');
 emit({type:'system',subtype:'init',tools:mode==='builtin'?['Bash']:tools,mcp_servers:[{name:'oms',status:'connected'}]});if(mode==='hang'||mode==='stubborn')return;
 if(JSON.stringify(x.message.content).includes('probe')){assistant({type:'tool_use',id:'call_'+id,name:'mcp__oms__read',input:{path:'src/main.ts'}},'tool_use');const result=await mcp();appendFileSync(root+'/results',JSON.stringify(result)+'\\n');if(mode==='multi'){assistant({type:'tool_use',id:'call_'+id+'_2',name:'mcp__oms__read',input:{path:'src/main.ts'}},'tool_use');const second=await mcp();appendFileSync(root+'/results',JSON.stringify(second)+'\\n');assistant({type:'text',text:JSON.stringify(second)});receipt(3);}else{assistant({type:'text',text:JSON.stringify(result)});receipt(2);}}
 else{assistant({type:'text',text:JSON.stringify(x.message.content).includes('recall')?JSON.stringify(history[0]):'reply'});receipt(1);}
});input.on('close',()=>{bridge?.kill();process.exit(0);});
`,{mode:0o700});
 process.env.PATH=`${directory}:${originalPath}`;
 try{await run(directory);}finally{process.env.PATH=originalPath;rmSync(directory,{recursive:true,force:true});}
}
async function modelAndSession(statePath?:string,onSpawn?:(pid:number,cwd:string)=>void){const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});const native=await createClaudeCodeProvider(runtime,{statePath,onSpawn});await runtime.refresh({allowNetwork:false});const model=runtime.getModel('claude-code','haiku');assert.ok(model);return{model,native,runtime};}

test('environment is scrubbed and API auth cannot become a subscription',async()=>{
 const env=claudeCodeEnvironment({HOME:'/home/user',PATH:'/usr/bin',ANTHROPIC_API_KEY:'never-forward',NODE_OPTIONS:'--require /attacker',CLAUDE_CODE_OAUTH_TOKEN:'never-forward'});
 assert.equal(env.HOME,'/home/user');for(const key of ['ANTHROPIC_API_KEY','NODE_OPTIONS','CLAUDE_CODE_OAUTH_TOKEN'])assert.equal(env[key],undefined);
 await fixture('api-auth',async()=>assert.equal((await inspectClaudeCode()).configured,false));
});
test('native provider exposes Sonnet, Opus and Haiku through installed CLI subscription without inference',async()=>fixture('ok',async directory=>{
 const{native,runtime}=await modelAndSession();try{
 for(const alias of ['sonnet','opus','haiku']){const model=runtime.getModel('claude-code',alias);assert.ok(model);assert.equal(model.api,'claude-code');assert.equal(model.baseUrl,'claude-code://local');assert.match(model.name,/subscription/);}
 assert.equal(existsSync(join(directory,'launch')),false);
 }finally{await native.close();}
}));
test('two user messages use one process, new input only, and partial text deltas',async()=>fixture('ok',async directory=>{
 const{model,native}=await modelAndSession();const transcript=context();try{
 const events=[];const stream=native.stream(model,transcript);for await(const event of stream)events.push(event);const first=await stream.result();assert.equal(first.stopReason,'stop');assert.ok(events.some(e=>e.type==='text_delta'));
 transcript.messages.push(first,{role:'user',content:'recall',timestamp:2});const second=await native.stream(model,transcript).result();assert.match(JSON.stringify(second.content),/FIRST_SECRET/);
 assert.equal(rows(join(directory,'launch')).length,1);assert.equal(rows(join(directory,'input'))[1].message.content,'recall');
 const args=rows(join(directory,'launch'))[0].args;assert.ok(!args.includes('--no-session-persistence'));assert.ok(!args.includes('--max-turns'));
 }finally{await native.close();}
}));
for(const deny of [false,true])test(`ordinary Pi execution sends real MCP ${deny?'denial':'result'} once`,async()=>fixture('ok',async directory=>{
 const{model,native}=await modelAndSession();let executed=0,guarded=0;
 const agent=new Agent({initialState:{systemPrompt:'Use read',model,tools:[{name:'read',label:'Read',description:'Read',parameters:Type.Object({path:Type.String()}),async execute(){executed++;return{content:[{type:'text',text:'ACTUAL_NONCE'}],details:undefined};}}]},streamFn:createClaudeCodeStream(native),beforeToolCall:async({args})=>{guarded++;(args as {path:string}).path='/work/src/main.ts';return deny?{block:true,reason:'POLICY_DENIED'}:undefined;}});
 try{await agent.prompt('probe');assert.equal(guarded,1,JSON.stringify(agent.state.messages));assert.equal(executed,deny?0:1);const result=rows(join(directory,'results'))[0];assert.equal(result.isError,deny);assert.match(JSON.stringify(result.content),deny?/POLICY_DENIED/:/ACTUAL_NONCE/);
 const responses=agent.state.messages.filter(x=>x.role==='assistant');assert.equal(responses.length,2);assert.equal(responses[0]!.usage.totalTokens+responses[1]!.usage.totalTokens,200);assert.equal(rows(join(directory,'input')).length,1);
 }finally{await native.close();}
}));
test('pending tool cannot trigger native inference before continuation admission; restart blocks unsafe replay',async()=>fixture('ok',async directory=>{
 const path=join(directory,'state.json'),{model,native}=await modelAndSession(path);assert.equal((await native.stream(model,context('probe')).result()).stopReason,'toolUse');await native.close();
 const resumed=new ClaudeCodeSession({statePath:path});try{assert.match(resumed.status().detail!,/interrupted native tool/i);assert.match(resumed.status().detail!,/select Claude Code in \/model.*\/clear.*clear the OMS conversation view; task files and verification are retained/);assert.doesNotMatch(resumed.status().detail!,/\/claude/);const response=await resumed.stream(model,context('next')).result();assert.equal(response.stopReason,'error');assert.match(response.errorMessage!,/tools will not be replayed/);assert.match(response.errorMessage!,/\/clear.*clear the OMS conversation view/);assert.doesNotMatch(response.errorMessage!,/\/claude/);assert.equal(rows(join(directory,'launch')).length,1);await resumed.reset();assert.notEqual(resumed.status().sessionId,native.status().sessionId);}finally{await resumed.close();}
}));
test('reopen resumes exact durable identity, reset isolates native history',async()=>fixture('ok',async directory=>{
 const path=join(directory,'state.json'),{model,native}=await modelAndSession(path),transcript=context();const first=await native.stream(model,transcript).result(),id=native.status().sessionId;await native.close();const resumed=new ClaudeCodeSession({statePath:path});try{
 transcript.messages.push(first,{role:'user',content:'recall',timestamp:2});const second=await resumed.stream(model,transcript).result();assert.equal(second.stopReason,'stop');assert.match(JSON.stringify(second.content),/FIRST_SECRET/);assert.equal(resumed.status().sessionId,id);assert.ok(rows(join(directory,'launch'))[1].args.includes('--resume'));
 await resumed.reset();assert.notEqual(resumed.status().sessionId,id);transcript.messages.push(second,{role:'user',content:'fresh',timestamp:3});assert.equal((await resumed.stream(model,transcript).result()).stopReason,'stop');assert.deepEqual(JSON.parse(readFileSync(join(directory,`${resumed.status().sessionId}.json`),'utf8')),['fresh']);
 }finally{await resumed.close();}
}));
for(const mode of ['builtin','fallback','duplicate-start','larger','smaller','overflow'])test(`${mode} fails closed`,async()=>fixture(mode,async()=>{const{model,native}=await modelAndSession();try{const response=await native.stream(model,context()).result();assert.equal(response.stopReason,'error');assert.match(response.errorMessage!,/No API-key fallback/);assert.match(native.status().detail!,/\/clear.*clear the OMS conversation view/);assert.doesNotMatch(native.status().detail!,/\/claude/);}finally{await native.close();}}));
test('cancellation reaps persistent native process and MCP bridge',async()=>fixture('hang',async()=>{const{model,native}=await modelAndSession();const controller=new AbortController(),start=Date.now(),running=native.stream(model,context(),{signal:controller.signal}).result();setTimeout(()=>controller.abort(),150);try{assert.equal((await running).stopReason,'aborted');await native.disconnect();assert.ok(Date.now()-start<3000);assert.notEqual(native.status().state,'ready');}finally{await native.close();}}));

test('duplicate native receipts never double count and poison the thread before another request',async()=>fixture('duplicate-receipt',async()=>{const{model,native}=await modelAndSession();try{const first=await native.stream(model,context()).result();assert.ok(['stop','error'].includes(first.stopReason));await new Promise(resolve=>setTimeout(resolve,30));assert.match(native.status().detail!,/verification|receipt/);const next=context('next');assert.equal((await native.stream(model,next).result()).stopReason,'error');}finally{await native.close();}}));

for(const mode of ['larger','smaller'])test(`aggregate ${mode} than settled handoff stays unknown`,async()=>fixture(mode,async()=>{
 const {model,native}=await modelAndSession();
 const ledger=createBudgetLedger({caps:{tokens:4000000,spendMicroUsd:1000000,wallClockMs:60000},clock:Date.now,persist:()=>{}});
 const stream=createMeteredStream({streamFunction:createClaudeCodeStream(native),ledger,allocate:createDispatchAllocator(),maxOutputTokens:1024,logicalTurnId:()=> 'one-user-turn'});
 const agent=new Agent({initialState:{systemPrompt:'Use read',model,tools:[{name:'read',label:'Read',description:'Read',parameters:Type.Object({path:Type.String()}),async execute(){return{content:[{type:'text',text:'REAL'}],details:undefined};}}]},streamFn:stream});
 try{await agent.prompt('probe');assert.equal(ledger.snapshot().accounting,'unknown');const responses=agent.state.messages.filter(message=>message.role==='assistant');assert.equal(responses.length,2);assert.equal(responses[0]!.stopReason,'toolUse');assert.equal(responses[1]!.stopReason,'error');assert.equal(responses[0]!.usage.totalTokens,100);assert.equal(ledger.reservations().length,2);}finally{await native.close();}
}));
test('insufficient next reservation never releases a pending real tool result',async()=>fixture('ok',async directory=>{
 const {model,native}=await modelAndSession();const ledger=createBudgetLedger({caps:{tokens:1128000,spendMicroUsd:1000000,wallClockMs:60000},clock:Date.now,persist:()=>{}});
 const stream=createMeteredStream({streamFunction:createClaudeCodeStream(native),ledger,allocate:createDispatchAllocator(),maxOutputTokens:1024,logicalTurnId:()=> 'bounded-turn'});
 const agent=new Agent({initialState:{systemPrompt:'Use read',model,tools:[{name:'read',label:'Read',description:'Read',parameters:Type.Object({path:Type.String()}),async execute(){return{content:[{type:'text',text:'REAL'}],details:undefined};}}]},streamFn:stream});
 try{await agent.prompt('probe');assert.equal(ledger.snapshot().accounting,'known');assert.equal(ledger.reservations().length,1);assert.throws(()=>readFileSync(join(directory,'results'),'utf8'));assert.equal(rows(join(directory,'input')).length,1);}finally{await native.close();}
}));
test('native checkpoint cannot be copied into another OMS conversation',async()=>fixture('ok',async directory=>{
 const path=join(directory,'state.json'),{model,native}=await modelAndSession(path);try{await native.stream(model,context()).result();const other=join(directory,'other.json');writeFileSync(other,readFileSync(path),{mode:0o600});assert.throws(()=>new ClaudeCodeSession({statePath:other}),/Invalid native session state/);}finally{await native.close();}
}));

test('successive native tool batches preserve IDs and do not race previous MCP results',async()=>fixture('multi',async directory=>{
 const {model,native}=await modelAndSession();let executed=0;
 const agent=new Agent({initialState:{systemPrompt:'Use read',model,tools:[{name:'read',label:'Read',description:'Read',parameters:Type.Object({path:Type.String()}),async execute(){executed++;return{content:[{type:'text',text:`REAL_${executed}`}],details:undefined};}}]},streamFn:createClaudeCodeStream(native)});
 try{await agent.prompt('probe');assert.equal(executed,2);const results=rows(join(directory,'results'));assert.equal(results.length,2);assert.match(JSON.stringify(results[0]),/REAL_1/);assert.match(JSON.stringify(results[1]),/REAL_2/);const messages=agent.state.messages.filter(message=>message.role==='assistant');assert.equal(messages.length,3);assert.equal(messages[2]!.stopReason,'stop');assert.equal(messages.reduce((sum,message)=>sum+message.usage.totalTokens,0),300);}finally{await native.close();}
}));

test('a missing native session fails exact resume without creating another identity',async()=>fixture('ok',async directory=>{
 const path=join(directory,'state.json'),{model,native}=await modelAndSession(path);await native.stream(model,context()).result();await native.close();
 const state=JSON.parse(readFileSync(path,'utf8'));state.sessionId=randomUUID();writeFileSync(path,JSON.stringify(state),{mode:0o600});const resumed=new ClaudeCodeSession({statePath:path});
 try{const response=await resumed.stream(model,context('recall')).result();assert.equal(response.stopReason,'error');assert.equal(resumed.status().sessionId,state.sessionId);const launches=rows(join(directory,'launch'));assert.equal(launches.length,2);assert.ok(launches[1].args.includes('--resume'));assert.ok(launches[1].args.includes(state.sessionId));}finally{await resumed.close();}
}));

test('cancelled SIGTERM-resistant native process is force-reaped before stream error is returned',async()=>fixture('stubborn',async directory=>{
 const pids:number[]=[];const {model,native}=await modelAndSession(undefined,pid=>pids.push(pid));const controller=new AbortController();let sawNative=false;
 const stream=native.stream(model,context(),{signal:controller.signal});
 const timeout=setTimeout(()=>controller.abort(),2000);
 for await (const event of stream) { if(event.type==='start'){sawNative=true;const waitForBridge=()=>{if(pids.length>=2)controller.abort();else setTimeout(waitForBridge,10).unref();};setTimeout(waitForBridge,50).unref();} }
 clearTimeout(timeout);
 try{assert.ok(sawNative);assert.equal((await stream.result()).stopReason,'aborted');assert.ok(pids.length>=2,'both CLI and MCP were tracked');for(const pid of pids)assert.throws(()=>process.kill(pid,0));const args=rows(join(directory,'launch'))[0].args;const declarations=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.oms.args[1];assert.equal(existsSync(dirname(declarations)),false,'owned IPC directory is removed before returning');assert.notEqual(native.status().state,'ready');}finally{await native.close();}
}));
