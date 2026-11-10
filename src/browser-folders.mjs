import {randomUUID} from 'node:crypto';
import {RequestError} from './store.mjs';

export const browserFolderId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const unavailable = () => Object.assign(new Error('Browser folder is unavailable'), {contractCode:'BROWSER_FOLDER_UNAVAILABLE'});

export function createBrowserFolders() {
  const channels = new Map();
  const folders = new Map();

  function connect(id, response) {
    channels.get(id)?.response.end();
    const channel = {response, pending:new Map()};
    channels.set(id, channel);
    response.writeHead(200, {'content-type':'text/event-stream; charset=utf-8','x-accel-buffering':'no'});
    response.write(': ready\n\n');
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'),15000);
    heartbeat.unref();
    response.once('close', () => {
      clearInterval(heartbeat);
      for (const pending of channel.pending.values()) pending.finish(unavailable());
      if (channels.get(id) !== channel) return;
      channels.delete(id);
      for (const folder of folders.values()) if (folder.channel === id) folders.delete(folder.id);
    });
  }

  function add(task, {channel,id,name}) {
    if (!channels.has(channel) || !browserFolderId.test(id) || typeof name !== 'string' || !name.trim() || /[\x00-\x1f/\\]/.test(name)) {
      throw new RequestError(422,'浏览器没有提供可读取的文件夹');
    }
    const existing = folders.get(id);
    if (existing && (existing.task !== task || existing.channel !== channel)) throw new RequestError(409,'该文件夹已关联另一会话');
    if (existing) return {id,name:existing.name,browser:true};
    const folder = {id,name,task,channel};
    folders.set(id,folder);
    return {id,name,browser:true};
  }

  function request(folder, details, signal, consume) {
    const channel = channels.get(folder.channel);
    if (!channel || folders.get(folder.id) !== folder) return Promise.reject(unavailable());
    signal?.throwIfAborted();
    return new Promise((resolve,reject) => {
      const id = randomUUID();
      const finish = (error,value) => {
        signal?.removeEventListener('abort',abort);
        channel.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(signal.reason);
      signal?.addEventListener('abort',abort,{once:true});
      channel.pending.set(id,{consume,finish,signal,claimed:false});
      channel.response.write(`data: ${JSON.stringify({id,folder:folder.id,...details})}\n\n`);
    });
  }

  async function reply(channelId, id, req, input) {
    const pending = channels.get(channelId)?.pending.get(id);
    if (!pending || pending.claimed) throw new RequestError(404,'目录读取请求已结束');
    pending.claimed = true;
    const abort = () => req.destroy();
    pending.signal?.addEventListener('abort',abort,{once:true});
    try {
      const code = req.headers['x-sih-folder-error'];
      if (code) {
        req.resume();
        const allowed = ['NOT_FOUND','NOT_FILE','NOT_DIRECTORY','FILE_TOO_LARGE','PERMISSION_DENIED','BROWSER_FOLDER_UNAVAILABLE'];
        throw Object.assign(new Error('Browser folder request failed'),{contractCode:allowed.includes(code) ? code : 'IO_ERROR'});
      }
      const value = await pending.consume(req,input);
      pending.finish(null,value);
    } catch (error) {
      pending.finish(error);
    } finally { pending.signal?.removeEventListener('abort',abort); }
  }

  const forTask = task => [...folders.values()].filter(folder => folder.task === task);
  return {
    connect,add,reply,
    list: task => forTask(task).map(({id,name})=>({id,name,browser:true})),
    remove(task,id) {
      if (folders.get(id)?.task !== task) return false;
      folders.delete(id);
      return true;
    },
    scope: task => forTask(task).map(folder => ({id:folder.id,name:folder.name,browser:{
      list: (path,options,signal) => request(folder,{op:'list',path,...options},signal,(req,input)=>input(req,2_000_000)),
      read: (path,maxBytes,signal,consume) => request(folder,{op:'read',path,maxBytes},signal,req=>{
        const size = Number(req.headers['content-length']);
        const mtime = Number(req.headers['x-sih-folder-mtime']);
        if (req.headers['content-type'] !== 'application/octet-stream' || !Number.isSafeInteger(size) || size < 0 ||
          !Number.isFinite(mtime) || Math.abs(mtime) > 8.64e15) throw Object.assign(new Error('Invalid file metadata'),{contractCode:'IO_ERROR'});
        if (maxBytes && size > maxBytes) {req.resume();throw Object.assign(new Error('File is too large'),{contractCode:'FILE_TOO_LARGE'});}
        return consume(req.iterator({destroyOnReturn:false}),{size,mtime:new Date(mtime).toISOString()});
      }),
    }})),
    close() {for (const {response} of channels.values()) response.end();},
  };
}
