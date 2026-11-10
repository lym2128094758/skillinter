const callbackResult = call => new Promise((resolve,reject) => call(resolve,reject));

export function captureDrop(transfer) {
  const items = [...transfer.items].filter(item=>item.kind==='file').map(item=>{
    const entry = item.webkitGetAsEntry?.();
    return {
      entry,file:item.getAsFile(),
      handle:!entry ? item.getAsFileSystemHandle?.().catch(()=>null) : null,
    };
  });
  const fallback = [...transfer.files];
  return async () => {
    if (!items.length) return {files:fallback,folders:[]};
    const files = [], folders = [];
    for (const {entry,file,handle} of items) {
      const selected = await handle;
      if (selected?.kind==='directory') folders.push(selected);
      else if (entry?.isDirectory) folders.push(entry);
      else if (file) files.push(file);
    }
    return {files,folders};
  };
}

function directory(root,path) {
  const parts = path==='.' ? [] : path.split('/');
  if (parts.some(part=>!part||part==='.'||part==='..'||/[:\\\x00-\x1f]/.test(part))) throw new DOMException('Invalid path','NotFoundError');
  return parts.reduce(async (previous,name)=>{
    const parent = await previous;
    return parent.kind==='directory' ? parent.getDirectoryHandle(name) : callbackResult((resolve,reject)=>parent.getDirectory(name,{},resolve,reject));
  },Promise.resolve(root));
}

async function children(dir) {
  const entries = [];
  if (dir.kind==='directory') {
    for await (const item of dir.values()) entries.push(item);
  } else {
    const reader = dir.createReader();
    for (;;) {
      const batch = await callbackResult((resolve,reject)=>reader.readEntries(resolve,reject));
      if (!batch.length) break;
      entries.push(...batch);
    }
  }
  return entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
}

const isDirectory = entry => entry.kind==='directory' || entry.isDirectory;
const getFile = entry => entry.kind==='file' ? entry.getFile() : callbackResult((resolve,reject)=>entry.file(resolve,reject));

async function inventory(root,{path,depth,maxEntries,includeHidden}) {
  const entries = [];
  const queue = [{entry:await directory(root,path), prefix:path==='.'?'':path+'/', level:1}];
  for (const {entry,prefix,level} of queue) {
    for (const child of await children(entry)) {
      if ((!includeHidden && child.name.startsWith('.')) || /[:/\\\x00-\x1f]/.test(child.name)) continue;
      if (entries.length >= maxEntries) return {entries,truncated:true};
      const path = prefix+child.name;
      if (isDirectory(child)) {
        entries.push({path,type:'directory',size:0,mtime:new Date(0).toISOString()});
        if (level<depth) queue.push({entry:child,prefix:path+'/',level:level+1});
      } else {
        const file = await getFile(child);
        entries.push({path,type:'file',size:file.size,mtime:new Date(file.lastModified).toISOString()});
      }
    }
  }
  return {entries,truncated:false};
}

async function openFile(root,path) {
  const parts = path.split('/');
  const name = parts.pop();
  if (!name || name==='.' || name==='..' || /[:\\\x00-\x1f]/.test(name)) throw new DOMException('Invalid file','TypeMismatchError');
  const parent = await directory(root,parts.join('/')||'.');
  const entry = parent.kind==='directory' ? await parent.getFileHandle(name) : await callbackResult((resolve,reject)=>parent.getFile(name,{},resolve,reject));
  return getFile(entry);
}

export function createBrowserFolderAccess(api) {
  const folders = new Map();
  const channel = crypto.randomUUID();
  const endpoint = '/api/browser-folders/'+channel;
  let source, ready;

  async function answer(event) {
    const request = JSON.parse(event.data);
    const root = folders.get(request.folder)?.root;
    const url = `${endpoint}/${request.id}`;
    const send = (headers,body) => fetch(url,{method:'POST',headers,body});
    try {
      if (!root) return await send({'x-sih-folder-error':'BROWSER_FOLDER_UNAVAILABLE'});
      if (request.op==='list') return await send({'content-type':'application/json'},JSON.stringify(await inventory(root,request)));
      const file = await openFile(root,request.path);
      if (request.maxBytes && file.size>request.maxBytes) return await send({'x-sih-folder-error':'FILE_TOO_LARGE'});
      await send({'content-type':'application/octet-stream','x-sih-folder-mtime':String(file.lastModified)},file);
    } catch (error) {
      const code = error.name==='NotFoundError'?'NOT_FOUND':error.name==='TypeMismatchError'?(request.op==='list'?'NOT_DIRECTORY':'NOT_FILE'):
        ['NotAllowedError','SecurityError','NotReadableError'].includes(error.name)?'PERMISSION_DENIED':'IO_ERROR';
      await send({'x-sih-folder-error':code}).catch(()=>{});
    }
  }

  function register(task,{id,root}) {
    return api(`/api/tasks/${task}/folders`,{id,name:root.name,channel,browser:true});
  }

  function connect() {
    if (source?.readyState===EventSource.OPEN) return Promise.resolve();
    if (ready) return ready;
    source ??= new EventSource(endpoint);
    source.onmessage = event => void answer(event);
    ready = new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>{
        source.close();source=undefined;
        reject(new Error('无法建立本机目录连接，请重新拖入。'));
      },5000);
      source.onopen = () => {
        clearTimeout(timer);resolve();
        for (const folder of folders.values()) void register(folder.task,folder).catch(()=>{});
      };
    }).finally(()=>{ready=undefined;});
    return ready;
  }

  return {
    async add(task,root) {
      await connect();
      const folder = {id:crypto.randomUUID(),task,root};
      folders.set(folder.id,folder);
      try {return await register(task,folder);}
      catch(error) {folders.delete(folder.id);throw error;}
    },
    remove(id) {folders.delete(id);},
    async restore(task) {
      const current = [...folders.values()].filter(folder=>folder.task===task);
      if (!current.length) return;
      await connect();
      await Promise.all(current.map(folder=>register(task,folder)));
    },
  };
}
