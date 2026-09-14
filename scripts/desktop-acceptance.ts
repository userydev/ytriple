/** Starts an isolated service and prepares a separate macOS app for manual UI acceptance.
 * Does not drive the UI, seed work, or submit a model request. Stop with Ctrl-C.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { packager } from '@electron/packager';
import { Repository } from '../src/storage/repository';
import { EnvironmentCredentials } from '../src/application/credentials';
import { createServer } from '../src/server/server';
import { controlledModel } from '../tests/helpers/model';
import type { ModelPort } from '../src/core/model-port';

const acceptanceModel: ModelPort = { async generate(request) {
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); request.signal.removeEventListener('abort', stop); reject(new DOMException('Stopped', 'AbortError')); };
    const timer = setTimeout(() => { request.signal.removeEventListener('abort', stop); resolve(); }, /验收停止|acceptance stop/i.test(request.prompt) ? 25000 : 600);
    request.signal.addEventListener('abort', stop, { once: true });
    if (request.signal.aborted) stop();
  });
  if (request.prompt.startsWith('[stage:synthesize]') && /本次为现有成果修订|本次是对过程步骤的纠正，并基于现有成果修订/.test(request.prompt)) {
    const json = request.prompt.split('输入数据：\n')[1]?.split('\n实际计划：')[0];
    const context = json ? JSON.parse(json) : undefined;
    if (context?.baseArtifact?.content) {
      const original = context.reference?.kind === 'artifact' && context.reference.quote ? context.reference.quote : '15:45 回顾。';
      const result = JSON.stringify({ answer: '已将回顾开始时间调整为15:50，其余原文保留。', artifact: null, changes: '依据用户的修正，调整回顾环节开始时间。', replacements: [{ original, replacement: '15:50 回顾。' }] });
      request.onText?.(result);
      return { text: result, inputTokens: 10, outputTokens: 20 };
    }
  }
  return controlledModel.generate(request);
} };

const mode = process.env.YTRIPLE_ACCEPTANCE_MODE;
if (mode !== 'controlled' && mode !== 'live') throw new Error('Set YTRIPLE_ACCEPTANCE_MODE=controlled or live explicitly.');
if (mode === 'live' && process.env.YTRIPLE_LIVE_TEST !== '1') throw new Error('Live model acceptance requires YTRIPLE_LIVE_TEST=1 and prior authorization.');
const sourceApp = resolve('release/ytriple-darwin-arm64/ytriple.app');
if (process.platform !== 'darwin' || !existsSync(sourceApp)) throw new Error('Build the macOS app with npm run package first.');
for (const key of ['LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING', 'LANGCHAIN_VERBOSE']) process.env[key] = 'false';
const resume = process.env.YTRIPLE_ACCEPTANCE_RESUME;
const directory = resume ? realpathSync(resume) : mkdtempSync(join(tmpdir(), `ytriple-acceptance-${mode}-`));
if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith(`ytriple-acceptance-${mode}-`)) throw new Error('Acceptance may only resume its own temporary workspace.');
const repository = new Repository(join(directory, 'workspace.sqlite'));
repository.recoverInterruptedRuns();
const credentials = mode === 'live' ? new EnvironmentCredentials() : new EnvironmentCredentials({ GEMINI_API_KEY: 'isolated-controlled-model' });
const settings = repository.getSettings();
if (process.env.YTRIPLE_MODEL) settings.provider.model = process.env.YTRIPLE_MODEL;
if (!credentials.get(settings.provider)) throw new Error('No configured credential for the selected live model.');
repository.saveSettings(settings);
const token = randomBytes(32).toString('hex');
const { app } = createServer({ repository, credentials, dataDirectory: directory, token, ...(mode === 'controlled' ? { modelFactory: () => acceptanceModel } : {}) });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const desktopDirectory = join(directory, 'desktop');
mkdirSync(desktopDirectory, { mode: 0o700, recursive: true });
// Only a generated, temporary loopback service token enters this isolated bundle.
// Provider credentials remain exclusively in the service process environment.
// Packager renames the executable and all Electron Helpers consistently. Merely
// changing CFBundleName in a copied app breaks Helper lookup on macOS.
const name = 'ytriple-acceptance';
const outputs = await packager({ dir: '.', out: 'release/acceptance', name, appBundleId: 'app.ytriple.acceptance.current', platform: 'darwin', arch: 'arm64', overwrite: true, prune: true, asar: true,
  extendInfo: { LSEnvironment: { YTRIPLE_DESKTOP_DATA_DIR: desktopDirectory, YTRIPLE_SERVER_URL: url, YTRIPLE_SERVER_TOKEN: token, YTRIPLE_WINDOW_TITLE: `ytriple acceptance ${mode}` } },
  ignore: [/^\/(?:src|tests|test-results|scripts|docs|apps|dist|release|\.git|\.ytriple-server)(?:\/|$)/, /^\/.*\.ts$/, /^\/\.env/],
});
const appPath = resolve(outputs[0], `${name}.app`);
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
const evidenceDirectory = resolve('test-results/acceptance');
mkdirSync(evidenceDirectory, { recursive: true });
const evidenceFile = join(evidenceDirectory, `${mode}-runtime.json`);
const runtime = { mode, startedAt: new Date().toISOString(), servicePid: process.pid, serviceUrl: url, directory, appPath, version: JSON.parse(readFileSync('package.json', 'utf8')).version };
writeFileSync(evidenceFile, JSON.stringify(runtime, null, 2));
console.log(JSON.stringify(runtime, null, 2));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => {
    // Retain synthetic evidence for inspection. Never write secrets or model raw errors.
    const works = repository.listWorks().map(work => {
      const detail = repository.getWork(work.id);
      return { id: work.id, title: work.title, runs: detail.runs.map(run => ({ id: run.id, intent: run.intent, status: run.status, usage: run.usage, goalRevision: run.goalRevision })), eventTypes: [...new Set(detail.events.map(event => event.type))], artifacts: detail.artifacts.map(artifact => ({ kind: artifact.kind, currentVersion: artifact.currentVersion, versionCount: artifact.versions.length })) };
    });
    writeFileSync(join(evidenceDirectory, `${mode}-results.json`), JSON.stringify({ ...runtime, stoppedAt: new Date().toISOString(), works }, null, 2));
    repository.close();
    process.exit(0);
  });
});
