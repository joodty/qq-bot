#!/usr/bin/env node
// A separately installed, private Linux broker. Never import this into Bridge.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { findQQLoginWindow, loginWindowPng } from '../src/qq-login-frame.js';
import { createBotInstance } from './create-bot-instance.mjs';

const execFile = promisify(callbackExecFile), fail = code => Object.assign(Error(code), { code });
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const requestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const qq = value => typeof value === 'string' && /^[1-9]\d{4,9}$/.test(value) && Number(value) <= 4294967295;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

export function validateHostedLoginConfig(config) {
  const paths = ['root','codeRoot','dockerBin','dockerSocket','image','startScript','nodeBin','dshBin','dshModules','slirpBin','slirpLib','setprivBin','nsenterBin','ipBin'];
  if (!config || !paths.every(k => typeof config[k] === 'string' && config[k]) || !paths.filter(k=>k!=='image').every(k=>path.isAbsolute(config[k]))
      || !/^\S+@sha256:[a-f0-9]{64}$/.test(config.image) || !/^[A-Za-z0-9_-]{32,128}$/.test(config.token || '')
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !Number.isInteger(config.basePort) || config.basePort < 10000 || config.basePort > 64000
      || !Number.isInteger(config.maxBots) || config.maxBots < 1 || config.maxBots > 16 || config.basePort + config.maxBots * 10 > 65535
      || !Number.isInteger(config.uidBase) || config.uidBase < 1000 || config.uidBase>2147473647 || !Number.isInteger(config.gidBase) || config.gidBase < 1000 || config.gidBase>2147473647) throw Error('Invalid hosted login service configuration');
  if (path.resolve(config.root) === path.resolve(config.codeRoot) || path.resolve(config.root).startsWith(path.resolve(config.codeRoot) + path.sep)) throw Error('Hosted data must be separate from application code');
  return config;
}

export function createHostedLoginService(config, { fetchImpl = fetch, now = Date.now } = {}) {
  validateHostedLoginConfig(config);
  const root=path.resolve(config.root), registry=path.join(root,'slots.json'), runtime=path.join(root,'network');
  fs.mkdirSync(root,{recursive:true,mode:0o711});fs.chmodSync(root,0o711);fs.mkdirSync(runtime,{mode:0o700,recursive:true});
  let state;
  try { state=JSON.parse(fs.readFileSync(registry,'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw Error('Hosted slot registry unreadable');state={version:1,rows:[]}; }
  if(state.version!==1||!Array.isArray(state.rows)||state.rows.length>10000||new Set(state.rows.map(r=>r.requestId)).size!==state.rows.length
      || state.rows.some(r=>!requestId(r.requestId)||r.botId!=='hosted-'+r.requestId||!qq(r.botQQ)||!qq(r.ownerQQ)||!Number.isInteger(r.slot)||r.slot<0||r.slot>=config.maxBots||!['waiting','connected','stopped','mismatch'].includes(r.status)||!/^[A-Za-z0-9_-]{32,128}$/.test(r.machineToken)||!/^[A-Za-z0-9_-]{32,128}$/.test(r.onebotToken)||!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.qrAt))) throw Error('Hosted slot registry invalid');
  // Never recycle an OS identity when a pool slot is reused by another account.
  for(const [index,row] of state.rows.entries())if(row.identityIndex===undefined)row.identityIndex=index;
  if(state.rows.some(row=>!Number.isInteger(row.identityIndex)||row.identityIndex<0||row.identityIndex>=10000)||new Set(state.rows.map(r=>r.identityIndex)).size!==state.rows.length)throw Error('Hosted OS identities invalid');
  const locks=new Set(),children=new Map(),cache=new Map(),bootTimers=new Map();let creating=false;
  const dockerArgs=['--host','unix://'+config.dockerSocket];
  const docker=(args,options={})=>execFile(config.dockerBin,[...dockerArgs,...args],{timeout:15000,maxBuffer:12*1024*1024,...options});
  const directory=row=>path.join(root,row.requestId), name=row=>'qqhost-'+row.requestId;
  const port=(row,offset)=>config.basePort+row.slot*10+offset;
  const uid=row=>config.uidBase+row.identityIndex,gid=row=>config.gidBase+row.identityIndex;
  function save(){const temp=registry+'.new';fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,registry);}
  function owned(row,input){if(input.botId!==row.botId||input.botQQ!==row.botQQ)throw fail('CONFLICT');}
  function rowFor(input){const row=state.rows.find(r=>r.requestId===input.requestId);if(!row)throw fail('MISSING');owned(row,input);return row;}
  async function info(row){
    try{const {stdout}=await docker(['inspect',name(row)]);const value=JSON.parse(stdout)[0];
      if(value.Name!=='/'+name(row)||value.Config?.Labels?.['qq-bot.request']!==row.requestId||value.HostConfig?.NetworkMode!=='none')throw fail('CONFLICT');return value;
    }catch(error){if(error.code==='CONFLICT')throw error;return null;}
  }
  function track(row,kind,child){const key=row.requestId+':'+kind;children.set(key,child);child.once('exit',()=>{if(children.get(key)===child)children.delete(key);if(kind!=='network'&&child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}});child.on('error',()=>{});return child;}
  async function privateNetwork(row,container){
    const socket=path.join(runtime,row.requestId+'.sock');
    async function command(value){return new Promise((resolve,reject)=>{let body='';const c=net.connect(socket);c.setTimeout(3000,()=>c.destroy(Error('Network helper timeout')));c.on('connect',()=>c.end(JSON.stringify(value)));c.on('data',b=>body+=b);c.on('error',reject);c.on('end',()=>{try{const result=JSON.parse(body);if(!Object.hasOwn(result,'return'))throw Error();resolve(result.return);}catch{reject(Error('Network helper rejected command'));}});});}
    try{const rows=await command({execute:'list_hostfwd'});if(rows.entries?.some(r=>r.host_port===port(row,0)))return;}catch{}
    if(fs.existsSync(socket))fs.unlinkSync(socket);
    // Only the namespace obtained from this labelled container is entered.
    await execFile(config.nsenterBin,['--target',String(container.State.Pid),'--net',config.ipBin,'link','delete','tap0'],{timeout:3000}).catch(()=>{});
    const log=fs.openSync(path.join(directory(row),'network.log'),'a',0o600);
    const child=track(row,'network',spawn(config.slirpBin,['--configure','--mtu=1500','--disable-host-loopback','--enable-seccomp','--api-socket',socket,String(container.State.Pid),'tap0'],{
      env:{PATH:'/usr/bin:/bin',LD_LIBRARY_PATH:config.slirpLib},stdio:['ignore',log,log]}));fs.closeSync(log);
    for(let n=0;n<40&&!fs.existsSync(socket);n++){if(child.exitCode!==null)throw fail('BUSY');await pause(100);}
    if(!fs.existsSync(socket))throw fail('BUSY');
    for(const [offset,guest]of [[0,3000],[1,3001]])await command({execute:'add_hostfwd',arguments:{proto:'tcp',host_addr:'127.0.0.1',host_port:port(row,offset),guest_port:guest}});
    await docker(['exec',name(row),'sh','-c','printf "nameserver 10.0.2.3\\n" > /etc/resolv.conf']);
  }
  function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});}
  function setupWorker(row){
    const home=path.join(directory(row),'worker');if(fs.existsSync(home))return;
    createBotInstance({botId:row.botId,expectedQQ:row.botQQ,runtimeRoot:home,codeRoot:config.codeRoot,consolePort:port(row,2),snowlumaHttpUrl:'http://127.0.0.1:'+port(row,0),snowlumaWsUrl:'ws://127.0.0.1:'+port(row,1),snowlumaHome:path.join(directory(row),'snowluma'),dshBaseUrl:'http://127.0.0.1:'+port(row,3),dshHome:path.join(home,'dsh-home')});
    const file=path.join(home,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));cfg.consoleToken=row.machineToken;cfg.snowluma.accessToken=row.onebotToken;cfg.ownerQQ=row.ownerQQ;cfg.allow.private=[row.ownerQQ];cfg.storage={driver:'sqlite'};write(file,cfg);
    const profile=path.join(home,'dsh-home/profiles/web');fs.mkdirSync(profile,{recursive:true,mode:0o700});
    fs.symlinkSync(config.dshModules,path.join(home,'dsh-home/node_modules'));
    fs.mkdirSync(path.join(profile,'node_modules'),{recursive:true});
    for(const bundle of ['qq-mode-console','qq-agent-presets'])fs.symlinkSync(path.join(config.codeRoot,'plugins',bundle),path.join(profile,'node_modules',bundle));
    write(path.join(profile,'cordis.yml'),'[]\n');
    write(path.join(profile,'package.json'),{name:'hosted-bot-profile',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','qq-mode-console','qq-agent-presets']}}});
    const q=value=>JSON.stringify(value);
    let patch='';for(const [server,target]of [['snowluma','snowluma'],['snowluma-host','snowluma-host'],['web-search-safe','web-search-safe']])patch+='- insert:\n    - id: mcp-'+server+'\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: '+server+'\n        transport: stdio\n        command: '+q(config.nodeBin)+'\n        args: ['+q(path.join(config.codeRoot,'scripts/run-bot-instance.mjs'))+', '+q(home)+', '+q(target)+']\n        toolCallTimeoutMs: 725000\n';
    write(path.join(profile,'cordis.patch.yml'),patch);
    fs.mkdirSync(path.join(home,'chat-workspace'),{mode:0o700});
    function change(p){const stat=fs.lstatSync(p);if(stat.isSymbolicLink())return;fs.chownSync(p,uid(row),gid(row));if(stat.isDirectory())for(const child of fs.readdirSync(p))change(path.join(p,child));}
    // No primary accounts, keys, QQ data, DSH home or role files are copied.
    change(home);
  }
  async function startContainer(row){
    const base=directory(row);fs.mkdirSync(base,{recursive:true,mode:0o711});fs.chmodSync(base,0o711);
    for(const dir of ['qq-config','qq-local','snowluma/config'])fs.mkdirSync(path.join(base,dir),{recursive:true,mode:0o700});
    const adapter=(type,port)=>({name:type+'-default',host:'0.0.0.0',port,path:'/',accessToken:row.onebotToken,messageFormat:'array',reportSelfMessage:false,...(type==='ws'?{role:'Universal'}:{})});
    const onebot=path.join(base,'snowluma/config/onebot.json');if(!fs.existsSync(onebot))write(onebot,{networks:{httpServers:[adapter('http',3000)],wsServers:[adapter('ws',3001)],httpClients:[],wsClients:[]}});
    setupWorker(row);let container=await info(row);
    if(!container){await docker(['run','-d','--name',name(row),'--label','qq-bot.request='+row.requestId,'--network','none','--cap-add','SYS_PTRACE','--security-opt','seccomp=unconfined','--memory','640m','--memory-swap','896m','--shm-size','256m','--cpus','0.8','--pids-limit','256','--ulimit','nofile=65536:65536','--log-opt','max-size=8m','--log-opt','max-file=2','-e','SNOWLUMA_ONEBOT_HOST=0.0.0.0','-e','SNOWLUMA_WEBUI_HOST=0.0.0.0','-e','SNOWLUMA_SCREEN=1024x768x24','-v',path.join(base,'qq-config')+':/app/.config','-v',path.join(base,'qq-local')+':/app/.local/share','-v',path.join(base,'snowluma')+':/app/data','-v',config.startScript+':/root/start.sh:ro',config.image],{timeout:45000});container=await info(row);}
    else if(!container.State.Running){await docker(['start',name(row)],{timeout:25000});container=await info(row);}
    if(!container?.State.Running)throw fail('BUSY');await privateNetwork(row,container);startProcesses(row);
  }
  async function gateway(row,action){
    try{const response=await fetchImpl('http://127.0.0.1:'+port(row,0)+'/'+action,{method:'POST',headers:{authorization:'Bearer '+row.onebotToken,'content-type':'application/json'},body:'{}',redirect:'manual',signal:AbortSignal.timeout(2500)});if(!response.ok)return null;const result=await response.json();return result.status==='ok'?result.data:null;}catch{return null;}
  }
  function startProcesses(row){
    if(['stopped','mismatch'].includes(row.status))return;
    const home=path.join(directory(row),'worker'),env={PATH:path.dirname(config.nodeBin)+':/usr/bin:/bin',NODE_OPTIONS:'--max-old-space-size=128',TZ:'Asia/Shanghai',HOME:home,DSH_HOME:path.join(home,'dsh-home'),QQ_BRIDGE_RUNTIME_ROOT:home,QQ_BRIDGE_BOT_ID:row.botId,QQ_BRIDGE_EXPECTED_QQ:row.botQQ,SNOWLUMA_HOME:path.join(directory(row),'snowluma')};
    for(const [kind,args]of [['dsh',[config.dshBin,'web','--host','127.0.0.1','--port',String(port(row,3)),'--no-open']],['bridge',[path.join(config.codeRoot,'scripts/run-bot-instance.mjs'),home]]]){
      if(children.has(row.requestId+':'+kind))continue;
      if(kind==='bridge'){
        let credentialReady=false;try{const record=yaml.load(fs.readFileSync(path.join(home,'dsh-home/.credentials.yaml'),'utf8'))?.records?.['client-connection/browser-session'];credentialReady=record?.kind==='grant'&&record.payload?.version===1&&typeof record.payload.secret==='string'&&Buffer.from(record.payload.secret,'base64url').length===32;}catch{}
        if(!credentialReady){if(!bootTimers.has(row.requestId)){const timer=setTimeout(()=>{bootTimers.delete(row.requestId);startProcesses(row);},800);timer.unref();bootTimers.set(row.requestId,timer);}continue;}
      }
      const log=fs.openSync(path.join(directory(row),kind+'.log'),'a',0o600);
      track(row,kind,spawn(config.setprivBin,['--reuid',String(uid(row)),'--regid',String(gid(row)),'--clear-groups','--bounding-set=-all','--no-new-privs',config.nodeBin,...args],{env,cwd:path.join(home,'chat-workspace'),detached:true,stdio:['ignore',log,log]}));fs.closeSync(log);
    }
  }
  async function stop(row){
    if(bootTimers.has(row.requestId)){clearTimeout(bootTimers.get(row.requestId));bootTimers.delete(row.requestId);}
    for(const kind of ['bridge','dsh','network']){const child=children.get(row.requestId+':'+kind);if(child){try{if(kind==='network')child.kill('SIGTERM');else process.kill(-child.pid,'SIGTERM');}catch{}children.delete(row.requestId+':'+kind);}}
    const container=await info(row);if(container?.State.Running)await docker(['stop','--time','8',name(row)],{timeout:15000});cache.delete(row.requestId);
  }
  async function status(row){
    if(row.status==='stopped'||row.status==='mismatch')return {state:row.status};
    const cached=cache.get(row.requestId);if(cached&&now()-cached.at<1800)return cached.value;
    let result={state:'starting'};const login=await gateway(row,'get_login_info');
    if(login&&Number(login.user_id)>0){
      // Stop returning pictures as soon as any account identity appears.
      if(String(login.user_id)!==row.botQQ){row.status='mismatch';save();await stop(row);result={state:'mismatch'};}
      else{
        const live=await gateway(row,'get_status');
        if(live?.online===true){row.status='connected';save();startProcesses(row);}
        result={state:'connecting'};
        if(row.status==='connected')try{
          const response=await fetchImpl('http://127.0.0.1:'+port(row,2)+'/api/instance',{headers:{'x-console-token':row.machineToken},signal:AbortSignal.timeout(2500)});const identity=await response.json();
          if(response.ok&&identity.ok&&identity.botId===row.botId&&identity.expectedQQ===row.botQQ&&String(identity.actualQQ)===row.botQQ&&identity.qqOnline&&identity.dshReady)result={state:'ready'};
        }catch{}
      }
    }else if(now()-row.qrAt>120000)result={state:'expired'};
    else{
      try{
        const {stdout:tree}=await docker(['exec','-e','DISPLAY=:1',name(row),'xwininfo','-root','-tree']);const window=findQQLoginWindow(tree);
        if(window){
          const {stdout:image}=await docker(['exec','-e','DISPLAY=:1',name(row),'xwd','-root','-silent'],{encoding:'buffer'});
          // A second identity read closes the normal login-to-main-window race.
          const after=await gateway(row,'get_login_info');if(!after||!Number(after.user_id))result={state:'waiting_scan',qrImage:'data:image/png;base64,'+loginWindowPng(image,window).toString('base64'),expiresAt:row.qrAt+120000};
        }
      }catch{}
    }
    cache.set(row.requestId,{at:now(),value:result});return result;
  }
  async function refresh(row){
    const login=await gateway(row,'get_login_info');if(login&&Number(login.user_id)>0)return status(row);
    if(!['waiting','connected'].includes(row.status))return status(row);
    const {stdout:tree}=await docker(['exec','-e','DISPLAY=:1',name(row),'xwininfo','-root','-tree']);const window=findQQLoginWindow(tree);if(!window)throw fail('BUSY');
    // A fixed action inside the verified login window; no general mouse/keyboard API.
    const program="import ctypes,time; x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6'); x.XOpenDisplay.restype=ctypes.c_void_p; d=x.XOpenDisplay(None); assert d; x.XDefaultRootWindow.argtypes=[ctypes.c_void_p]; x.XDefaultRootWindow.restype=ctypes.c_ulong; r=x.XDefaultRootWindow(d); x.XWarpPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint,ctypes.c_int,ctypes.c_int]; t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]; x.XFlush.argtypes=[ctypes.c_void_p]; "+[ [.75,.60],[.5,.61] ].map(([rx,ry])=>"x.XWarpPointer(d,0,r,0,0,0,0,"+Math.round(window.x+window.width*rx)+","+Math.round(window.y+window.height*ry)+"); t.XTestFakeButtonEvent(d,1,1,0); t.XTestFakeButtonEvent(d,1,0,0); x.XFlush(d); time.sleep(.3)").join('; ');
    await docker(['exec','-e','DISPLAY=:1',name(row),'python3','-c',program]);row.qrAt=now();save();cache.delete(row.requestId);await pause(500);return status(row);
  }
  async function operation(action,input){
    if(!requestId(input?.requestId))throw fail('INVALID');
    const fields=action==='start'?['requestId','botQQ','name','ownerQQ']:['requestId','botId','botQQ'];
    if(!exact(input,fields)||!qq(input.botQQ)||action==='start'&&(!qq(input.ownerQQ)||typeof input.name!=='string'||!input.name.trim()||input.name.length>80))throw fail('INVALID');
    if(locks.has(input.requestId))throw fail('BUSY');locks.add(input.requestId);
    try{
      let row=state.rows.find(r=>r.requestId===input.requestId);
      if(action==='start'){
        if(row&&(row.botQQ!==input.botQQ||row.ownerQQ!==input.ownerQQ))throw fail('CONFLICT');
        if(row?.status==='mismatch')throw fail('CONFLICT');
        if(creating)throw fail('BUSY');creating=true;
        try{
          if(!row||row.status==='stopped'){
            if(state.rows.some(r=>r.requestId!==input.requestId&&r.botQQ===input.botQQ&&!['stopped','mismatch'].includes(r.status)))throw fail('CONFLICT');
            const used=new Set(state.rows.filter(r=>!['stopped','mismatch'].includes(r.status)&&r.requestId!==input.requestId).map(r=>r.slot));let slot=0;while(used.has(slot))slot++;if(slot>=config.maxBots)throw fail('CAPACITY');
            const available=Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo','utf8'))?.[1]);if(!available||available<450000)throw fail('RESOURCE');
            if(!row){
              if(state.rows.some(r=>r.ownerQQ===input.ownerQQ&&now()-(r.startedAt||r.createdAt)<30000))throw fail('BUSY');
              let identityIndex=state.rows.reduce((last,r)=>Math.max(last,r.identityIndex),-1)+1;
              const users=new Set(fs.readFileSync('/etc/passwd','utf8').split('\n').map(line=>Number(line.split(':')[2]))),groups=new Set(fs.readFileSync('/etc/group','utf8').split('\n').map(line=>Number(line.split(':')[2])));
              while(users.has(config.uidBase+identityIndex)||groups.has(config.gidBase+identityIndex))identityIndex++;
              if(state.rows.length>=10000||identityIndex>=10000)throw fail('CAPACITY');row={requestId:input.requestId,botId:'hosted-'+input.requestId,botQQ:input.botQQ,ownerQQ:input.ownerQQ,slot,identityIndex,status:'waiting',machineToken:crypto.randomBytes(32).toString('base64url'),onebotToken:crypto.randomBytes(32).toString('base64url'),createdAt:now(),startedAt:now(),qrAt:now()};state.rows.push(row);
            }
            else if(row.slot!==slot&&fs.existsSync(path.join(directory(row),'worker')))throw fail('CAPACITY');else{row.slot=slot;row.status='waiting';row.startedAt=now();row.qrAt=now();}
            save();
          }
          await startContainer(row);
          if(row.status==='connected'){row.qrAt=now();save();}
        }finally{creating=false;}
        return {ok:true,connection:{id:row.botId,expectedQQ:row.botQQ,port:port(row,2),machineToken:row.machineToken},login:{state:'starting'}};
      }
      row=rowFor(input);
      if(action==='cancel'){if(row.status==='connected'||row.status==='waiting'&&Number((await gateway(row,'get_login_info'))?.user_id)>0)throw fail('CONFLICT');await stop(row);row.status='stopped';save();return {ok:true,login:{state:'stopped'}};}
      if(action==='refresh')return {ok:true,login:await refresh(row)};
      if(action==='status')return {ok:true,login:await status(row)};
      throw fail('INVALID');
    }finally{locks.delete(input.requestId);}
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('content-type','application/json');
    const send=(code,value)=>{res.writeHead(code);res.end(JSON.stringify(value));};
    const supplied=Buffer.from(String(req.headers['x-login-service-token']||'')),expected=Buffer.from(config.token);
    if(req.method!=='POST'||!/^\/internal\/login\/(start|status|refresh|cancel)$/.test(req.url||'')||['cookie','origin','sec-fetch-site','sec-fetch-dest'].some(h=>req.headers[h]!==undefined)||supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){send(403,{ok:false,code:'DENIED'});return;}
    try{let bytes=0,body='';for await(const part of req){bytes+=part.length;if(bytes>4096)throw fail('INVALID');body+=part;}const input=JSON.parse(body);send(200,await operation(req.url.split('/').at(-1),input));}
    catch(error){const codes={INVALID:400,CONFLICT:409,CAPACITY:429,RESOURCE:503,MISSING:404,BUSY:503};if(!Object.hasOwn(codes,error.code))console.error('Hosted login internal error:',String(error.stack||error.message).replaceAll(config.token,'[hidden]').slice(0,1600));send(codes[error.code]||503,{ok:false,code:Object.hasOwn(codes,error.code)?error.code:'BUSY'});}
  });
  server.requestTimeout=60000;server.headersTimeout=10000;
  const janitor=setInterval(async()=>{for(const row of state.rows){if(row.status!=='waiting'||now()-(row.startedAt||row.createdAt)<10*60*1000||locks.has(row.requestId))continue;locks.add(row.requestId);try{const login=await gateway(row,'get_login_info');if(!Number(login?.user_id)){await stop(row);row.status='stopped';save();}}catch{}finally{locks.delete(row.requestId);}}},30000);janitor.unref();
  server.once('close',()=>clearInterval(janitor));
  // Resume only previously confirmed login environments after a broker/host restart.
  setImmediate(async()=>{for(const row of state.rows.filter(r=>r.status==='connected')){try{await operation('start',{requestId:row.requestId,botQQ:row.botQQ,ownerQQ:row.ownerQQ,name:row.botId});}catch{console.error('Hosted QQ resume pending:',row.botId);}}});
  return {server,operation};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  createHostedLoginService(config).server.listen(config.port,'127.0.0.1',()=>console.log('Private hosted QQ login service ready'));
}
