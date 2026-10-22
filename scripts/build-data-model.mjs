// Build public schema documentation from DDL only. Never opens a runtime database.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const source=fs.readFileSync(path.join(root,'src/sqlite-state.js'),'utf8').replace(/\r\n/g,'\n');
function definitions(name) {
  const match=new RegExp('const '+name+' = \\{\\n([\\s\\S]*?)\\n\\};').exec(source);
  if(!match)throw new Error('Missing schema definition '+name);
  return match[1].split('\n').filter(line=>line.trim()).map(line=>{
    const row=/^  ([a-z_]+): (['"])(.*)\2,?$/.exec(line);if(!row)throw new Error('Unsupported DDL literal');
    const sql=row[2]==='"'?JSON.parse('"'+row[3]+'"'):row[3].replace(/\\(['\\])/g,'$1');
    if(!sql.startsWith('CREATE '))throw new Error('Only schema DDL may be documented');
    return {name:row[1],sql};
  });
}
const labels={
 accounts:['账号','identity','登录管理页面的人；权限角色为平台管理员或普通账号。'],
 auth_sessions:['登录会话','identity','浏览器登录的有效期和令牌散列，与 AI 对话会话分开。'],
 account_scopes:['平台会话授权','identity','平台管理员授予账号的 botId + 群或私聊范围。'],
 bots:['机器人连接','identity','工作实例的 QQ 身份、内部连接及启用状态；主机器人目前由配置提供。'],
 tenant_owned_bots:['机器人归属','identity','账号对自有机器人的所有权；所有者管理该机器人的业务。'],
 tenant_profiles:['用户模型配置','identity','用户自己的供应商、模型及加密 API Key；保存 Key 不改变资源权限。'],
 tenant_qq_bindings:['本人 QQ 身份','identity','账号与实际验证过的 QQ 关联，目前一账号对应一个 QQ。'],
 tenant_binding_challenges:['QQ 验证申请','identity','一次码散列、有效期、失败次数及消费时间。'],
 tenant_delegations:['机器人成员授权','identity','所有者将自己机器人的具体群或私聊授权给其他账号。'],
 tenant_funding:['费用来源绑定','budget','选择本人私聊或自有机器人使用的模型配置；平台／试用来源还通过业务规则判断。'],
 tenant_settings:['平台试用规则','budget','试用开关、个人默认日额度、平台试用总日额度及密钥版本指纹。'],
 tenant_trial_overrides:['用户试用覆盖','budget','个别账号的试用额度和开关。'],
 role_cards:['人设正文','persona','原项目角色卡的名称、正文与机器人归属。'],
 member_cards:['用户自建人设','persona','用户所有的人设卡、当前版本及稳定内部名称。'],
 member_revisions:['人设修改历史','persona','每一版本正文、名称、作者和修改时间。'],
 persona_identities:['人设稳定身份','persona','对话存档用的稳定人设 ID，支持改名后保持关联。'],
 conversation_roles:['会话人设选择','persona','按机器人和会话保存单独人设；未设置时由全局人设规则继承。'],
 archive_records:['AI 对话存档','persona','DSH 对话标识、人设、聊天对象及可恢复状态；不保存完整 DSH 聊天正文。'],
 selected_sessions:['当前对话存档','persona','某个机器人中的群或私聊当前选中的对话存档。'],
 budget_settings:['机器人默认预算','budget','人民币默认日额度、默认调用预留及启用状态。'],
 budget_overrides:['会话单独预算','budget','某个群或私聊覆盖机器人默认预算的设置。'],
 budget_reservations:['在途费用预留','budget','调用前占用的额度、请求／回合关联及结算状态。'],
 budget_days:['每日预算高水位','budget','每天已观察到的估算支出；用于准入控制，供应商实际账单另行核对。'],
 state_meta:['存储元信息','storage','管理存储层的元信息。'],
 state_documents:['兼容文档存储','storage','SQLite 中的文档原文、类型、机器人及修订号，与业务查询表在同一事务更新。'],
 role_materializations:['人设文件同步','storage','跟踪数据库正文向兼容 Markdown 文件同步的修订。'],
};
const ddl=definitions('TABLES'),indexes=definitions('INDEXES');
if(ddl.length!==Object.keys(labels).length||ddl.some(row=>!labels[row.name]))throw new Error('Update public table descriptions to match the schema');
const db=new DatabaseSync(':memory:');
try {
  for(const {sql} of [...ddl,...indexes])db.exec(sql);
  const tables=ddl.map(({name,sql})=>{
    const [label,domain,description]=labels[name];
    const foreignKeys=new Map();
    for(const row of db.prepare('PRAGMA foreign_key_list('+name+')').all()){
      if(!foreignKeys.has(row.id))foreignKeys.set(row.id,{target:row.table,from:[],to:[],onDelete:row.on_delete});
      const fk=foreignKeys.get(row.id);fk.from.push(row.from);fk.to.push(row.to);
    }
    return {name,label,domain,description,sql,columns:db.prepare('PRAGMA table_info('+name+')').all().map(c=>({name:c.name,type:c.type,notNull:!!c.notnull,primaryKeyPosition:c.pk,default:c.dflt_value})),
      foreignKeys:[...foreignKeys.values()],indexes:db.prepare('PRAGMA index_list('+name+')').all().map(index=>({name:index.name,unique:!!index.unique,partial:!!index.partial,columns:db.prepare('PRAGMA index_info('+index.name+')').all().map(c=>c.name)}))};
  });
  const data={formatVersion:1,schemaVersion:Number(/const VERSION = (\d+)/.exec(source)[1]),schemaHash:crypto.createHash('sha256').update(JSON.stringify([...ddl,...indexes])).digest('hex'),
    source:'src/sqlite-state.js',tableCount:tables.length,tables,indexes,
    logicalRelations:[
      {parent:'bots',child:'tenant_owned_bots',from:'id',to:'bot_id',cardinality:'1 : 0..1',label:'连接与所有权'},
      {parent:'bots',child:'account_scopes',from:'id',to:'bot_id',cardinality:'1 : 多',label:'机器人范围'},
      {parent:'bots',child:'tenant_delegations',from:'id',to:'bot_id',cardinality:'1 : 多',label:'机器人内授权'},
      {parent:'bots',child:'tenant_funding',from:'id',to:'bot_id',cardinality:'1 : 多',label:'费用来源'},
      {parent:'bots',child:'budget_settings',from:'id',to:'bot_id',cardinality:'1 : 0..1',label:'默认预算'},
      {parent:'accounts',child:'member_cards',from:'id',to:'owner_user_id',cardinality:'1 : 多',label:'人设所有者（跨实例）'},
      {parent:'accounts',child:'member_revisions',from:'id',to:'author_user_id',cardinality:'1 : 多',label:'修改作者（跨实例）'},
      {parent:'role_cards',child:'member_cards',from:'name',to:'internal_role_name',cardinality:'1 : 0..1',label:'正文兼容映射'},
      {parent:'role_cards',child:'persona_identities',from:'name',to:'name',cardinality:'1 : 0..1',label:'存档人设身份'},
      {parent:'role_cards',child:'conversation_roles',from:'name',to:'role_name',cardinality:'1 : 多',label:'按名选择人设'},
    ]};
  const target=path.join(root,'public/data-model-schema.json'),text=JSON.stringify(data,null,2)+'\n';
  if(process.argv.includes('--check')){
    if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==text)throw new Error('Public schema is stale; run npm run build:data-model');
  }else fs.writeFileSync(target,text);
  console.log('Public schema '+(process.argv.includes('--check')?'verified':'built')+': '+tables.length+' tables; no runtime database accessed.');
}finally{db.close();}
