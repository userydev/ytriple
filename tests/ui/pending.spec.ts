import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Repository } from '../../src/storage/repository';
import { EnvironmentCredentials } from '../../src/application/credentials';
import { createServer } from '../../src/server/server';
import { controlledModel } from '../helpers/model';

test('a lost submit acknowledgement survives reopening and is reconciled without another model run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ytriple-pending-ui-'));
  const repository = new Repository(join(directory, 'service.sqlite'));
  const token = 'isolated-pending-service-token-123456789';
  let modelCalls = 0;
  let dropped = false;
  const { app } = createServer({ repository, credentials: new EnvironmentCredentials({ GEMINI_API_KEY: 'isolated-pending-model' }), dataDirectory: directory, token,
    modelFactory: () => ({ generate: request => { modelCalls += 1; return controlledModel.generate(request); } }),
  });
  // The request is accepted and its run is stored, then its response is lost.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!dropped && (request.body as { method?: string } | undefined)?.method === 'submit') { dropped = true; reply.raw.destroy(); }
    return payload;
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  let desktop: ElectronApplication | undefined;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  Object.assign(env, { YTRIPLE_SERVER_URL: url, YTRIPLE_SERVER_TOKEN: token, YTRIPLE_DESKTOP_DATA_DIR: join(directory, 'desktop') });
  const launch = async () => { desktop = await electron.launch({ args: [resolve('.')], env }); const page = await desktop.firstWindow(); await expect(page.getByRole('button', { name: '团队已就绪 服务器', exact: true })).toBeVisible(); return page; };
  try {
    let page = await launch();
    await page.getByLabel('新工作目标').fill('隔离验证：提交回执丢失后继续同一工作');
    await page.getByRole('button', { name: '先准备材料', exact: true }).click();
    const prompt = '请核对时间边界，形成完整的活动安排。';
    await page.getByLabel('与团队交流').fill(prompt);
    await page.getByRole('button', { name: '发送给团队', exact: true }).click();
    await expect(page.getByText('上次提交尚未确认', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '核对提交状态', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '发送给团队', exact: true })).toBeDisabled();
    await expect(page.getByLabel('与团队交流')).toHaveValue(prompt);
    await expect.poll(() => modelCalls).toBe(4);
    const id = repository.listWorks()[0].id;
    expect(repository.getWork(id).runs).toHaveLength(1);
    await desktop!.close(); desktop = undefined;

    page = await launch();
    await page.getByRole('button', { name: /隔离验证：提交回执丢失后继续同一工作/ }).first().click();
    await expect(page.getByText('上次提交尚未确认', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送给团队', exact: true })).toBeDisabled();
    await expect(page.getByLabel('与团队交流')).toHaveValue(prompt);
    // A later draft must survive resolving the earlier, already accepted request.
    await page.getByLabel('与团队交流').fill('这是后续问题草稿，核对旧提交不能把它清空。');
    await page.getByRole('button', { name: '核对提交状态', exact: true }).click();
    await expect(page.getByText('上次提交尚未确认', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/已找到与上次请求一致的新运行/)).toBeVisible();
    await expect(page.getByLabel('与团队交流')).toHaveValue('这是后续问题草稿，核对旧提交不能把它清空。');
    await expect(page.getByRole('button', { name: '发送给团队', exact: true })).toBeEnabled();
    expect(repository.getWork(id).runs).toHaveLength(1);
    expect(modelCalls).toBe(4);
  } finally { await desktop?.close(); await app.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); }
});
