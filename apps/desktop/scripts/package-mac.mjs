import { packager } from "@electron/packager";
import { listPackage, extractFile } from "@electron/asar";
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  cp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw Error("此打包命令当前仅验收 Apple Silicon macOS");
if (process.argv.length > 2)
  throw Error("当前只提供本机开发安装包，不接受隐式发布或覆盖参数");
const run = (command, args) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
const minimumMacOS = execFileSync(
  "/usr/libexec/PlistBuddy",
  [
    "-c",
    "Print LSMinimumSystemVersion",
    join(cwd, "node_modules/electron/dist/Electron.app/Contents/Info.plist"),
  ],
  { encoding: "utf8" },
).trim();
const entitlements = join(cwd, "scripts/entitlements.mac.plist");
run(process.execPath, ["scripts/build.mjs"]);
const releaseRoot = join(cwd, "release");
await mkdir(releaseRoot, { recursive: true });
const temporary = await mkdtemp(join(releaseRoot, ".package-"));
try {
  const stage = join(temporary, "stage");
  await mkdir(join(stage, "build"), { recursive: true });
  for (const name of ["main.cjs", "preload.cjs"])
    await cp(join(cwd, "build", name), join(stage, "build", name));
  await cp(join(cwd, "out"), join(stage, "out"), { recursive: true });
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify(
      {
        name: "ytriple",
        productName: "ytriple",
        version: pkg.version,
        main: "build/main.cjs",
        private: true,
      },
      null,
      2,
    ),
  );
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) await visit(item);
      else if (entry.isFile())
        files.push({
          path: relative(stage, item),
          sha256: digest(await readFile(item)),
        });
      else throw Error("打包输入不允许符号链接");
    }
  }
  await visit(stage);
  for (const file of files)
    if (
      !/^(package\.json|build\/(main|preload)\.cjs|out\/[^\s]+)$/.test(
        file.path,
      ) ||
      file.path.endsWith(".map")
    )
      throw Error(`未获准的打包输入：${file.path}`);
  const buildId = digest(
    JSON.stringify({
      files,
      electron: pkg.devDependencies.electron,
      version: pkg.version,
      packaging: digest(await readFile(fileURLToPath(import.meta.url))),
      icon: digest(await readFile(resolve(cwd, "../../assets/app-icon.svg"))),
      entitlements: digest(await readFile(entitlements)),
    }),
  ).slice(0, 16);
  const destination = join(releaseRoot, `${pkg.version}-${buildId}-local`);
  await mkdir(destination); // Never overwrite an existing release.
  const manifest = {
    version: pkg.version,
    buildId,
    electron: pkg.devDependencies.electron,
    arch: "arm64",
    platform: "darwin",
    distribution: "local-development",
    signing: "ad-hoc",
    notarized: false,
    hardenedRuntime: false,
    minimumMacOS,
    files,
  };
  await writeFile(
    join(stage, "release.json"),
    JSON.stringify(manifest, null, 2),
  );
  const iconset = join(temporary, "ytriple.iconset");
  await mkdir(iconset);
  const svg = await readFile(resolve(cwd, "../../assets/app-icon.svg"), "utf8");
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const png = new Resvg(svg, {
        fitTo: { mode: "width", value: size * scale },
      })
        .render()
        .asPng();
      await writeFile(
        join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        png,
      );
    }
  const icon = join(temporary, "ytriple.icns");
  run("iconutil", ["--convert", "icns", "--output", icon, iconset]);
  const paths = await packager({
    dir: stage,
    name: "ytriple",
    appBundleId: "work.ydev.ytriple",
    appVersion: pkg.version,
    buildVersion: pkg.version,
    executableName: "ytriple",
    platform: "darwin",
    arch: "arm64",
    electronVersion: pkg.devDependencies.electron,
    asar: true,
    prune: false,
    icon,
    out: destination,
    overwrite: false,
    extendInfo: { LSMinimumSystemVersion: minimumMacOS },
    osxSign: {
      identity: "-",
      identityValidation: false,
      preAutoEntitlements: false,
      gatekeeperAssess: false,
      // Ad-hoc identities have no Team ID for library validation. This command
      // produces local development packages only, never a distribution release.
      optionsForFile: () => ({ entitlements, hardenedRuntime: false }),
    },
  });
  const app = join(paths[0], "ytriple.app"),
    archive = join(app, "Contents/Resources/app.asar");
  const archived = listPackage(archive).filter(
    (path) => !["/build", "/out", "/out/assets"].includes(path),
  );
  const expected = [...files.map((f) => "/" + f.path), "/release.json"].sort();
  if (JSON.stringify(archived.sort()) !== JSON.stringify(expected))
    throw Error("安装包文件清单不一致");
  for (const file of files)
    if (digest(extractFile(archive, file.path)) !== file.sha256)
      throw Error("安装包内容校验失败");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const imageRoot = join(temporary, "image");
  await mkdir(imageRoot);
  await cp(app, join(imageRoot, "ytriple.app"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await symlink("/Applications", join(imageRoot, "Applications"));
  await writeFile(
    join(imageRoot, "安装说明.txt"),
    `ytriple ${pkg.version} · Apple Silicon\n\n将 ytriple.app 拖到 Applications 后打开。升级前从设置备份工作空间，完全退出应用后替换应用本身，数据保留在 ~/Library/Application Support/ytriple/desktop-v1。旧版父目录不自动迁移。\n\n此包为本机开发验证版本，采用 ad-hoc 签名，未完成 Apple 公证，不作为已通过公网分发验收的版本。不需要降低 macOS 安全设置。\n\n构建：${buildId}\n`,
  );
  const dmg = join(destination, `ytriple-${pkg.version}-mac-arm64-local.dmg`);
  run("hdiutil", [
    "create",
    "-volname",
    `ytriple ${pkg.version}`,
    "-srcfolder",
    imageRoot,
    "-format",
    "UDZO",
    dmg,
  ]);
  run("hdiutil", ["verify", dmg]);
  const output = {
    ...manifest,
    app: relative(destination, app),
    dmg: relative(destination, dmg),
    dmgSha256: digest(await readFile(dmg)),
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify(output, null, 2),
  );
  await writeFile(
    join(destination, "SHA256SUMS"),
    `${output.dmgSha256}  ${output.dmg}\n`,
  );
  console.log(
    JSON.stringify(
      {
        directory: destination,
        app,
        dmg,
        buildId,
        signing: "ad-hoc",
        notarized: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
