import test from 'node:test';
import assert from 'node:assert/strict';
import {skillTrace} from './trace.mjs';

test('只把 DSH 已结束的原生调用记为实际执行，并保留失败结果',()=>{
  const call=(id,name,args)=>({type:'tool/call',data:{turn:1,step:1,callId:id,name,arguments:JSON.stringify(args)}});
  const done=(id,isError)=>({type:'tool/result',data:{turn:1,step:1,message:{source:{kind:'tool',callId:id},content:[{type:'tool-result',toolCallId:id,isError}]}}});
  const events=[call('a','skill',{name:'math'}),done('a',false),call('b','skill',{name:'bad'}),done('b',true),call('c','bash',{})];
  assert.deepEqual(skillTrace(events).map(({skill,success})=>({skill,success})),[{skill:'math',success:true},{skill:'bad',success:false}]);
  assert.deepEqual(skillTrace(events,2),[]);
});
