import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {tmpdir} from 'node:os';
import {join, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {streamMaterial, fileErrors} from './tools.mjs';
import {object, validate} from './schema.mjs';
import {resultSchema, success, failure} from './tool-contract.mjs';
import {runProcess} from './process-runtime.mjs';

const str = {type:'string',maxLength:1000};
export const documentErrors = {...fileErrors,INVALID_ARGUMENT:'材料读取参数无效。',UNSUPPORTED_FORMAT:'此格式尚无正文解析器。',
  PARSER_UNAVAILABLE:'缺少材料解析程序，请安装 Python 或 pdftotext。',PARSE_FAILED:'材料解析失败，未执行宏、公式或嵌入代码。',
  NO_TEXT:'未提取到可读正文，扫描件需要 OCR。',TIMEOUT:'材料解析超时。',ABORTED:'材料读取已停止。'};
export const readDocumentTool = {name:'read_document',
  description:'读取授权项目或附件的 PDF、DOCX、XLSX、UTF-8 文本正文，自动识别格式；offset/limit 对提取文本行计数，保留原始 SHA。PDF 页用换页符分隔；扫描件无 OCR。表格保留工作表、单元格坐标和缓存值，不计算公式。',
  parameters:object({path:{...str,minLength:1},offset:{type:'integer',minimum:0,maximum:1000000},limit:{type:'integer',minimum:1,maximum:500}}),
  returns:resultSchema(object({path:str,format:str,sourceSha256:str,offset:{type:'integer'},totalLines:{type:'integer'},
    linesReturned:{type:'integer'},text:{type:'string',maxLength:48000},truncated:{type:'boolean'},notice:str})),
  errors:documentErrors,timeoutMs:15000,idempotent:true,volatile:[],ordering:'按正文段落、工作表及行的原顺序。',
  authorization:'沿用会话附件或项目读取范围；源文件只读，不执行其代码。',timeoutMode:'子进程15秒硬上限并传递停止。',defaults:{offset:0,limit:200}};
const maxCharacters = 48000;

async function textPage(chunks, {offset, limit}, hash) {
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let line = 0, linesReturned = 0, text = '', clipped = false;
  let previousCR = false, hasText = false;
  function append(value) {
    if (line < offset || line >= offset + limit || !value) return;
    const remaining = maxCharacters - text.length;
    if (value.length > remaining) clipped = true;
    text += value.slice(0,remaining);
  }
  function consume(value) {
    if (value.includes('\0')) throw new TypeError('binary data');
    hasText ||= Boolean(value.trim());
    if (!value) return;
    if (previousCR && value.startsWith('\n')) value = value.slice(1);
    previousCR = value.endsWith('\r');
    let start = 0;
    for (const match of value.matchAll(/\r\n|\r|\n/g)) {
      append(value.slice(start,match.index));
      if (line >= offset && line < offset + limit && !clipped) linesReturned++;
      if (line + 1 < offset + limit) append('\n');
      line++;
      start = match.index + match[0].length;
    }
    append(value.slice(start));
  }
  let invalidText = false;
  try {
    for await (const chunk of chunks) {
      hash?.update(chunk);
      if (!invalidText) {
        try {consume(decoder.decode(chunk,{stream:true}));}
        catch (error) {if (!(error instanceof TypeError)) throw error; invalidText = true;}
      }
    }
    if (invalidText) return {error:'UNSUPPORTED_FORMAT'};
    consume(decoder.decode());
  } catch (error) {
    if (error instanceof TypeError) return {error:'UNSUPPORTED_FORMAT'};
    throw error;
  }
  if (!hasText) return {error:'NO_TEXT'};
  if (line >= offset && line < offset + limit && !clipped) linesReturned++;
  return {totalLines:line + 1,linesReturned,text,truncated:clipped || line + 1 > offset + limit};
}

export async function readDocument(args,{workspace,scope,signal,materials=[]}) {
  if(validate(readDocumentTool.parameters,args).length)return failure(documentErrors,'INVALID_ARGUMENT');
  const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)]);
  const material=materials.find(item=>item.path===args.path);
  let format=extname(material?.name||args.path).slice(1).toLowerCase();
  let scratch, input;
  const hash=createHash('sha256');
  try {
    const snapshot=await streamMaterial(workspace,scope,args.path,deadline,async stream=>{
      const iterator=stream[Symbol.asyncIterator]();
      const first=await iterator.next();
      if(first.value?.subarray(0,5).toString()==='%PDF-')format='pdf';
      async function* chunks() {
        if(!first.done)yield first.value;
        for(let part=await iterator.next();!part.done;part=await iterator.next())yield part.value;
      }
      if(!['pdf','docx','xlsx'].includes(format)) {
        format='text';
        return textPage(chunks(),args,hash);
      }
      scratch=await mkdtemp(join(tmpdir(),'sih-document-'));
      input=join(scratch,`input.${format}`);
      async function* hashedChunks() {
        for await(const chunk of chunks()) {hash.update(chunk);yield chunk;}
      }
      await pipeline(Readable.from(hashedChunks()),createWriteStream(input,{flags:'wx'}),{signal:deadline});
    });
    if(snapshot.error)return {ok:false,data:null,error:snapshot.error};
    let page=snapshot.value;
    if(format==='pdf') {
      const output=join(scratch,'output.txt');
      const result=await runProcess('pdftotext',['-layout','-enc','UTF-8',input,output],{signal:deadline,timeoutMs:15000,maxBytes:4000});
      if(result.unavailable)return failure(documentErrors,'PARSER_UNAVAILABLE');
      if(result.aborted)return failure(documentErrors,signal?.aborted?'ABORTED':'TIMEOUT');
      if(result.exitCode!==0)return failure(documentErrors,'PARSE_FAILED');
      page=await textPage(createReadStream(output,{signal:deadline}),args);
    } else if(['docx','xlsx'].includes(format)) {
      const helper=fileURLToPath(new URL('../scripts/extract-document.py',import.meta.url));
      const result=await runProcess('python',['-I',helper,format,input,String(args.offset),String(args.limit)],{signal:deadline,timeoutMs:15000,maxBytes:512000,env:{PYTHONIOENCODING:'utf-8'}});
      if(result.unavailable)return failure(documentErrors,'PARSER_UNAVAILABLE');
      if(result.aborted)return failure(documentErrors,signal?.aborted?'ABORTED':'TIMEOUT');
      if(result.exitCode!==0||result.truncated)return failure(documentErrors,'PARSE_FAILED');
      page=JSON.parse(result.stdout);
    }
    if(page.error)return failure(documentErrors,page.error);
    return success({path:args.path,format,sourceSha256:hash.digest('hex'),offset:args.offset,...page,notice:page.truncated?'结果不完整。':''});
  } catch {return failure(documentErrors,signal?.aborted?'ABORTED':deadline.aborted?'TIMEOUT':'PARSE_FAILED');}
  finally {if(scratch)await rm(scratch,{recursive:true,force:true}).catch(()=>{});}
}
