import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runProcess} from './process-runtime.mjs';

// A read-only public Git fallback for exhausted anonymous GitHub API quotas.
// No checkout, hooks, submodules, package installation or source execution.
export async function openGitSkillSource(repository,signal) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('SOURCE_NOT_ALLOWED');
  const root=await mkdtemp(join(tmpdir(),'sih-skill-source-')),dir=join(root,'repo'),hooks=join(root,'no-hooks');
  await mkdir(hooks);
  const env={GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(root,'no-config')};
  async function git(args,maxBytes=3000000) {
    const result=await runProcess('git',['-c','core.hooksPath='+hooks,'-c','credential.helper=','-c','http.extraHeader=','-c','credential.interactive=false',...args],
      {signal,timeoutMs:20000,maxBytes,env});
    if(result.exitCode!==0||result.aborted||result.truncated)throw Error('SOURCE_UNAVAILABLE');
    return result.stdout;
  }
  const close=()=>rm(root,{recursive:true,force:true}).catch(()=>{});
  try {
    await git(['clone','--depth=1','--filter=blob:none','--no-checkout','--no-tags','https://github.com/'+repository+'.git',dir]);
    const commit=(await git(['-C',dir,'rev-parse','HEAD'],100)).trim();
    if(!/^[a-f0-9]{40}$/.test(commit))throw Error('SOURCE_INVALID');
    const entries=(await git(['-C',dir,'ls-tree','-r','-l','-z',commit])).split('\0').filter(Boolean).flatMap(line=>{
      const match=/^(\d+) (\w+) ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/.exec(line);
      return match&&match[1]!=='120000'?[{type:match[2],sha:match[3],size:Number(match[4]),path:match[5]}]:[];
    });
    const byPath=new Map(entries.map(item=>[item.path,item]));
    const read=async(path,maxBytes=64000)=>{
      const item=byPath.get(path);if(!item||item.type!=='blob'||item.size>maxBytes)throw Error('SOURCE_INVALID');
      const text=await git(['-C',dir,'show',commit+':'+path],maxBytes);
      return {bytes:Buffer.from(text,'utf8'),sha:item.sha,size:item.size};
    };
    const licensePath=entries.find(item=>/^(?:LICENSE|LICENCE)(?:\.md|\.txt)?$/i.test(item.path))?.path;
    if(!licensePath)throw Error('SOURCE_INVALID');
    const license=(await read(licensePath)).bytes.toString('utf8');
    const label=/Apache License[\s\S]*Version 2\.0/.test(license)?'Apache-2.0':/Permission is hereby granted, free of charge/.test(license)?'MIT':'LicenseRef-Repository';
    return {commit,tree:{sha:commit,tree:entries,truncated:false},license:label,licensePath,read,close,transport:'git'};
  } catch(error){await close();throw error;}
}
