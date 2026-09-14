import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Repository } from '../../src/storage/repository';
import { EnvironmentCredentials } from '../../src/application/credentials';
import { createServer } from '../../src/server/server';
import { controlledModel } from '../helpers/model';

test('settings connects an empty desktop, keeps model credentials on the service, and preserves team and pane choices', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ytriple-settings-ui-'));
  const desktopDirectory = join(directory, 'desktop');
  const repository = new Repository(join(directory, 'service.sqlite'));
  const token = 'isolated-settings-service-token-123456789';
  let modelCalls = 0;
  const { app } = createServer({
    repository, credentials: new EnvironmentCredentials({ GEMINI_API_KEY: 'isolated-settings-model-key' }),
    dataDirectory: directory, token,
    modelFactory: () => ({ generate: request => { modelCalls += 1; return controlledModel.generate(request); } }),
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  let desktop: ElectronApplication | undefined;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'YTRIPLE_SERVER_URL', 'YTRIPLE_SERVER_TOKEN']) delete env[key];
  env.YTRIPLE_DESKTOP_DATA_DIR = desktopDirectory;
  try {
    desktop = await electron.launch({ args: [resolve('.')], env });
    const page = await desktop.firstWindow();
    await expect(page.getByRole('button', { name: '服务未连接 服务器', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '团队与能力', exact: true });
    await settings.getByRole('button', { name: /本机独立 数据与执行留在本机/ }).click();
    await settings.getByRole('button', { name: '保存并连接', exact: true }).click();
    await expect(page.getByRole('button', { name: '待配置模型 本机独立', exact: true })).toBeVisible();
    await expect(settings.getByLabel('API Key', { exact: true })).toBeEmpty();
    await settings.getByLabel('成员名称', { exact: true }).first().fill('本机协调员');
    await settings.getByRole('button', { name: '保存团队与能力', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('团队与能力设置已保存');
    expect(modelCalls).toBe(0);

    await settings.getByRole('button', { name: /服务器 桌面与手机共用服务/ }).click();
    await settings.getByLabel('服务器地址', { exact: true }).fill(url);
    await settings.getByLabel('连接令牌', { exact: true }).fill(token);
    await settings.getByRole('button', { name: '保存并连接', exact: true }).click();
    await expect(page.getByRole('button', { name: '团队已就绪 服务器', exact: true })).toBeVisible();
    await expect(settings.getByLabel('连接令牌', { exact: true })).toBeEmpty();
    await expect(settings.getByLabel('API Key', { exact: true })).toHaveCount(0);
    await expect(settings.getByText('模型由服务器统一管理', { exact: true })).toBeVisible();
    await expect(settings.getByLabel('成员名称', { exact: true }).first()).toHaveValue('统筹');
    await settings.getByLabel('成员名称', { exact: true }).first().fill('主持人');
    await settings.getByLabel('角色职责', { exact: true }).first().fill('组织方向与核查');
    await settings.getByLabel('最多模型调用', { exact: true }).fill('6');
    await settings.getByRole('button', { name: '保存团队与能力', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('团队与能力设置已保存');
    expect(repository.getSettings().team.members[0]).toMatchObject({ name: '主持人', role: '组织方向与核查' });
    expect(repository.getSettings().limits.maxCalls).toBe(6);
    expect(JSON.stringify(repository.getSettings())).not.toContain(token);
    expect(modelCalls).toBe(0);
    await settings.getByRole('button', { name: '完成', exact: true }).click();

    await page.getByLabel('新工作目标').fill('隔离测试：安排读书会的活动流程');
    await page.getByRole('button', { name: '建立工作', exact: true }).click();
    await page.getByLabel('与团队交流', { exact: true }).fill('整理一份安排，核对回顾时间。');
    await page.getByRole('button', { name: '发送给团队', exact: true }).click();
    await expect(page.getByLabel('结果窗口').getByRole('heading', { name: '活动安排', exact: true })).toBeVisible();
    expect(modelCalls).toBe(4);
    const process = page.getByLabel('思维窗口', { exact: true });
    await process.getByRole('button', { name: '聚焦看见协作与方法', exact: true }).click();
    await expect(process).toBeVisible();
    await expect(page.getByLabel('主窗口', { exact: true })).toBeHidden();
    await expect(page.getByLabel('结果窗口', { exact: true })).toBeHidden();
    await process.getByRole('button', { name: '还原三窗口', exact: true }).click();
    await expect(page.getByLabel('主窗口', { exact: true })).toBeVisible();
    await expect(page.getByLabel('结果窗口', { exact: true })).toBeVisible();
    const separator = page.getByRole('separator', { name: '调整第 1 与第 2 窗口宽度', exact: true });
    await separator.focus();
    await separator.press('ArrowRight');
    await expect(separator).toHaveAttribute('aria-valuenow', '36');
    const analysis = process.locator('.event-card').filter({ has: page.getByRole('heading', { name: '研究员：整理活动流程', exact: true }) });
    await analysis.getByRole('button', { name: '追问此处', exact: true }).click();
    await expect(page.getByLabel('发言意图', { exact: true })).toHaveValue('explain');
    await expect(page.getByLabel('交流对象', { exact: true })).toHaveValue('researcher');
    await expect(page.locator('.reference-chip')).toContainText('研究员：整理活动流程');
    await page.getByLabel('与团队交流', { exact: true }).fill('仅解释这一步的完成要求，不修改成果。');
    await page.getByRole('button', { name: '发送给团队', exact: true }).click();
    await expect(page.getByLabel('主窗口').getByText('这一步按目标检查时间和内容是否相符，仍需确认参加者偏好。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('成果版本')).toHaveValue('1');
    await page.getByRole('button', { name: 'ytriple 首页', exact: true }).click();
    const work = repository.listWorks()[0];
    const config = JSON.parse(readFileSync(join(desktopDirectory, 'connection.json'), 'utf8')) as { deviceId: string };
    expect(repository.getWork(work.id, config.deviceId).view.widths).toEqual([36, 31, 33]);
    expect(repository.getWork(work.id).runs.at(-1)?.reference?.kind).toBe('event');
    expect(modelCalls).toBe(5);
    await page.getByRole('button', { name: /隔离测试：安排读书会的活动流程/ }).first().click();
    await expect(page.getByRole('separator', { name: '调整第 1 与第 2 窗口宽度', exact: true })).toHaveAttribute('aria-valuenow', '36');
    await page.screenshot({ path: 'test-results/desktop-settings-and-reference.png', fullPage: true });
  } finally {
    await desktop?.close();
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
