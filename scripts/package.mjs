import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
const outputs=await packager({dir:'.',out:'release',name:'ytriple',appBundleId:'app.ytriple.desktop',platform:'darwin',arch:'arm64',overwrite:true,prune:true,asar:true,ignore:[/^\/(?:src|tests|test-results|scripts|docs|apps|dist|release|\.git|\.ytriple-server)(?:\/|$)/,/^\/.*\.ts$/,/^\/\.env/]});
console.log(outputs.join('\n'));
if(process.platform==='darwin') {execFileSync('ditto',['-c','-k','--sequesterRsrc','--keepParent',`${outputs[0]}/ytriple.app`,'release/ytriple-0.1.0-macos-arm64.zip']);console.log('release/ytriple-0.1.0-macos-arm64.zip');}
