import crypto from 'node:crypto';

const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const qq=value=>typeof value==='string'&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value));
const bot=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)&&value!=='primary';
const name=value=>typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=80&&!/[\x00-\x1f\x7f]/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>0;
const states=['pending','awaiting_scan','activating','active','rejected'];
const fields=['id','ownerUserId','ownerQQ','botQQ','name','profileId','status','botId','claimVersion','version','createdAt','updatedAt','reason'];
export function validateBotOnboardingText(text) {
  let data;try{data=JSON.parse(text);}catch{throw fail(503,'机器人申请存储损坏，已停止改写');}
  const bad=()=>{throw fail(503,'机器人申请格式或版本不受支持，已停止改写');};
  if(!exact(data,['version','requests'])||data.version!==1||!Array.isArray(data.requests)||data.requests.length>10000)bad();
  const ids=new Set(),assigned=new Set();
  for(const row of data.requests) {
    if(!exact(row,fields)||!id(row.id)||ids.has(row.id)||!id(row.ownerUserId)||!qq(row.ownerQQ)||!qq(row.botQQ)||!name(row.name)||!id(row.profileId)
      ||!states.includes(row.status)||!(row.botId===null||bot(row.botId))||!(row.claimVersion===null||Number.isSafeInteger(row.claimVersion)&&row.claimVersion>=1)
      ||!Number.isSafeInteger(row.version)||row.version<1||!time(row.createdAt)||!time(row.updatedAt)||row.updatedAt<row.createdAt
      ||!(row.reason===null||typeof row.reason==='string'&&row.reason.length<=200&&!/[\x00-\x1f\x7f]/.test(row.reason))
      ||['awaiting_scan','activating','active'].includes(row.status)&&row.botId===null||row.status==='pending'&&row.botId!==null
      ||row.status==='active'&&row.claimVersion===null)bad();
    ids.add(row.id);
    if(row.botId&&row.status!=='rejected'){if(assigned.has(row.botId))bad();assigned.add(row.botId);}
  }
  return data;
}

/** Applications grant no instance authority. Only an account administrator may
 * associate a prepared worker and then verify its live QQ before activation. */
export function createBotOnboarding({storage,file,service,auth,manager,afterRegistryChange=async()=>{},now=Date.now}={}) {
  if(!storage?.transaction||!storage?.readText||!storage?.writeText||!file||!service?.botOwner||!auth?.list||!manager?.list)throw new Error('机器人申请依赖尚未就绪');
  const locks=new Set();
  function accounts(){const users=auth.list({kind:'token',role:'admin'});if(!Array.isArray(users))throw fail(503,'账号目录暂不可用');return users;}
  function account(userId){const user=accounts().find(row=>row.id===userId&&!row.disabled);if(!user)throw fail(403,'申请账号已失效或停用');return {...user,kind:'session'};}
  function principal(value,admin=false){if(!id(value?.id)||value.kind==='token'||value.disabled)throw fail(403,'需要有效账号登录');
    if(value.kind==='session'&&typeof value.cookieHeader==='string'){const session=auth.authenticate(value.cookieHeader);if(!session||session.id!==value.id||session.sessionHash!==value.sessionHash)throw fail(401,'登录已失效，请重新登录');}
    const current=account(value.id);if(admin){if(current.role!=='admin')throw fail(403,'只有平台管理员能准备或启用机器人');auth.list(value);}
    const result={...current,kind:value.kind,passwordVersion:value.passwordVersion,sessionHash:value.sessionHash};if(typeof value.cookieHeader==='string')Object.defineProperty(result,'cookieHeader',{value:value.cookieHeader});return result;}
  function load(){let raw;try{raw=storage.readText(file);}catch(error){if(error.code!=='ENOENT')throw error;raw=null;}return {raw,data:raw===null?{version:1,requests:[]}:validateBotOnboardingText(raw)};}
  function transaction(run){return storage.transaction(()=>{const {raw,data}=load();const result=run(data);const next=JSON.stringify(data);validateBotOnboardingText(next);if(next!==raw)storage.writeText(file,next,raw);return result;});}
  function rowFor(data,input){if(!id(input.id)||!Number.isSafeInteger(input.version))throw fail(400,'申请标识或版本无效');const row=data.requests.find(row=>row.id===input.id);if(!row)throw fail(404,'申请不存在');if(row.version!==input.version)throw fail(409,'申请状态已更新，请刷新');return row;}
  function eligible(userId,profileId,ownerQQ){const owner=account(userId),overview=service.overview(owner);if(!overview.qqBinding||ownerQQ&&overview.qqBinding.qq!==ownerQQ)throw fail(403,'请先验证绑定本人的QQ');const profile=overview.profiles.find(row=>row.id===profileId&&row.enabled&&row.invalidReason===null);if(!profile)throw fail(400,'需要申请人本人有效的自费配置');return {owner,overview};}
  const safe=row=>({...row});
  transaction(()=>{});
  return {
    list(value){const actor=principal(value);return transaction(data=>{
      const users=actor.role==='admin'?accounts():[];
      const requests=data.requests.filter(row=>actor.role==='admin'||row.ownerUserId===actor.id).map(row=>({...safe(row),...(actor.role==='admin'?{username:users.find(user=>user.id===row.ownerUserId)?.username||'已停用账号'}:{})}));
      const workers=actor.role==='admin'?manager.list().filter(row=>!row.isPrimary&&!row.enabled&&!service.botOwner(row.id)&&!data.requests.some(request=>request.botId===row.id&&request.status!=='rejected')).map(row=>({botId:row.id,name:row.name,qq:String(row.expectedQQ)})):[];
      return {requests,availableWorkers:workers};
    });},
    create(value,input){const actor=principal(value);if(!exact(input,['botQQ','name','profileId'])||!qq(input.botQQ)||!name(input.name)||!id(input.profileId))throw fail(400,'申请仅接受机器人QQ、名称和本人费用配置');const {overview}=eligible(actor.id,input.profileId);
      const existing=manager.list().find(row=>String(row.expectedQQ)===input.botQQ);if(existing&&(existing.isPrimary||service.botOwner(existing.id)))throw fail(409,'此机器人已经接入，不能填写QQ号接管');
      return transaction(data=>{if(data.requests.filter(row=>row.ownerUserId===actor.id&&!['active','rejected'].includes(row.status)).length>=3)throw fail(429,'最多保留三条待处理申请');if(data.requests.some(row=>row.ownerUserId===actor.id&&row.botQQ===input.botQQ&&row.status!=='rejected'))throw fail(409,'已经申请此QQ，请查看现有进度');
        const at=now(),row={id:crypto.randomBytes(16).toString('hex'),ownerUserId:actor.id,ownerQQ:overview.qqBinding.qq,botQQ:input.botQQ,name:input.name,profileId:input.profileId,status:'pending',botId:null,claimVersion:null,version:1,createdAt:at,updatedAt:at,reason:null};data.requests.push(row);return safe(row);});},
    prepare(value,input){principal(value,true);if(!exact(input,['id','botId','version'])||!bot(input.botId))throw fail(400,'准备参数无效');return transaction(data=>{const row=rowFor(data,input);if(row.status!=='pending')throw fail(409,'只有待准备申请可以关联实例');eligible(row.ownerUserId,row.profileId,row.ownerQQ);const worker=manager.list().find(worker=>worker.id===input.botId&&!worker.isPrimary);
        if(!worker||worker.enabled||String(worker.expectedQQ)!==row.botQQ||service.botOwner(worker.id)||data.requests.some(other=>other.id!==row.id&&other.botId===worker.id&&other.status!=='rejected'))throw fail(409,'请选择QQ匹配、未启用且未归属的独立实例');row.botId=worker.id;row.status='awaiting_scan';row.version++;row.updatedAt=now();return safe(row);});},
    reject(value,input){principal(value,true);if(!exact(input,['id','version','reason'])||typeof input.reason!=='string'||input.reason.length>200||/[\x00-\x1f\x7f]/.test(input.reason))throw fail(400,'拒绝参数无效');return transaction(data=>{const row=rowFor(data,input);if(!['pending','awaiting_scan'].includes(row.status)||locks.has(row.id))throw fail(409,'此申请正在接入或已经完成');row.status='rejected';row.reason=input.reason.trim()||'请联系平台管理员确认开通条件';row.version++;row.updatedAt=now();return safe(row);});},
    async activate(value,input){const admin=principal(value,true);if(!exact(input,['id','version']))throw fail(400,'核验参数无效');let request=transaction(data=>safe(rowFor(data,input)));if(!['awaiting_scan','activating'].includes(request.status)||locks.has(request.id))throw fail(409,'申请不处于可核验状态');locks.add(request.id);let claim=null,claimedHere=false,touched=false;
      try {
        eligible(request.ownerUserId,request.profileId,request.ownerQQ);const worker=manager.list().find(row=>row.id===request.botId);
        const priorOwner=service.botOwner(request.botId);
        if(!worker||String(worker.expectedQQ)!==request.botQQ||priorOwner&&(request.status!=='activating'||priorOwner.ownerUserId!==request.ownerUserId||priorOwner.version!==request.claimVersion))throw fail(409,'实例身份或归属已变化');
        if(worker.enabled&&request.status!=='activating')throw fail(409,'实例已经启用，拒绝通过申请认领');
        touched=request.status==='activating';
        const verified=await manager.verify(request.botId);principal(admin,true);
        transaction(data=>{const current=rowFor(data,{id:request.id,version:request.version});const {owner}=eligible(current.ownerUserId,current.profileId,current.ownerQQ);const ownerBefore=service.botOwner(current.botId);
          if(ownerBefore&&(current.status!=='activating'||ownerBefore.ownerUserId!==current.ownerUserId||ownerBefore.version!==current.claimVersion))throw fail(409,'实例已归属其他申请');
          claim=service.claimBot(admin,{...verified,ownerUserId:current.ownerUserId});claimedHere=!ownerBefore;
          if(!ownerBefore)service.setFunding(owner,{botId:current.botId,profileId:current.profileId,version:0});
          current.status='activating';current.claimVersion=claim.version;current.version++;current.updatedAt=now();request=safe(current);
        });
        touched=true;
        const enabled=await manager.update(request.botId,{enabled:true});principal(admin,true);eligible(request.ownerUserId,request.profileId,request.ownerQQ);
        if(String(enabled.expectedQQ)!==request.botQQ||String(enabled.actualQQ)!==request.botQQ||!enabled.enabled)throw fail(409,'实例身份在启用期间发生变化');
        await afterRegistryChange();
        const active=transaction(data=>{principal(admin,true);const current=rowFor(data,{id:request.id,version:request.version});const eligibleOwner=eligible(current.ownerUserId,current.profileId,current.ownerQQ);const owner=service.botOwner(current.botId);if(owner?.ownerUserId!==current.ownerUserId||owner.version!==current.claimVersion)throw fail(409,'实例归属已变化');if(eligibleOwner.overview.ownedBots.find(bot=>bot.botId===current.botId)?.profileId!==current.profileId)throw fail(409,'费用来源已变化');const live=manager.list().find(worker=>worker.id===current.botId);if(!live?.enabled||String(live.expectedQQ)!==current.botQQ||String(live.actualQQ)!==current.botQQ)throw fail(409,'实例身份已变化');current.status='active';current.reason=null;current.version++;current.updatedAt=now();return safe(current);});
        return active;
      } catch(error) {
        let cleanupFailed=false;
        const currentOwner=service.botOwner(request.botId),sameClaim=currentOwner&&currentOwner.ownerUserId===request.ownerUserId&&currentOwner.version===(claim?.version??request.claimVersion);
        if(touched&&(!currentOwner||sameClaim))try{await manager.update(request.botId,{enabled:false});}catch{cleanupFailed=true;}
        let released=false;if(claimedHere&&claim&&sameClaim)try{service.releaseBotClaim({botId:request.botId,ownerUserId:request.ownerUserId,version:claim.version});released=true;}catch{cleanupFailed=true;}
        if(currentOwner&&!sameClaim)try{transaction(data=>{const row=data.requests.find(row=>row.id===request.id);if(row?.status==='activating'&&row.version===request.version){row.status='rejected';row.reason='实例归属已由平台变更，请联系管理员确认';row.version++;row.updatedAt=now();}});}catch{cleanupFailed=true;}
        if(released)try{transaction(data=>{const row=data.requests.find(row=>row.id===request.id);if(row&&row.status==='activating'&&row.version===request.version){row.status='awaiting_scan';row.claimVersion=null;row.version++;row.updatedAt=now();}});}catch{cleanupFailed=true;}
        if(cleanupFailed)throw fail(503,'核验未完成，实例已暂停；平台管理员需要检查申请后重试');throw fail(error.statusCode||409,'尚未完成本人QQ扫码或实例核验，请平台管理员检查后重试');
      } finally {locks.delete(request.id);}
    },
  };
}
