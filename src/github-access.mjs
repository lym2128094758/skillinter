import {runProcess} from './process-runtime.mjs';
import {windowsSecrets} from './settings.mjs';
import {RequestError} from './store.mjs';

// Each installation uses the current user's credentials, never browser cookies
// or exported connector OAuth sessions.
export function createGithubAccess({env={},store,runner=runProcess,fetcher=fetch,secrets=windowsSecrets}={}) {
  store?.db.exec('CREATE TABLE IF NOT EXISTS github_connection (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, secret TEXT)');
  let credential,verified,verifiedAt=0,loginJob,loginController,generation=0;
  let localConfig={enabled:1,secret:null};
  let device={status:'idle',code:'',url:'https://github.com/login/device',error:''};
  const config=()=>store?.query('SELECT enabled,secret FROM github_connection WHERE id=1','get')??localConfig;
  function configure(enabled,secret=null) {
    store?.query('INSERT OR REPLACE INTO github_connection VALUES(1,?,?)','run',enabled?1:0,secret);
    localConfig={enabled:enabled?1:0,secret};
    credential=null;verified=null;verifiedAt=0;
  }
  async function resolve(signal) {
    const current=config();
    if(!current.enabled)return {token:null,source:'disconnected'};
    if(credential)return credential;
    if(current.secret) {
      try{credential={token:await secrets.open(current.secret),source:'saved-token'};return credential;}
      catch{return {token:null,source:'unreadable-token'};}
    }
    const configured=env.SIH_GITHUB_TOKEN||env.GH_TOKEN||env.GITHUB_TOKEN;
    if(configured){credential={token:configured,source:'environment'};return credential;}
    const result=await runner('git',['-c','credential.interactive=false','credential','fill'],{
      input:'protocol=https\nhost=github.com\n\n',signal,timeoutMs:5000,maxBytes:16000,
      env:{GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});
    if(result.exitCode===0&&!result.truncated&&!result.aborted) {
      const fields=Object.fromEntries(result.stdout.split(/\r?\n/).filter(line=>line.includes('=')).map(line=>{
        const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
      if(fields.protocol==='https'&&fields.host==='github.com'&&fields.password) {
        credential={token:fields.password,source:'git-credential-manager'};return credential;
      }
    }
    return {token:null,source:'anonymous'};
  }
  async function verify(token,signal) {
    const response=await fetcher('https://api.github.com/user',{signal:signal??AbortSignal.timeout(6000),redirect:'error',
      headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','user-agent':'Skillinter'}});
    if(!response.ok)throw Error('AUTH_FAILED');
    const user=await response.json();if(typeof user.login!=='string'||!user.login)throw Error('AUTH_FAILED');
    return user.login;
  }
  async function status(signal,{refresh=false}={}) {
    const auth=await resolve(signal);
    const base={connected:false,source:auth.source,login:null,canStoreToken:secrets.available,
      hasSavedToken:Boolean(config().secret),device:{...device}};
    if(!auth.token)return base;
    if(!refresh&&verified&&Date.now()-verifiedAt<60000)return {...base,connected:true,login:verified};
    try{verified=await verify(auth.token,signal);verifiedAt=Date.now();return {...base,connected:true,login:verified};}
    catch{return {...base,error:'GitHub连接验证失败，请重试或重新登录。'};}
  }
  return {status,
    async saveToken(token,signal) {
      const operation=++generation;
      if(typeof token!=='string'||!/^[!-~]{20,4096}$/.test(token))throw new RequestError(422,'请输入有效的GitHub访问令牌。');
      let login;try{login=await verify(token,signal);}catch{throw new RequestError(422,'GitHub令牌验证失败，请检查令牌和网络。');}
      if(!secrets.available)throw new RequestError(422,'此系统请使用本机GitHub登录或环境变量。');
      const sealed=await secrets.seal(token);
      if(operation!==generation)throw new RequestError(409,'连接操作已变化，未保存旧的登录请求。');
      configure(true,sealed);credential={token,source:'saved-token'};verified=login;verifiedAt=Date.now();
      return status(signal);
    },
    async reuseLocal(signal){++generation;loginController?.abort();await loginJob;configure(true);device={...device,status:'idle',code:'',error:''};return status(signal);},
    async disconnect(){++generation;loginController?.abort();await loginJob;configure(false);device={...device,status:'idle',code:'',error:''};return status();},
    startLogin() {
      if(loginJob)return {...device};
      ++generation;
      configure(true);device={...device,status:'starting',code:'',error:''};
      loginController=new AbortController();let text='';
      loginJob=(async()=>{
        try {
          const result=await runner('git',['credential-manager','github','login','--device','--no-ui','--force'],{
            signal:loginController.signal,timeoutMs:60000,maxBytes:8000,env:{GCM_INTERACTIVE:'Always',GIT_TERMINAL_PROMPT:'0'},
            onOutput(_stream,chunk){text=(text+chunk).slice(-8000);const code=/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(text)?.[0];
              if(code)device={...device,status:'waiting',code};}});
          credential=null;verified=null;
          if(result.exitCode!==0||result.aborted)device={...device,status:'failed',error:result.aborted?'登录超过60秒或已取消，请重试。':'本机GitHub登录程序不可用，可使用下方访问令牌连接。'};
          else {const checked=await status(AbortSignal.timeout(6000));device={...device,status:checked.connected?'completed':'failed',error:checked.connected?'':'登录结果未验证，请刷新或使用令牌连接。'};}
        } catch {device={...device,status:'failed',error:'GitHub登录未完成，可重试或使用访问令牌连接。'};}
        finally {loginJob=null;loginController=null;}
      })();
      return {...device};
    },
    async close(){loginController?.abort();await loginJob;},
    async fetch(url,options={}) {
      const parsed=new URL(url);
      if(parsed.origin!=='https://api.github.com'||parsed.username||parsed.password)throw Error('SOURCE_NOT_ALLOWED');
      const auth=await resolve(options.signal);
      const headers=new Headers(options.headers);headers.delete('authorization');if(auth.token)headers.set('authorization','Bearer '+auth.token);
      return fetcher(url,{...options,headers,redirect:'error'});
    }};
}
