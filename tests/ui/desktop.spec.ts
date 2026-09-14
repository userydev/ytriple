import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join, resolve } from 'node:path';
import { Repository } from '../../src/storage/repository';import { EnvironmentCredentials } from '../../src/application/credentials';import { createServer } from '../../src/server/server';import { controlledModel } from '../helpers/model';
test('desktop completes team work, follows a step, edits an artifact, and restores drafts',async()=> {
  const dir=mkdtempSync(join(tmpdir(),'ytriple-ui-'));const repository=new Repository(join(dir,'service.sqlite'));const token='isolated-ui-service-token-123456789';
  const {app}=createServer({repository,credentials:new EnvironmentCredentials({GEMINI_API_KEY:'isolated-ui-model'}),dataDirectory:dir,token,modelFactory:()=>controlledModel});
  const url=await app.listen({host:'127.0.0.1',port:0});let desktop:ElectronApplication|undefined;
  const start=async()=> {const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),YTRIPLE_SERVER_URL:url,YTRIPLE_SERVER_TOKEN:token,YTRIPLE_DESKTOP_DATA_DIR:join(dir,'desktop')};delete env.ELECTRON_RUN_AS_NODE;desktop=await electron.launch({args:process.env.YTRIPLE_PACKAGED_EXECUTABLE?[]:[resolve('.')],executablePath:process.env.YTRIPLE_PACKAGED_EXECUTABLE,env});const page=await desktop.firstWindow();await expect(page.getByRole('button',{name:'团队已就绪 服务器',exact:true})).toBeVisible();return page;};
  try {
    let page=await start();await page.getByLabel('新工作目标').fill('为周末读书会制定活动安排');await page.getByRole('button',{name:'先准备材料',exact:true}).click();
    await page.getByRole('button',{name:'添加文本',exact:true}).click();await page.getByLabel('材料名称').fill('活动条件');await page.getByLabel('文本内容').fill('6人，周六14至16点，预算120元。');await page.getByRole('button',{name:'添加材料',exact:true}).click();
    await page.getByLabel('与团队交流').fill('请团队协作，写一份可用的活动安排。');await page.getByRole('button',{name:'发送给团队'}).click();
    await expect(page.getByLabel('成果').getByRole('heading',{name:'活动安排',exact:true})).toBeVisible();await expect(page.getByLabel('协作过程').getByText('整理活动流程',{exact:true}).first()).toBeVisible();
    await page.screenshot({path:'test-results/desktop-workspace.png',fullPage:true});
    await page.getByRole('button',{name:'编辑正文',exact:true}).click();
    await page.getByLabel('编辑成果正文').fill('# 活动安排\n\n用户补充：15:50 开始回顾。');
    await page.getByRole('button',{name:'保存新版本',exact:true}).click();
    await expect(page.getByLabel('成果版本')).toHaveValue('2');
    await page.getByLabel('发言意图').selectOption('explain');
    await page.getByLabel('与团队交流').fill('解释这一步使用的方法');await page.getByRole('button',{name:'发送给团队'}).click();
    await expect(page.getByLabel('交流').getByText('这一步按目标检查时间和内容是否相符，仍需确认参加者偏好。',{exact:true})).toBeVisible();
    await expect(page.getByLabel('成果版本')).toHaveValue('2');
    await page.getByLabel('与团队交流').fill('这份草稿应在重开后保留');await page.getByRole('button',{name:'ytriple 首页'}).click();
    await page.getByRole('button',{name:/为周末读书会制定活动安排/}).first().click();await expect(page.getByLabel('与团队交流')).toHaveValue('这份草稿应在重开后保留');
    await desktop!.close();desktop=undefined;page=await start();await page.getByRole('button',{name:/为周末读书会制定活动安排/}).first().click();await expect(page.getByLabel('与团队交流')).toHaveValue('这份草稿应在重开后保留');
    expect(repository.listWorks()).toHaveLength(1);expect(repository.getWork(repository.listWorks()[0].id).artifacts).toHaveLength(1);
  } finally {await desktop?.close();await app.close();repository.close();rmSync(dir,{recursive:true,force:true});}
});

test('homepage starts the entered target in one click and records it once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ytriple-home-start-ui-'));
  const repository = new Repository(join(dir, 'service.sqlite'));
  const token = 'isolated-home-start-service-token-123456789';
  let modelCalls = 0;
  const { app } = createServer({
    repository,
    credentials: new EnvironmentCredentials({ GEMINI_API_KEY: 'isolated-home-start-model' }),
    dataDirectory: dir,
    token,
    modelFactory: () => ({ generate: request => { modelCalls += 1; return controlledModel.generate(request); } }),
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  let desktop: ElectronApplication | undefined;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    YTRIPLE_SERVER_URL: url,
    YTRIPLE_SERVER_TOKEN: token,
    YTRIPLE_DESKTOP_DATA_DIR: join(dir, 'desktop'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    desktop = await electron.launch({ args: [resolve('.')], executablePath: process.env.YTRIPLE_PACKAGED_EXECUTABLE, env });
    const page = await desktop.firstWindow();
    await expect(page.getByRole('button', { name: '团队已就绪 服务器', exact: true })).toBeVisible();
    const target = '一击启动：为周末读书会形成可执行安排';
    await page.getByLabel('新工作目标').fill(target);
    await page.getByRole('button', { name: '开始协作', exact: true }).click();
    await expect(page.getByLabel('交流').getByText(target, { exact: true })).toBeVisible();
    await expect(page.getByLabel('成果').getByRole('heading', { name: '读书会活动安排', exact: true })).toBeVisible();
    expect(repository.listWorks()).toHaveLength(1);
    const work = repository.listWorks()[0];
    expect(repository.getWork(work.id).runs).toHaveLength(1);
    expect(repository.getWork(work.id).messages.find(message => message.role === 'user')?.content).toBe(target);
    expect(modelCalls).toBe(4);
  } finally { await desktop?.close(); await app.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); }
});
