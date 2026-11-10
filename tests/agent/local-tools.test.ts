import { expect, test } from 'bun:test';
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { existsSync } from 'node:fs';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { createMemberEnv, memberShell } from '../../src/durable/member-env.ts';
import { tempFixture } from '../helpers/temp.ts';
import { groupScope } from '../../src/core/layout.ts';
import { venvPythonPath } from '../../src/agent/python-toolchain.ts';

/** A path as a bash command takes it on every platform. */
const shellPath=(path:string)=>path.replaceAll(String.fromCharCode(92),'/');

test('string commands run with argv shells only; the stdin-only WSL launcher is refused with what to install',()=>{
 // macOS: whatever Pi found, the shell is the first bash on PATH, and Apple's 3.2 is not accepted.
 if(process.platform==='darwin') expect(memberShell({shell:'/bin/bash',args:['-c']})).toEqual({shell:Bun.which('bash')!,args:['-c']});
 else{
  expect(memberShell({shell:'/bin/bash',args:['-c']})).toEqual({shell:'/bin/bash',args:['-c']});
  expect(memberShell({shell:'C:\\Program Files\\Git\\bin\\bash.exe',args:['-c'],commandTransport:'argv'})).toEqual({shell:'C:\\Program Files\\Git\\bin\\bash.exe',args:['-c']});
 }
 expect(()=>memberShell({shell:'C:\\Windows\\System32\\bash.exe',args:['-s'],commandTransport:'stdin'})).toThrow('WSL 启动器');
});

const system32Bash=join(process.env.SystemRoot??'C:\\Windows','System32','bash.exe');
test.skipIf(process.platform!=='win32'||!existsSync(system32Bash))('Pi classifies the System32 launcher as stdin-only, and the member shell refuses it',()=>{
 // Upstream's own classification of the real launcher path (no PATH search, no environment change).
 expect(getShellConfig(system32Bash).commandTransport).toBe('stdin');
 expect(()=>memberShell(getShellConfig(system32Bash))).toThrow('WSL 启动器');
});

// The app execution alias that starts wsl.exe: Pi accepts it as an ordinary argv shell, the member shell does not.
test.skipIf(process.platform!=='win32')('the WindowsApps bash alias is refused like the legacy launcher',()=>{
 expect(()=>memberShell({shell:'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',args:['-c']})).toThrow('WSL 启动器');
 expect(memberShell({shell:'C:\\tools\\WindowsAppsKit\\bash.exe',args:['-c']}).shell).toBe('C:\\tools\\WindowsAppsKit\\bash.exe');
 const alias=join(process.env.LOCALAPPDATA??'','Microsoft','WindowsApps','bash.exe');
 if(!process.env.LOCALAPPDATA||!existsSync(alias))return;
 expect(getShellConfig(alias)).toEqual({shell:alias,args:['-c']});
 expect(()=>memberShell(getShellConfig(alias))).toThrow('WSL 启动器');
});

test('python and python3 in a member command are the document environment\'s interpreter, and say what to do before it exists',async()=>{
 if(process.platform==='win32'&&!existsSync(getShellConfig().shell))return;
 const f=await tempFixture('native-member-python-');
 try{
  const workspace=join(f.root,'workspace'),tempDir=join(f.root,'tmp'),venvDir=join(f.root,'venv');
  for(const path of [workspace,tempDir])await mkdir(path,{recursive:true});
  const env=await createMemberEnv({workspaceDir:workspace,tempDir,phone:'alice',scope:groupScope('g'),venvDir,materialsIndexPath:join(f.root,'index/materials.md')});
  const run=async(command:string)=>{let output='';const result=await env.exec(command,{timeout:60,onOutput:text=>{output+=text;}},context);return{code:result.ok?result.value.exitCode:result.error.message,output:output.trim()};};
  // Before the environment exists: the reason and the tool to call, not "command not found".
  for(const name of ['python','python3'])expect(await run(name+' -c "print(1)"; echo "code=$?"')).toEqual({code:0,output:'Python 环境还没有准备好：先调用 document_environment 工具，成功后再运行 python\ncode=127'});
  // The interpreter is whatever "$PI_PYTHON" names: a stand-in that prints its arguments and its input.
  const python=venvPythonPath(venvDir);
  await mkdir(dirname(python),{recursive:true});
  await link(process.execPath,python).catch(()=>copyFile(process.execPath,python));
  const script='const input=await Bun.stdin.text();console.log(JSON.stringify([process.argv.slice(2),input.trim()]))';
  await writeFile(join(tempDir,'echo.ts'),script);
  const echo=shellPath(join(tempDir,'echo.ts'));
  expect(await run(`python "${echo}" a "b c" <<'EOF'\nfrom stdin\nEOF`)).toEqual({code:0,output:'[["a","b c"],"from stdin"]'});
  expect(await run(`echo piped | python3 "${echo}" x`)).toEqual({code:0,output:'[["x"],"piped"]'});
 }finally{await f.cleanup();}
},60_000);

test('per-call native environments keep cwd independent and binary reads bounded while preserving read-only resources',async()=>{
 const f=await tempFixture('native-member-env-');
 try{
  const workspace=join(f.root,'workspace'),alice=join(f.root,'alice'),bob=join(f.root,'bob');
  for(const path of [workspace,alice,bob])await mkdir(path,{recursive:true});
  await writeFile(join(workspace,'material.txt'),'reference');await writeFile(join(bob,'private.txt'),'bob');
  const build=(tempDir:string,phone:string)=>createMemberEnv({workspaceDir:workspace,tempDir,phone,scope:groupScope('g'),venvDir:join(f.root,'venv'),materialsIndexPath:join(f.root,'index/materials.md')});
  const a=await build(alice,'alice'),b=await build(bob,'bob');
  expect(a).not.toBe(b);expect(a.cwd).toBe(workspace);
  expect((await a.readTextFile(join(workspace,'material.txt'),context))).toEqual({ok:true,value:'reference'});
  expect((await a.readTextFile(join(bob,'private.txt'),context)).ok).toBe(false);
  expect((await a.writeFile(join(workspace,'material.txt'),'changed',context)).ok).toBe(false);
  expect((await a.writeFile(join(alice,'sub/draft.txt'),'draft',context)).ok).toBe(true);
  const reader=await a.openBinaryReader(join(workspace,'material.txt'),undefined,context);expect(reader.ok).toBe(true);
  if(reader.ok){try{expect((await reader.value.read(0,64*1024*1024,context)).ok).toBe(false);expect((await reader.value.read(0,9,context))).toEqual({ok:true,value:Buffer.from('reference')});}finally{await reader.value.close(context);}}
 }finally{await f.cleanup();}
});
