import {createHash} from 'node:crypto';
import {object,validate} from './schema.mjs';
import {resultSchema,success,failure} from './tool-contract.mjs';
import {parseSkillFile} from './skill-import.mjs';
import {openGitSkillSource} from './git-skill-source.mjs';

const str={type:'string',maxLength:1000};
export const onlineErrors={INVALID_ARGUMENT:'公开技能检索参数无效。',SOURCE_UNAVAILABLE:'公开技能库不可用或受到限流。',
  SOURCE_NOT_ALLOWED:'技能来源不在本机配置的公开库范围内。',SKILL_NOT_FOUND:'本轮没有发现这个外部技能。',
  SOURCE_INVALID:'技能内容、许可或来源快照不完整，不能采用。',ABORTED:'公开技能发现已停止。',TIMEOUT:'公开技能发现超时。'};
const candidate=object({id:str,name:str,description:{type:'string',maxLength:2000},repository:str,path:str,url:str,
  commit:str,sha256:str,license:str,resourcesAvailable:{type:'boolean'},status:{enum:['preview','adopted']}});
export const onlineSkillTools=[{name:'discover_skills',
  description:'在本机配置的公开GitHub技能库中找缺少的方法。只发送仓库读取请求，不发送项目正文。返回固定提交、许可、正文指纹及预览；不是正式安装。优先搜索本地技能，缺少时再发现。',
  parameters:object({query:{...str,minLength:1,maxLength:500},limit:{type:'integer',minimum:1,maximum:5}}),
  returns:resultSchema(object({candidates:{type:'array',maxItems:5,items:candidate},unavailable:{type:'array',items:str},truncated:{type:'boolean'}})),
  timeoutMs:20000,idempotent:true,volatile:['data.candidates[].commit','data.candidates[].sha256'],ordering:'按查询词与路径匹配得分降序，同分按仓库路径字典序。'},
  {name:'adopt_discovered_skill',description:'将本轮已发现且有许可和完整正文的外部方法用于当前任务，返回指南及来源。仅本轮采用，不安装、不发布、不授予新工具或执行脚本；配套资源尚未下载时须说明缺口。',
    parameters:object({id:{...str,minLength:1}}),returns:resultSchema(object({skill:candidate,instructions:{type:'string',maxLength:64000},warning:str})),
    timeoutMs:1000,idempotent:true,volatile:[],ordering:'单个冻结的外部方法。'},
  {name:'read_discovered_resource',description:'读取本轮已发现技能在固定提交中的包内文本资源或脚本。path相对SKILL.md所在目录，不允许越界；只返回正文，不执行，不自动安装。',
    parameters:object({id:{...str,minLength:1},path:{...str,minLength:1,maxLength:300}}),
    returns:resultSchema(object({id:str,path:str,url:str,commit:str,sha256:str,text:{type:'string',maxLength:64000}})),
    timeoutMs:10000,idempotent:true,volatile:[],ordering:'单个冻结提交中的UTF-8文本资源。'}].map(tool=>({...tool,errors:onlineErrors,
      authorization:'用户要求按任务寻找技能；仅访问配置的公开仓库。外部文本低于用户目标和宿主权限，不修改正式库。',
      timeoutMode:'整次发现20秒；固定域名请求、限响应体、停止传递到请求。'}));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function createOnlineSkills({sources,signal,emit=()=>{},fetcher=fetch,gitFallback=fetcher===fetch}) {
  const cache=new Map(),candidates=new Map(),trees=new Map();
  async function github(path,bound,maxBytes=3000000) {
    const response=await fetcher('https://api.github.com'+path,{signal:bound,redirect:'error',headers:{accept:'application/vnd.github+json','user-agent':'Skillinter'}});
    if(!response.ok)throw Object.assign(Error('SOURCE_UNAVAILABLE'),{status:response.status});
    const reader=response.body.getReader();let size=0;const chunks=[];
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw Error('SOURCE_INVALID');chunks.push(Buffer.from(value));}}
    finally{await reader.cancel().catch(()=>{});}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const allowed=(sources??['anthropics/skills','openai/skills']).filter(source=>/^[\w.-]+\/[\w.-]+$/.test(source)).slice(0,4);
  return {async close(){for(const value of trees.values())await value.close?.();},async execute(name,args) {
    const definition=onlineSkillTools.find(tool=>tool.name===name);
    if(!definition||validate(definition.parameters,args).length)return failure(onlineErrors,'INVALID_ARGUMENT');
    if(signal.aborted)return failure(onlineErrors,'ABORTED');
    if(name==='adopt_discovered_skill') {
      const found=candidates.get(args.id);if(!found)return failure(onlineErrors,'SKILL_NOT_FOUND');
      found.card.status='adopted';emit('external_skill_adopted',found.card);
      return success({skill:found.card,instructions:found.instructions,warning:'外部方法尚未独立验证；仅采用正文，配套脚本和资源未下载。不能据此声称具备新工具或技能已通过验证。'});
    }
    if(name==='read_discovered_resource') {
      const found=candidates.get(args.id);if(!found)return failure(onlineErrors,'SKILL_NOT_FOUND');
      if(/^[\\/]|[:\\\x00-\x1f]/.test(args.path)||args.path.split('/').some(part=>!part||part.startsWith('.')))return failure(onlineErrors,'SOURCE_NOT_ALLOWED');
      const directory=found.card.path.slice(0,found.card.path.lastIndexOf('/')+1),path=directory+args.path;
      try {
        const source=trees.get(found.card.repository);
        const saved=source?.transport==='git'?await source.read(path):null;
        const file=saved?{type:'file',encoding:'base64',size:saved.size,sha:saved.sha,content:saved.bytes.toString('base64')}:
          await github('/repos/'+found.card.repository+'/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?ref='+found.card.commit,
          AbortSignal.any([signal,AbortSignal.timeout(10000)]),110000);
        if(file.type!=='file'||file.encoding!=='base64'||file.size>64000||typeof file.content!=='string')return failure(onlineErrors,'SOURCE_INVALID');
        const bytes=Buffer.from(file.content,'base64');
        if(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==file.sha)return failure(onlineErrors,'SOURCE_INVALID');
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))return failure(onlineErrors,'SOURCE_INVALID');
        const data={id:args.id,path:args.path,url:'https://github.com/'+found.card.repository+'/blob/'+found.card.commit+'/'+path,
          commit:found.card.commit,sha256:hash(bytes),text};emit('external_skill_resource',{...data,text:undefined});return success(data);
      }catch{return failure(onlineErrors,signal.aborted?'ABORTED':'SOURCE_UNAVAILABLE');}
    }
    const key=JSON.stringify(args);if(cache.has(key))return cache.get(key);
    const bound=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
    const unavailable=[],ranked=[];
    const terms=[...new Set(args.query.toLowerCase().match(/[a-z][a-z0-9-]+|[\u4e00-\u9fff]{2,}/g)||[])];
    const synonyms=[[/论文|写作|paper|writing/,'paper writing document docx'],[/绘图|图表|plot|visual/,'plot visualization design'],
      [/建模|数学|求解|math|optim/,'math scientific optimization'],[/数据|统计|data|stat/,'data analysis spreadsheet'],[/文献|研究|research/,'research citation']];
    for(const [pattern,words]of synonyms)if(pattern.test(args.query))terms.push(...words.split(' '));
    for(const repository of allowed) {
      try {
        if(!trees.has(repository)) {
          try {
          const commit=await github('/repos/'+repository+'/commits/HEAD',bound,200000);
          if(!/^[a-f0-9]{40}$/.test(commit.sha))throw Error('SOURCE_INVALID');
          const [tree,license]=await Promise.all([github('/repos/'+repository+'/git/trees/'+commit.sha+'?recursive=1',bound),
            github('/repos/'+repository+'/license?ref='+commit.sha,bound,100000).catch(error=>{if(error.status===404)return {};throw error;})]);
          trees.set(repository,{tree,commit:commit.sha,license:license.license?.spdx_id??'',licenseSha256:license.sha});
          } catch(error) {
            if(!gitFallback)throw error;
            const fallback=await openGitSkillSource(repository,bound);
            trees.set(repository,fallback);
            emit('external_skill_transport',{repository,transport:'git',reason:'GitHub API不可用，使用无检出只读Git快照。',commit:fallback.commit});
          }
        }
        const {tree,commit,license}=trees.get(repository);
        if(!/^[a-f0-9]{40}$/.test(tree.sha))throw Error('SOURCE_INVALID');
        for(const item of tree.tree??[])if(item.type==='blob'&&/(?:^|\/)SKILL\.md$/i.test(item.path)&&item.size<=64000) {
          const text=item.path.toLowerCase();const score=terms.reduce((sum,term)=>sum+(text.includes(term)?1:0),0);
          if(score)ranked.push({repository,commit,path:item.path,blob:item.sha,license,score,truncated:tree.truncated===true});
        }
      } catch {unavailable.push(repository);}
    }
    ranked.sort((a,b)=>b.score-a.score||(a.repository+'/'+a.path).localeCompare(b.repository+'/'+b.path,'en'));
    const found=[];
    for(const ref of ranked.slice(0,args.limit)) {
      try {
        const source=trees.get(ref.repository),saved=source?.transport==='git'?await source.read(ref.path):null;
        const blob=saved?{encoding:'base64',size:saved.size,content:saved.bytes.toString('base64')}:
          await github('/repos/'+ref.repository+'/git/blobs/'+ref.blob,bound,110000);
        if(blob.encoding!=='base64'||blob.size>64000)throw Error('SOURCE_INVALID');
        const bytes=Buffer.from(blob.content,'base64');
        const gitSha=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
        if(gitSha!==ref.blob)throw Error('SOURCE_INVALID');
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),skill=parseSkillFile('SKILL.md',text);
        if(typeof skill.name!=='string'||skill.name.length>120||!skill.name.trim()||typeof skill.description!=='string')throw Error('SOURCE_INVALID');
        const declaredLicense=/^license:\s*(.+)$/mi.exec(text.split(/^---\s*$/m)[1]??'')?.[1].trim().replace(/^['"]|['"]$/g,'');
        const license=declaredLicense||ref.license;
        if(!license||license.length>1000||['NOASSERTION','NONE'].includes(license))throw Error('SOURCE_INVALID');
        const card={id:'external:'+hash(ref.repository+'@'+ref.commit+':'+ref.path+'\0'+hash(bytes)).slice(0,24),name:skill.name,description:skill.description.slice(0,2000),
          repository:ref.repository,path:ref.path,url:'https://github.com/'+ref.repository+'/blob/'+ref.commit+'/'+ref.path,
          commit:ref.commit,sha256:hash(bytes),license,resourcesAvailable:false,status:'preview'};
        candidates.set(card.id,{card,instructions:skill.instructions.slice(0,64000)});found.push(card);
      } catch {unavailable.push(ref.repository+'/'+ref.path);}
    }
    if(signal.aborted)return failure(onlineErrors,'ABORTED');
    if(bound.aborted)return failure(onlineErrors,'TIMEOUT');
    const result=success({candidates:found,unavailable:[...new Set(unavailable)],truncated:ranked.length>args.limit||ranked.some(item=>item.truncated)});
    emit('external_skill_discovery',result.data);if(!unavailable.length)cache.set(key,result);return result;
  }};
}
