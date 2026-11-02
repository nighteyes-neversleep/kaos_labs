/** Real container/API/persistence checks. No model API is called. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
const root=dirname(fileURLToPath(import.meta.url)),prefix=await fs.mkdtemp(join(tmpdir(),'omi-selfhost-test-'));
await fs.chmod(prefix,0o700);
const instance=createHash('sha256').update(prefix).digest('hex').slice(0,16),volume='omi-data-'+instance;
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const env={...process.env,OMI_SELFHOST_IMAGE:process.env.OMI_SELFHOST_IMAGE||'omi-selfhost:local'};
const run=(action,...args)=>execFileSync('bash',[join(root,'omi.sh'),action,'--prefix',prefix,'--port',String(port),...args],{env,encoding:'utf8',timeout:40000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
const base='http://127.0.0.1:'+port,checks=[];
const passed=(name)=>{checks.push(name);console.log('PASS '+name);};
try{
 run('up');const status=run('status');assert(status.includes(String(port)));
 assert.equal((await fetch(base)).status,200);assert.equal((await fetch(base+'/api/forum/v1/identity')).status,401);passed('real client and health endpoint respond; anonymous identity is refused');
 run('credentials');const file=join(prefix,'credentials/kaos-admin.json');const raw=await fs.readFile(file);const owner=JSON.parse(raw);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const api=async(path,method='GET',body,token=owner.token)=>{const response=await fetch(base+'/api/forum/v1'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const identity=await api('/identity');assert.equal(identity.body.participant.id,'kaos');assert.equal(identity.body.participant.role,'admin');passed('private local owner credential authenticates without exposing its value');
 const title='Persistent self-hosted fixture '+randomUUID();const created=await api('/topics','POST',{title,body:'Synthetic persistence evidence, no model invoked.',clientMessageId:randomUUID()});assert.equal(created.status,201);
 run('member','--id','fixture-agent');const member=JSON.parse(await fs.readFile(join(prefix,'credentials/fixture-agent.json')));assert.equal((await api('/identity','GET',undefined,member.token)).body.participant.id,'fixture-agent');passed('separate participant credential authenticates through the actual API');
 run('down');run('up');const after=await api('/topics');assert.equal(after.status,200);assert(after.body.topics.some(topic=>topic.id===created.body.topic.id&&topic.title===title));assert((await fs.readFile(file)).equals(raw));passed('database, topic and accepted owner credential survive container removal and restart');
 run('backup');const backups=await fs.readdir(join(prefix,'backups'));assert.equal(backups.length,1);const backup=join(prefix,'backups',backups[0]);const db=new DatabaseSync(join(backup,'forum.sqlite'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert(db.prepare('SELECT id FROM topics WHERE id=?').get(created.body.topic.id));}finally{db.close();}
 assert.equal((await fs.stat(join(backup,'kaos-admin.json'))).mode&0o777,0o600);passed('consistent private backup contains a readable database snapshot and owner recovery credential');
 const report={protocol:'omi-selfhost-smoke/1',status:'passed',checks,modelCalls:0,image:env.OMI_SELFHOST_IMAGE,scope:'Real Docker container, local HTTP API, persistent volume and consistent backup; no live external model or user desktop was tested.'};
 await fs.mkdir('/workspace/outputs/omi-selfhost-evidence',{recursive:true,mode:0o700});await fs.writeFile('/workspace/outputs/omi-selfhost-evidence/smoke.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'passed',checks:checks.length,modelCalls:0}));
}finally{
 try{run('down');}catch{}
 execFileSync('docker',['volume','rm',volume],{stdio:'ignore'});
 await fs.rm(prefix,{recursive:true,force:true});
}
