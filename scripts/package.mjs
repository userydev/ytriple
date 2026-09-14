import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const {version}=JSON.parse(readFileSync('package.json','utf8'));
const outputs=await packager({dir:'.',out:'release',name:'ytriple',appBundleId:'app.ytriple.desktop',platform:'darwin',arch:'arm64',overwrite:true,prune:true,asar:true,ignore:[/^\/(?:src|tests|test-results|scripts|docs|apps|dist|release|\.git|\.ytriple-server)(?:\/|$)/,/^\/.*\.ts$/,/^\/\.env/]});
console.log(outputs.join('\n'));
if(process.platform==='darwin') {const archive=`release/ytriple-${version}-macos-arm64.zip`;execFileSync('ditto',['-c','-k','--sequesterRsrc','--keepParent',`${outputs[0]}/ytriple.app`,archive]);console.log(archive);}
