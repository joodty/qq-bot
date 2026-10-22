// Check actual staged bytes or one outgoing branch's complete reachable history.
// Does not skip main source or tests; findings contain locations, never secrets.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ownRoot=fileURLToPath(new URL('..',import.meta.url));
const dummy=value=>/(?:fixture|example|dummy|placeholder|for-testing|test[-_])/i.test(value)||new Set(value).size<5;
const credential=/(?:(?:^|[{,])\s*["']?(?:api[_-]?key|access[_-]?token|machineToken|consoleToken|password|passwd|secret)["']?\s*:\s*|(?<![\w-])(?:api[_-]?key|access[_-]?token|machineToken|consoleToken|password|passwd|secret)\s*=\s*)(["'])([A-Za-z0-9_./+=-]{16,})\1/gim;
const token=/\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/g;
const forbidden=name=>/(?:^|\/)(?:\.local|\.tools|node_modules|state|audio|backups)(?:\/|$)/i.test(name)
 ||/(?:^|\/)(?:config\.json|\.env(?:\..*)?|credentials(?:\..*)?)$/i.test(name)
 ||/\.(?:sqlite3?|db)(?:-(?:wal|shm))?$|\.(?:pem|key|p12|pfx|dpapi|bundle|log|bak)(?:$|[-.])/i.test(name);
export function inspectPublicFile(name,bytes,{terms=[]}={}) {
 const findings=[],add=(rule,index=0)=>findings.push({file:name,rule,line:bytes.subarray(0,index).toString('utf8').split('\n').length});
 if(forbidden(name))add('private-runtime-file');
 if(bytes.includes(0))return findings;
 const text=bytes.toString('utf8');
 for(const term of terms)if(typeof term==='string'&&term.length>=4){const index=text.toLowerCase().indexOf(term.toLowerCase());if(index>=0)add('local-private-identifier',Buffer.byteLength(text.slice(0,index)));}
 for(const match of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g))add('private-key',Buffer.byteLength(text.slice(0,match.index)));
 for(const match of text.matchAll(token))if(!dummy(match[0]))add('provider-credential',Buffer.byteLength(text.slice(0,match.index)));
 for(const match of text.matchAll(credential))if(!dummy(match[2]))add('literal-credential',Buffer.byteLength(text.slice(0,match.index)));
 for(const match of text.matchAll(/https?:\/\/([^\s/:@]+):([^\s/@]+)@/g)){
  const example=['user','username','u'].includes(match[1])&&['pass','password','p'].includes(match[2]);
  const loopbackAuthority=match[1]==='127.0.0.1'&&/^\d{1,5}$/.test(match[2]); // URL-confusion rejection fixture, not a remote credential.
  if(!example&&!loopbackAuthority)add('credential-url',Buffer.byteLength(text.slice(0,match.index)));
 }
 for(const match of text.matchAll(/\b[A-Za-z]:[\\/]+Users[\\/]+([a-zA-Z0-9_.-]+)/g))if(!['someone','somebody','x','user','username','your-user','public'].includes(match[1].toLowerCase()))add('personal-machine-path',Buffer.byteLength(text.slice(0,match.index)));
 for(const match of text.matchAll(/\b(?:ssh\s+(?:-[^\s]+\s+)*|root@)(?:[a-z0-9_-]+@)?((?:\d{1,3}\.){3}\d{1,3})/gi))if(!/^(?:127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(match[1]))add('server-connection',Buffer.byteLength(text.slice(0,match.index)));
 return findings;
}
export function checkPublication({root=ownRoot,ref,staged=false}={}) {
 if(ref&&staged)throw new Error('Choose staged bytes or a branch history, not both');
 const git=(args,input)=>execFileSync('git',args,{cwd:root,input,maxBuffer:128*1024*1024,stdio:['pipe','pipe','pipe']});
 let terms=[];const privateFile=path.join(root,'.local','publish-deny.json');
 if(fs.existsSync(privateFile)){const data=JSON.parse(fs.readFileSync(privateFile,'utf8'));if(!Array.isArray(data.terms)||data.terms.some(term=>typeof term!=='string'||term.length<4))throw new Error('Invalid local publication denylist');terms=data.terms;}
 const findings=[],objects=new Map();let files=0,commits=0;
 const collect=tree=>{for(const entry of tree.toString('utf8').split('\0').filter(Boolean)){const tab=entry.indexOf('\t');const [mode,type,oid]=entry.slice(0,tab).split(' '),name=entry.slice(tab+1);files++;if(mode==='120000'){findings.push({file:name,rule:'symlink',line:1});continue;}if(type!=='blob')throw new Error('Unexpected Git tree entry');if(forbidden(name))findings.push({file:name,rule:'private-runtime-file',line:1});if(!objects.has(oid))objects.set(oid,name);}};
 if(ref){
  const oid=git(['rev-parse','--verify','--end-of-options',ref+'^{commit}']).toString('utf8').trim();
  const history=git(['rev-list',oid]).toString('utf8').trim().split('\n');commits=history.length;
  for(const commit of history)collect(git(['ls-tree','-r','-z',commit]));
 }else if(staged){
  const entries=git(['ls-files','--stage','-z']).toString('utf8').split('\0').filter(Boolean);
  for(const entry of entries){const tab=entry.indexOf('\t'),[mode,oid,stage]=entry.slice(0,tab).split(' ');if(stage!=='0')throw new Error('Resolve merge conflicts before publication');collect(Buffer.from(mode+' blob '+oid+'\t'+entry.slice(tab+1)+'\0'));}
 }else{
  const names=git(['ls-files','--cached','--others','--exclude-standard','-z']).toString('utf8').split('\0').filter(Boolean);
  for(const name of new Set(names)){const file=path.join(root,name);let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}files++;if(stat.isSymbolicLink()){findings.push({file:name,rule:'symlink',line:1});continue;}if(stat.isFile())findings.push(...inspectPublicFile(name,fs.readFileSync(file),{terms}));}
 }
 if(objects.size){const ids=[...objects.keys()],output=git(['cat-file','--batch'],ids.join('\n')+'\n');let cursor=0;for(const oid of ids){const end=output.indexOf(10,cursor);if(end<0)throw new Error('Truncated Git object header');const [actual,type,sizeText]=output.subarray(cursor,end).toString('ascii').split(' '),size=Number(sizeText);if(actual!==oid||type!=='blob'||!Number.isSafeInteger(size)||size<0)throw new Error('Unexpected Git object');const start=end+1,stop=start+size;if(stop>=output.length||output[stop]!==10)throw new Error('Truncated Git object body');findings.push(...inspectPublicFile(objects.get(oid),output.subarray(start,stop),{terms}));cursor=stop+1;}}
 return {ok:findings.length===0,mode:ref?'reachable-history':staged?'staged':'worktree',files,commits,blobs:objects.size,findings};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);let ref,staged=false;for(let i=0;i<args.length;i++){if(args[i]==='--ref'){ref=args[++i];if(!ref)throw new Error('Missing --ref value');}else if(args[i]==='--staged')staged=true;else throw new Error('Unknown option');}const result=checkPublication({ref,staged});console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}catch(error){console.error('Publication check failed: '+(error.stderr?'Git inspection failed':error.message));process.exitCode=2;}
}
