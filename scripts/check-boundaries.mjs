import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
const allowed={core:['core','shared'],providers:['providers','core','shared'],storage:['storage','shared'],application:['application','core','providers','storage','shared'],client:['client','shared'],server:['server','application','storage','shared'],main:['main','application','storage','client','shared'],preload:['preload','shared'],renderer:['renderer','shared']};
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(`${dir}/${e.name}`):/\.[cm]?tsx?$/.test(e.name)?[`${dir}/${e.name}`]:[]);
let errors=0;
for(const file of files('src')) {
 const owner=file.split('/')[1];const content=readFileSync(file,'utf8');
 for(const ref of ts.preProcessFile(content).importedFiles) {
  if(ref.fileName.startsWith('.')) {
   const target=relative(resolve('src'),resolve(dirname(file),ref.fileName)).split('/')[0];
   if(allowed[owner] && !allowed[owner].includes(target)){console.error(`${file}: forbidden import ${ref.fileName}`);errors++;}
  } else if(['renderer','client'].includes(owner) && /^(node:|electron$|@langchain\/|langsmith|fastify)/.test(ref.fileName)){console.error(`${file}: forbidden runtime ${ref.fileName}`);errors++;}
 }
}
if(errors)process.exit(1);console.log('模块依赖检查通过');
