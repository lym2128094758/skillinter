import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from './src/store.mjs';
import {readDocument,readDocumentTool} from './src/document-tools.mjs';
import {runPython} from './src/python-tool.mjs';
import {runProcess} from './src/process-runtime.mjs';
import {createOnlineSkills} from './src/online-skills.mjs';
import {prepareTask,prepareTaskTool} from './src/task-preparation.mjs';
import {executeRun} from './src/runner.mjs';
import {validate} from './src/schema.mjs';
import {createTaskCapabilities,taskCapabilityTools} from './src/task-capabilities.mjs';
import {createGithubAccess} from './src/github-access.mjs';
import {createSkillStudio} from './src/skill-studio.mjs';
import {createSkillRegistry} from './src/skill-registry.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'sih-capability-test-')),projectPath=join(root,'project');await mkdir(projectPath);
  const store=new Store(join(root,'state.sqlite')),project=store.addProject(projectPath,'test'),task=store.createTask(project.id);
  const prompt='数学建模：读取题目后分析数据，保留原始输入。';
  const run=store.begin(task.id,crypto.randomUUID(),prompt,{mode:'api'}).id;
  const signal=new AbortController().signal,scope={mode:'project_write',projectId:project.id,projectPath};
  t.after(async()=>{store.db.close();await rm(root,{recursive:true,force:true});});
  return {root,workspace:projectPath,scope,store,task:task.id,run,prompt,signal,entry:{}};
}
async function python(t){const r=await runProcess('python',['-I','-c','print(1)'],{timeoutMs:5000});if(r.exitCode!==0){t.skip('Python unavailable');return false;}return true;}

test('document reads use real project and attachment boundaries, hashes and extracted ranges',async t=>{
  const f=await fixture(t),bytes='题目\n约束：不得改变原始输入\n数据说明';await writeFile(join(f.workspace,'problem.txt'),bytes);
  const result=await readDocument({path:'problem.txt',offset:1,limit:1},f);
  assert.equal(result.data.text,'约束：不得改变原始输入');assert.equal(result.data.sourceSha256,hash(bytes));assert.equal(result.data.truncated,true);
  assert.deepEqual(validate(readDocumentTool.returns,result),[]);
  assert.equal((await readDocument({path:'../state.sqlite',offset:0,limit:10},f)).error.code,'PATH_OUTSIDE_WORKSPACE');
  assert.equal((await readDocument({path:'problem.txt',offset:-1,limit:10},f)).error.code,'INVALID_ARGUMENT');
  const upload=join(f.root,'attachments');await mkdir(upload);await writeFile(join(upload,'a.material'),bytes);
  const attachment=await readDocument({path:'attachment:a.material',offset:0,limit:10},{...f,workspace:upload,materials:[{path:'attachment:a.material',name:'题目.txt'}]});
  assert.equal(attachment.data.text,bytes);
  await writeFile(join(f.workspace,'binary.dat'),Buffer.from([0,1,2]));
  assert.equal((await readDocument({path:'binary.dat',offset:0,limit:10},f)).error.code,'UNSUPPORTED_FORMAT');
});

test('a truncated document result does not corrupt the normal model reply',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'short.txt'),'first\nsecond\nthird');let calls=0;
  const model={label:'fixture',async invoke(){return ++calls===1?{tool_calls:[{id:'read',type:'function',function:{name:'read_document',arguments:'{"path":"short.txt","offset":0,"limit":1}'}}]}:{content:'只读取第一行，其余未读取。'};}};
  await executeRun({...f,id:f.run,prompt:'读取指定文本片段',model,skillAccess:true,maxSteps:2});
  const run=f.store.task(f.task).runs[0];assert.equal(run.status,'completed');assert.equal(run.answer,'只读取第一行，其余未读取。');
});

test('PDF text is extracted by the actual parser without executing document actions',async t=>{
  const probe=await runProcess('pdftotext',['-v'],{timeoutMs:3000});if(probe.unavailable){t.skip('pdftotext unavailable');return;}
  const f=await fixture(t),objects=[
    '<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const content='BT /F1 12 Tf 50 750 Td (Actual PDF question text) Tj ET';objects.push('<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream');
  let text='%PDF-1.4\n';const offsets=[0];for(const [i,body]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=(i+1)+' 0 obj\n'+body+'\nendobj\n';}
  const xref=Buffer.byteLength(text);text+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  await writeFile(join(f.workspace,'question.pdf'),text);
  const result=await readDocument({path:'question.pdf',offset:0,limit:30},f);assert.equal(result.ok,true);assert.equal(result.data.format,'pdf');assert.match(result.data.text,/Actual PDF question text/);
});

test('DOCX and XLSX extraction preserves paragraphs, tables and coordinates without executing formulas or macros',async t=>{
  if(!await python(t))return;const f=await fixture(t);
  const build="import zipfile; z=zipfile.ZipFile('paper.docx','w'); z.writestr('word/document.xml','<document><p><t>Question alpha</t></p><tbl><tr><p><t>Cell beta</t></p></tr></tbl></document>'); z.close(); z=zipfile.ZipFile('data.xlsx','w'); z.writestr('xl/workbook.xml','<workbook xmlns:r=\"r\"><sheets><sheet name=\"Data\" r:id=\"id1\"/></sheets></workbook>'); z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id=\"id1\" Target=\"worksheets/sheet1.xml\"/></Relationships>'); z.writestr('xl/worksheets/sheet1.xml','<worksheet><sheetData><row><c r=\"A1\" t=\"inlineStr\"><is><t>Value</t></is></c><c r=\"B1\"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>'); z.close()";
  assert.equal((await runProcess('python',['-I','-c',build],{cwd:f.workspace,signal:f.signal,timeoutMs:5000})).exitCode,0);
  const doc=await readDocument({path:'paper.docx',offset:0,limit:20},f);assert.equal(doc.ok,true);assert.match(doc.data.text,/Question alpha\nCell beta/);
  const table=await readDocument({path:'data.xlsx',offset:0,limit:20},f);assert.equal(table.ok,true);assert.match(table.data.text,/\[Sheet: Data\]/);assert.match(table.data.text,/A1=Value\tB1=3/);
});

test('task preparation rejects invented receipts and cycles, creates per-step candidates and preserves the original goal',async t=>{
  const f=await fixture(t),args={objective:'按题目求解',constraints:['保留输入'],deliverables:['分析结果'],assumptions:[],questions:[],source_receipts:[999],
    steps:[{id:'read',title:'审题',depends_on:[],skill_query:'research'},{id:'solve',title:'求解',depends_on:['read'],skill_query:'math'},
      {id:'plot',title:'绘图',depends_on:['solve'],skill_query:'unmatched-visual-query'}]};
  const search=async query=>query==='math'?[{id:'skill-1',label:'求解方法',version:1,executable:true,tool:'load_skill'}]:
    query==='绘图'?[{id:'skill-2',label:'科研绘图',version:1,executable:true,tool:'load_skill'}]:[];
  assert.equal((await prepareTask(args,{...f,search})).error.code,'SOURCE_NOT_READ');
  await writeFile(join(f.workspace,'problem.txt'),'problem');
  const seq=f.store.record(f.run,'tool_result',{name:'read_document',output:{ok:true,data:{path:'problem.txt',sourceSha256:hash('problem')}}});
  args.source_receipts=[seq];args.steps[0].depends_on=['solve'];
  assert.equal((await prepareTask(args,{...f,search})).error.code,'INVALID_PLAN');
  assert.equal(f.store.events(f.run,0).filter(e=>e.type==='task_plan').length,0);
  args.steps[0].depends_on=[];const result=await prepareTask(args,{...f,search});assert.equal(result.ok,true);
  assert.equal(result.data.originalGoal,f.prompt);assert.equal(result.data.steps[0].gap,true);assert.equal(result.data.steps[1].candidates[0].id,'skill-1');
  assert.equal(result.data.steps[2].candidates[0].id,'skill-2');
  assert.deepEqual(validate(prepareTaskTool.returns,result),[]);assert.equal(f.store.task(f.task).runs[0].taskBrief.objective,'按题目求解');
  await writeFile(join(f.workspace,'problem.txt'),'changed');
  assert.equal((await prepareTask(args,{...f,search})).error.code,'SOURCE_CHANGED');
});

test('online discovery pins a real commit and blob hash, reuses results, and only adopts a run-scoped guide',async()=>{
  const text='---\nname: math-test\ndescription: mathematical method\n---\nRead inputs and compare methods.';
  const blob=createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex'),commit='a'.repeat(40),calls=[],events=[];
  const resource='print(1)\n',resourceSha=createHash('sha1').update('blob '+Buffer.byteLength(resource)+'\0').update(resource).digest('hex');
  const fetcher=async url=>{calls.push(url);let body;
    if(url.includes('/search/repositories?'))body={items:[]};
    else if(url.endsWith('/commits/HEAD'))body={sha:commit};
    else if(url.includes('/license?ref='+commit))body={license:{spdx_id:'MIT'},sha:'license'};
    else if(url.includes('/git/trees/'+commit))body={sha:'b'.repeat(40),tree:[{type:'blob',path:'skills/math/SKILL.md',sha:blob,size:Buffer.byteLength(text)}]};
    else if(url.endsWith('/git/blobs/'+blob))body={encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};
    else if(url.includes('/contents/skills/math/scripts/check.py?ref='+commit))body={type:'file',encoding:'base64',sha:resourceSha,size:Buffer.byteLength(resource),content:Buffer.from(resource).toString('base64')};
    else throw Error('Unexpected request');return new Response(JSON.stringify(body));};
  const engine=createOnlineSkills({sources:['owner/repo'],signal:new AbortController().signal,fetcher,emit:(type,payload)=>events.push({type,payload})});
  const first=await engine.execute('discover_skills',{query:'math',limit:2});assert.equal(first.ok,true);assert.equal(first.data.candidates.length,1);
  assert.equal(first.data.candidates[0].commit,commit);assert.equal(first.data.candidates[0].resourcesAvailable,false);
  const n=calls.length;await engine.execute('discover_skills',{query:'math',limit:2});assert.equal(calls.length,n);
  const guide=await engine.execute('adopt_discovered_skill',{id:first.data.candidates[0].id});assert.match(guide.data.instructions,/Read inputs/);
  assert.equal(guide.data.skill.status,'adopted');assert.equal(events.at(-1).type,'external_skill_adopted');
  const loaded=await engine.execute('read_discovered_resource',{id:first.data.candidates[0].id,path:'scripts/check.py'});
  assert.equal(loaded.data.text,resource);assert.equal(loaded.data.sha256,hash(resource));
  assert.equal((await engine.execute('read_discovered_resource',{id:first.data.candidates[0].id,path:'../secret'})).error.code,'SOURCE_NOT_ALLOWED');
  assert.equal((await engine.execute('adopt_discovered_skill',{id:'invented'})).error.code,'SKILL_NOT_FOUND');
  assert(calls.every(url=>url.startsWith('https://api.github.com/repos/owner/repo/') || url.startsWith('https://api.github.com/search/repositories?')));
});

test('online discovery continues past unreadable candidates until it fills the requested results',async()=>{
  const commit='a'.repeat(40),records=Array.from({length:5},(_,i)=>{
    const text=`---\nname: math-${i}\ndescription: math analysis ${i}\nlicense: MIT\n---\nAnalyze the task.`;
    return {text,sha:createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex')};
  });
  const calls=[];
  const fetcher=async url=>{
    calls.push(url);
    if(url.includes('/search/repositories?'))return Response.json({items:[]});
    if(url.endsWith('/commits/HEAD'))return Response.json({sha:commit});
    if(url.includes('/license?'))return Response.json({license:{spdx_id:'MIT'}});
    if(url.includes('/git/trees/'))return Response.json({sha:'b'.repeat(40),tree:records.map((item,i)=>({type:'blob',path:`math-${i}/SKILL.md`,sha:item.sha,size:Buffer.byteLength(item.text)}))});
    const item=records.find(record=>url.endsWith('/git/blobs/'+record.sha));
    if(item===records[0] || item===records[1])return new Response('',{status:404});
    if(item)return Response.json({encoding:'base64',size:Buffer.byteLength(item.text),content:Buffer.from(item.text).toString('base64')});
    throw Error('Unexpected request');
  };
  const engine=createOnlineSkills({sources:['owner/repo'],signal:new AbortController().signal,fetcher});
  const result=await engine.execute('discover_skills',{query:'math',limit:3});
  assert.equal(result.ok,true);
  assert.deepEqual(result.data.candidates.map(item=>item.name),['math-2','math-3','math-4']);
  assert.equal(result.data.unavailable.length,2);
  assert.equal(calls.filter(url=>url.includes('/git/blobs/')).length,5);
  await engine.close();
});

test('slow repository does not prevent a healthy repository from returning usable candidates',async()=>{
  const commit='a'.repeat(40);
  const text='---\nname: data-analysis\ndescription: Data analysis\nlicense: MIT\n---\nAnalyze data.';
  const sha=createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
  const fetcher=async(url,{signal}={})=>{
    if(url.includes('/search/repositories?'))return Response.json({items:[]});
    if(url.includes('/repos/slow/repo/'))return await new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(signal.reason);
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
    if(url.endsWith('/commits/HEAD'))return Response.json({sha:commit});
    if(url.includes('/license?'))return Response.json({license:{spdx_id:'MIT'}});
    if(url.includes('/git/trees/'))return Response.json({sha:'b'.repeat(40),tree:[{type:'blob',path:'data/SKILL.md',sha,size:Buffer.byteLength(text)}]});
    if(url.endsWith('/git/blobs/'+sha))return Response.json({encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')});
    throw Error('Unexpected request');
  };
  const engine=createOnlineSkills({sources:['slow/repo','fast/repo'],signal:new AbortController().signal,fetcher});
  const result=await engine.execute('discover_skills',{query:'data',limit:1});
  assert.equal(result.ok,true);
  assert.equal(result.data.candidates[0].name,'data-analysis');
  assert(result.data.unavailable.includes('slow/repo'));
  await engine.close();
});

test('combined skill search meets each category minimum when possible and allows more results',async t=>{
  const f=await fixture(t),commit='a'.repeat(40),events=[],localLimits=[];
  const records=['math','plot','niche'].flatMap(query=>Array.from({length:query==='niche'?1:5},(_,i)=>{
    const name=`${query}-online-${i}`;
    const text=`---\nname: ${name}\ndescription: Skill for ${query}\nlicense: MIT\n---\nUse the method.`;
    const sha=createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
    return {name,text,sha};
  }));
  const fetcher=async url=>{
    let body;
    if(url.includes('/search/repositories?'))body={items:[]};
    else if(url.endsWith('/commits/HEAD'))body={sha:commit};
    else if(url.includes('/license?'))body={license:{spdx_id:'MIT'}};
    else if(url.includes('/git/trees/'))body={sha:'b'.repeat(40),tree:records.map(({name,text,sha})=>({type:'blob',path:`${name}/SKILL.md`,sha,size:Buffer.byteLength(text)}))};
    else {
      const record=records.find(item=>url.endsWith('/git/blobs/'+item.sha));
      if(!record)throw Error('unexpected request');
      body={encoding:'base64',size:Buffer.byteLength(record.text),content:Buffer.from(record.text).toString('base64')};
    }
    return new Response(JSON.stringify(body));
  };
  const capabilities=createTaskCapabilities({...f,skillSources:['owner/repo'],githubAccess:{fetch:fetcher},
    store:{record:(_run,type,data)=>events.push({type,data})},search:async(query,_signal,limit)=>{
      localLimits.push(limit);
      return Array.from({length:Math.min(query==='niche'?1:5,limit)},(_,i)=>({id:`${query}-local-${i}`,label:`${query}-local-${i}`,version:1,description:query}));
    }});
  t.after(()=>capabilities.close());
  const call=(name,args)=>capabilities.execute({function:{name,arguments:JSON.stringify(args)}});
  for(const [args,kind,count] of [
    [{query:'math',kind:'direct',limit:1},'direct',3],
    [{query:'plot',kind:'supporting',limit:1},'supporting',2],
    [{query:'math',kind:'direct',limit:5},'direct',5],
    [{query:'plot',kind:'supporting',limit:4},'supporting',4],
    [{query:'niche',limit:1},'direct',1],
  ]) {
    const result=await call('search_skill_libraries',args);
    assert.equal(result.ok,true);
    assert.equal(result.data.kind,kind);
    assert.equal(result.data.onlineError,'');
    assert.equal(result.data.local.length,count);
    assert.equal(result.data.online.candidates.length,count);
    assert.deepEqual(result.data.sources,['owner/repo']);
    assert.equal((await call('adopt_discovered_skill',{id:result.data.online.candidates[0].id})).data.skill.status,'adopted');
  }
  assert.deepEqual(localLimits,[3,2,5,4,3]);
  assert.deepEqual(events.filter(event=>event.type==='skill_library_search_started').map(event=>event.data.limit),localLimits);
  assert.deepEqual(events.filter(event=>event.type==='skill_library_search').map(event=>event.data.kind),['direct','supporting','direct','supporting','direct']);
});

test('GitHub access reuses only host-bound credentials, never exposes secrets or forwards them to another origin',async()=>{
  let commands=0,authorization;
  const access=createGithubAccess({runner:async(binary,args,options)=>{commands++;assert.equal(binary,'git');assert.equal(options.env.GCM_INTERACTIVE,'Never');
    return {exitCode:0,truncated:false,aborted:false,stdout:'protocol=https\nhost=github.com\nusername=test\npassword=fixture-secret\n'};},
    fetcher:async(url,options)=>{authorization=new Headers(options.headers).get('authorization');return new Response(JSON.stringify(url.endsWith('/user')?{login:'test'}:{}));}});
  const status=await access.status(new AbortController().signal);assert.equal(status.connected,true);assert.equal(status.source,'git-credential-manager');assert.equal(status.login,'test');
  await access.fetch('https://api.github.com/repos/owner/repo');assert.equal(authorization,'Bearer fixture-secret');assert.equal(commands,1);
  assert.ok(!JSON.stringify(await access.status()).includes('fixture-secret'));
  await assert.rejects(access.fetch('https://example.invalid/'),/SOURCE_NOT_ALLOWED/);
  const wrong=createGithubAccess({runner:async()=>({exitCode:0,stdout:'protocol=https\nhost=other.example\npassword=wrong\n'})});
  assert.equal((await wrong.status()).connected,false);assert.equal((await wrong.status()).source,'anonymous');
});

test('AI-facing tools discover, read and install a complete package with repeat and conflict handling',async t=>{
  const f=await fixture(t);
  const studio=createSkillStudio(f.store,{userSkillsPath:join(f.root,'skills')});
  const commit='a'.repeat(40);
  const entries=[
    {path:'math-eda/SKILL.md',text:'---\nname: math-eda\ndescription: Exploratory analysis and correlations\nlicense: MIT\n---\nRead references/method.md before analysis.'},
    {path:'math-eda/references/method.md',text:'Inspect distributions and grouped correlations.\n'},
    {path:'math-eda/scripts/analyze.py',text:'print("analysis")\n'},
  ].map(item=>({...item,sha:createHash('sha1').update('blob '+Buffer.byteLength(item.text)+'\0').update(item.text).digest('hex')}));
  const fetcher=async url=>{
    if(url.includes('/search/repositories?'))return Response.json({items:[]});
    if(url.endsWith('/commits/HEAD'))return Response.json({sha:commit});
    if(url.includes('/license?'))return Response.json({license:{spdx_id:'MIT'}});
    if(url.includes('/git/trees/'))return Response.json({sha:'b'.repeat(40),tree:entries.map(({path,text,sha})=>({type:'blob',mode:'100644',path,sha,size:Buffer.byteLength(text)}))});
    const file=entries.find(item=>url.endsWith('/git/blobs/'+item.sha));
    if(file)return Response.json({encoding:'base64',size:Buffer.byteLength(file.text),content:Buffer.from(file.text).toString('base64')});
    throw Error('Unexpected GitHub request');
  };
  const capabilities=createTaskCapabilities({...f,skillSources:['owner/repo'],githubAccess:{fetch:fetcher},search:async()=>[],
    installSkill:args=>studio.installDiscovered({context:f.task,...args})});
  t.after(()=>capabilities.close());
  const call=(name,args)=>capabilities.execute({function:{name,arguments:JSON.stringify(args)}});
  const found=await call('discover_skills',{query:'math',limit:3});
  assert.equal(found.ok,true);
  const id=found.data.candidates[0].id;
  assert.equal((await call('install_discovered_skill',{id,reason:'补齐探索分析'})).error.code,'SKILL_NOT_READ');
  assert.equal((await call('adopt_discovered_skill',{id})).ok,true);
  const installed=await call('install_discovered_skill',{id,reason:'补齐探索分析'});
  assert.equal(installed.ok,true);
  assert.equal(installed.data.fileCount,3);
  assert.equal(await readFile(join(installed.data.path,'..','scripts','analyze.py'),'utf8'),entries[2].text);
  const source=JSON.parse(await readFile(join(installed.data.path,'..','.sih-source.json'),'utf8'));
  assert.equal(source.commit,commit);
  assert.equal(source.sha256,found.data.candidates[0].sha256);
  assert.equal(studio.enabled(f.task).filter(skill=>skill.name==='math-eda').length,1);
  assert.equal((await call('install_discovered_skill',{id,reason:'重试'})).data.id,installed.data.id);
  assert.equal(studio.enabled(f.task).find(skill=>skill.id===installed.data.id).version,1);
  const history=f.store.task(f.task).runs[0].installedSkills;
  assert.equal(history.length,1);
  assert.equal(history[0].name,'math-eda');
  const bundle=entries.map(item=>({path:item.path.replace('math-eda/',''),bytes:Buffer.from(item.text)}));
  assert.equal(studio.installDiscovered({context:f.task,card:found.data.candidates[0],entries:bundle}).reused,true);
  bundle[0].bytes=Buffer.from(entries[0].text+'\nChanged guide.');
  assert.throws(()=>studio.installDiscovered({context:f.task,card:found.data.candidates[0],entries:bundle}),/同名/);
});

test('each user can save, restore and disconnect their own GitHub connection without exporting or copying a token',async t=>{
  const f=await fixture(t),token='fixture-access-token-123456789';
  const secrets={available:true,seal:async value=>'sealed:'+Buffer.from(value).toString('base64'),open:async value=>Buffer.from(value.slice(7),'base64').toString()};
  const fetcher=async(url,options)=>new Response(JSON.stringify({login:new Headers(options.headers).get('authorization')==='Bearer '+token?'own-account':'different-account'}));
  const opts={store:f.store,secrets,fetcher,runner:async()=>({exitCode:1})};
  const access=createGithubAccess(opts);assert.equal((await access.status()).connected,false);
  const saved=await access.saveToken(token);assert.equal(saved.login,'own-account');assert.equal(saved.hasSavedToken,true);
  assert.ok(!JSON.stringify(saved).includes(token));assert.ok(!f.store.query('SELECT secret FROM github_connection','get').secret.includes(token));
  const restored=createGithubAccess(opts);assert.equal((await restored.status()).login,'own-account');
  await restored.disconnect();assert.equal((await restored.status()).connected,false);
  const restarted=createGithubAccess(opts);assert.equal((await restarted.status()).source,'disconnected');
});

test('device login surfaces only the authorization code and supports cancellation',async()=>{
  const runner=async(_binary,args,options)=>{
    if(args.includes('login')){options.onOutput('stderr','Enter ABCD-1234 at https://github.com/login/device');
      return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({exitCode:null,aborted:true}),{once:true}));}
    return {exitCode:1};
  };
  const access=createGithubAccess({runner});const started=access.startLogin();assert.equal(started.status,'waiting');assert.equal(started.code,'ABCD-1234');
  const pending=await access.status();assert.equal(pending.device.code,'ABCD-1234');
  await access.disconnect();const stopped=await access.status();assert.equal(stopped.device.status,'idle');assert.equal(stopped.source,'disconnected');
});

test('bounded child processes are stopped on deadline and bound their output',async t=>{
  if(!await python(t))return;
  const result=await runProcess('python',['-I','-c','import time; time.sleep(20)'],{timeoutMs:100,maxBytes:100});
  assert.equal(result.aborted,true);assert.ok(result.elapsedMs<4000);
  const huge=await runProcess('python',['-I','-c','print("x" * 10000)'],{timeoutMs:5000,maxBytes:100});
  assert.equal(huge.truncated,true);assert.equal(huge.stdout.length,100);
});

test('Python execution requires the reviewed script, per-call approval and project write access; real failures remain failures',async t=>{
  if(!await python(t))return;const f=await fixture(t),code="import os; print(2+3); print('SKILLINTER_API_KEY' in os.environ)\n";
  await writeFile(join(f.workspace,'compute.py'),code);const args={path:'compute.py',sha256:hash(code),purpose:'计算'};
  assert.equal((await runPython(args,{...f,scope:{...f.scope,mode:'project_read'}})).error.code,'PYTHON_NOT_ALLOWED');
  assert.equal((await runPython({...args,sha256:'0'.repeat(64)},f)).error.code,'FILE_CHANGED');
  async function decide(job,decision) {const until=Date.now()+3000;while(!f.entry.testApproval&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.ok(f.entry.testApproval);f.entry.testApproval.decide(decision);return job;}
  assert.equal((await decide(runPython(args,f),'decline')).error.code,'APPROVAL_DECLINED');
  const executed=await decide(runPython(args,f),'approve');assert.equal(executed.data.status,'passed');assert.match(executed.data.stdout,/5\r?\nFalse/);
  const waiting=runPython(args,f);while(!f.entry.testApproval)await new Promise(r=>setTimeout(r,5));
  await writeFile(join(f.workspace,'compute.py'),'print(99)');f.entry.testApproval.decide('approve');assert.equal((await waiting).error.code,'FILE_CHANGED');
  const fail='raise ValueError("expected failure")\n';await writeFile(join(f.workspace,'compute.py'),fail);
  const failed=await decide(runPython({...args,sha256:hash(fail)},f),'approve');assert.equal(failed.data.status,'failed');assert.notEqual(failed.data.exitCode,0);
});

test('automatic execution records the decision, runs the reviewed script, and still checks the hash',async t=>{
  if(!await python(t))return;
  const f=await fixture(t),code='print(42)\n';
  await writeFile(join(f.workspace,'auto.py'),code);
  f.entry.autoApproveExecution=true;
  const args={path:'auto.py',sha256:hash(code),purpose:'自动执行验证'};
  const result=await runPython(args,f);
  assert.equal(result.ok,true);
  assert.equal(result.data.status,'passed');
  assert.match(result.data.stdout,/42/);
  const events=f.store.events(f.run,0);
  assert(events.some(event=>event.type==='project_test_decision'&&event.payload.automatic===true));
  assert(!events.some(event=>event.type==='project_test_request'));
  assert.equal((await runPython({...args,sha256:'0'.repeat(64)},f)).error.code,'FILE_CHANGED');
});

test('main chat automatically reads attached task text, prepares a visible brief, and rejects writes before preparation',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'problem.txt'),'Minimize x subject to x >= 2.');let count=0;
  const call=(name,args)=>({tool_calls:[{id:'call-'+count,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const model={label:'fixture',async invoke({messages}){
    count++;
    if(count===1){assert.match(messages[0].content,/Minimize x/);return call('create_file',{path:'forbidden.txt',content:'wrong'});}
    if(count===2){assert.equal(JSON.parse(messages.at(-1).content).error.code,'TASK_NOT_PREPARED');
      const seq=f.store.events(f.run,0).find(e=>e.payload.intake).seq;
      return call('prepare_task',{objective:'求解最小值',constraints:['x>=2'],deliverables:['解释'],assumptions:[],questions:[],source_receipts:[seq],steps:[{id:'solve',title:'求解',depends_on:[],skill_query:'optimization'}]});}
    assert.equal(JSON.parse(messages.at(-1).content).ok,true);return {content:'任务已整理，缺少适用技能。'};
  }};
  await executeRun({...f,id:f.run,model,skillAccess:true,maxSteps:3,context:{materials:[{path:'problem.txt',name:'problem.txt',kind:'txt'}]}});
  const run=f.store.task(f.task).runs[0];assert.equal(run.status,'completed');assert.equal(run.taskBrief.objective,'求解最小值');
  await assert.rejects(readFile(join(f.workspace,'forbidden.txt')),{code:'ENOENT'});
  for(const tool of taskCapabilityTools)for(const key of ['parameters','returns','errors','timeoutMs','idempotent','authorization'])assert.ok(Object.hasOwn(tool,key));
});

test('selection-only chat blocks premature online search and batch-loads more than one guide',async t=>{
  const f=await fixture(t),prompt='只做技能选择，覆盖回归和绘图。';
  f.store.finish(f.run,'stopped');
  const run=f.store.begin(f.task,crypto.randomUUID(),prompt,{mode:'api'}).id;
  const studio=createSkillStudio(f.store,{userSkillsPath:join(f.root,'skills')});
  const localSkills=[['regression-method','回归'],['plot-method','绘图']].map(([name,description])=>
    studio.publish({targetScope:'global',baseVersion:0,draft:{name,description,instructions:description+'步骤说明',tests:[]}}));
  const skillRegistrySnapshot=createSkillRegistry({store:f.store,studio,projectFor:()=>f.scope.projectId}).snapshot(f.task,localSkills);
  let count=0;
  const call=(name,args)=>({tool_calls:[{id:'selection-'+count,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const model={label:'fixture',async invoke({messages}){
    count++;
    if(count===1)return call('search_skill_libraries',{query:'regression',limit:3});
    if(count===2){
      assert.equal(JSON.parse(messages.at(-1).content).error.code,'SKILL_SELECTION_FIRST');
      return call('prepare_task',{objective:'选择回归与绘图指南',constraints:[],deliverables:[],assumptions:[],questions:[],source_receipts:[],
        steps:[{id:'model',title:'回归',depends_on:[],skill_query:'回归'},{id:'plot',title:'绘图',depends_on:['model'],skill_query:'绘图'}]});
    }
    if(count===3)return call('select_task_skill_chain',{selections:[
      {step_id:'model',skill_id:localSkills[0].id},{step_id:'plot',skill_id:localSkills[1].id},
    ],rationale:'逐项选择本机指南'});
    return {content:'回归和绘图指南已加载。'};
  }};
  await executeRun({...f,run,id:run,prompt,model,skillAccess:true,maxSteps:5,localSkills,skillRegistrySnapshot});
  const result=f.store.task(f.task).runs.find(item=>item.id===run);
  assert.equal(result.status,'completed');
  assert.deepEqual(result.taskSkillChain.selections.map(({name,status})=>[name,status]),[
    ['regression-method','loaded'],['plot-method','loaded'],
  ]);
  assert(!f.store.events(run,0).some(event=>event.type==='skill_library_search_started'));
});
