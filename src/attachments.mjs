import {createReadStream, createWriteStream, constants, lstatSync, rmSync} from 'node:fs';
import {mkdir, rm, copyFile, lstat, open} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {createHash, randomUUID} from 'node:crypto';
import {join, extname} from 'node:path';
import {RequestError} from './store.mjs';
import {imageMime} from './images.mjs';
import {runProcess} from './process-runtime.mjs';

export function attachmentPath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f\\:<>"|?*]/.test(value)) throw new RequestError(422,'附件路径无效');
  const parts=value.split('/');
  if (parts.some(part=>!part || part==='.' || part==='..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new RequestError(422,'附件路径无效');
  return parts.join('/');
}

export async function receiveAttachment(req,{state,task,name,relativePath=name,batch=randomUUID(),store}) {
  attachmentPath(name);
  if (name.includes('/')) throw new RequestError(422,'附件名称无效');
  relativePath=attachmentPath(relativePath);
  if (relativePath.split('/').at(-1)!==name || !/^[a-f\d-]{36}$/i.test(batch)) throw new RequestError(422,'附件路径无效');
  if (req.headers['content-type']?.split(';')[0]!=='application/octet-stream') throw new RequestError(415,'需要二进制文件上传');
  store.checkAttachmentTarget(task);
  const extension=extname(name).slice(1).toLowerCase();
  const mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[extension];
  const kind=mime?'image':extension==='csv'?'csv':extension==='txt'?'txt':'material';
  const id=randomUUID(), folder=join(state,'attachments',task), diskPath=join(folder,id);
  const hash=createHash('sha256'); let size=0, head=Buffer.alloc(0);
  await mkdir(folder,{recursive:true});
  req.setTimeout(0);
  try {
    await pipeline(req,new Transform({transform(chunk,encoding,done) {
      hash.update(chunk);size+=chunk.length;
      if(head.length<64)head=Buffer.concat([head,chunk.subarray(0,64-head.length)]);
      done(null,chunk);
    }}),createWriteStream(diskPath,{flags:'wx',mode:0o600}));
    if(mime&&imageMime(head)!==mime)throw new RequestError(422,'图片内容与格式不符，请使用有效的 PNG、JPG、WebP 或 GIF 文件');
    return store.addDiskAttachment(task,{id,name,kind,sha256:hash.digest('hex'),size,diskPath,relativePath,workspacePath:`attachments/${batch}/${relativePath}`});
  } catch(error) {
    await rm(diskPath,{force:true}).catch(()=>{});
    if(error.code==='ENOSPC')throw new RequestError(507,'磁盘空间不足，请释放空间后重新上传');
    throw error;
  }
}

export async function fileHead(file) {
  if(!file.disk_path)return file.bytes.subarray(0,64);
  const handle=await open(file.disk_path,'r');
  try {const bytes=Buffer.alloc(64); const {bytesRead}=await handle.read(bytes,0,64,0);return bytes.subarray(0,bytesRead);}
  finally {await handle.close();}
}

export async function sendAttachment(res,file) {
  if(file.disk_path)await pipeline(createReadStream(file.disk_path),res);
  else res.end(file.bytes);
}

export async function materializeAttachment(root,material,file) {
  // Every ancestor is checked before writing; never follow a workspace symlink.
  const rootStat=await lstat(root);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new RequestError(409,'工作区附件路径异常，已停止执行');
  let parent=root;
  for(const part of material.path.split('/').slice(0,-1)) {
    parent=join(parent,part);
    await mkdir(parent).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat=await lstat(parent);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new RequestError(409,'工作区附件路径异常，已停止执行');
  }
  const path=join(root,material.path);
  try {
    if(file.disk_path)await copyFile(file.disk_path,path,constants.COPYFILE_EXCL);
    else {const handle=await open(path,'wx');try{await handle.writeFile(file.bytes);}finally{await handle.close();}}
  } catch(error) {if(error.code!=='EEXIST')throw error;}
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink())throw new RequestError(409,'工作区附件路径异常，已停止执行');
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  if(hash.digest('hex')!==file.sha256)throw new RequestError(409,'工作区附件已变化，请新建任务重新上传');
}

export function removeMaterializedAttachment(root,file) {
  const parts=(file.workspace_path??`${file.id}.${file.kind}`).split('/');
  let parent=root;
  for(const part of ['',...parts.slice(0,-1)]) {
    parent=join(parent,part);
    const stat=lstatSync(parent,{throwIfNoEntry:false});
    if(!stat?.isDirectory()||stat.isSymbolicLink())return;
  }
  rmSync(join(parent,parts.at(-1)),{force:true});
}

export async function pickLocalFolder(signal) {
  if(process.platform!=='win32')throw new RequestError(422,'请粘贴本机文件夹路径');
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Skillinter：选择要挂载的本机文件夹'
    $dialog.ShowNewFolderButton = $false
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    try {
      if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Write($dialog.SelectedPath)
      }
    } finally { $dialog.Dispose(); $owner.Dispose() }
  `;
  const result=await runProcess(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{signal,timeoutMs:120000,maxBytes:12000});
  if(result.aborted)throw new RequestError(408,'文件夹选择已超时，请重试或粘贴路径');
  if(result.exitCode!==0||result.truncated)throw new RequestError(422,'无法打开本机选择器，请粘贴文件夹路径');
  return result.stdout || null;
}
