import { packager } from "@electron/packager";
import { listPackage, extractFile } from "@electron/asar";
import { Resvg } from "@resvg/resvg-js";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  cp,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { X509Certificate } from "node:crypto";
import { resolve, join, relative, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw Error("此打包命令当前仅验收 Apple Silicon macOS");
if (process.argv.length > 2)
  throw Error("当前只提供本机开发安装包，不接受隐式发布或覆盖参数");
const run = (command, args) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
const capture = (command, args, output = "stdout") => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(
      `${command} 失败 (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  return output === "combined"
    ? result.stdout + result.stderr
    : output === "stderr"
      ? result.stderr
      : result.stdout;
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signingConfigPath = resolve(cwd, "../../.local/macos-signing.json");
async function signingConfiguration() {
  const envIdentity = process.env.YTRIPLE_SIGN_IDENTITY?.trim();
  const envKeychain = process.env.YTRIPLE_SIGN_KEYCHAIN?.trim();
  const envPasswordFile = process.env.YTRIPLE_SIGN_PASSWORD_FILE?.trim();
  if (!!envIdentity !== !!envKeychain)
    throw Error(
      "本地签名配置不完整：YTRIPLE_SIGN_IDENTITY 与 YTRIPLE_SIGN_KEYCHAIN 必须同时设置",
    );
  let raw;
  try {
    raw = JSON.parse(await readFile(signingConfigPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (
    raw &&
    (typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some(
        (key) => !["identity", "keychain", "passwordFile"].includes(key),
      ) ||
      typeof raw.identity !== "string" ||
      typeof raw.keychain !== "string" ||
      (raw.passwordFile !== undefined && typeof raw.passwordFile !== "string"))
  )
    throw Error(`本地签名配置格式无效：${signingConfigPath}`);
  let identity = envIdentity,
    keychain = envKeychain,
    passwordFile = envPasswordFile ?? raw?.passwordFile?.trim();
  if (!identity) {
    if (
      !raw ||
      typeof raw.identity !== "string" ||
      typeof raw.keychain !== "string"
    )
      throw Error(
        `缺少稳定的本地签名身份。请同时设置 YTRIPLE_SIGN_IDENTITY/YTRIPLE_SIGN_KEYCHAIN，或创建 ${signingConfigPath}：{"identity":"证书名称或 SHA-1","keychain":"/绝对路径/到签名.keychain-db","passwordFile":"/可选/钥匙串密码文件"}。不会回退到 ad-hoc 签名。`,
      );
    identity = raw.identity.trim();
    keychain = raw.keychain.trim();
  }
  if (!identity || !keychain || !isAbsolute(keychain))
    throw Error("本地签名 identity 不能为空，keychain 必须是绝对路径");
  if (passwordFile) {
    if (!isAbsolute(passwordFile))
      throw Error("签名钥匙串 passwordFile 必须是绝对路径");
    const passwordInfo = await stat(passwordFile).catch(() => undefined);
    if (
      !passwordInfo?.isFile() ||
      (passwordInfo.mode & 0o077) !== 0 ||
      passwordInfo.size < 1 ||
      passwordInfo.size > 1024
    )
      throw Error("签名钥匙串 passwordFile 必须是权限 0600 的小型普通文件");
    const password = (await readFile(passwordFile, "utf8")).trimEnd();
    if (!password) throw Error("签名钥匙串 passwordFile 不能为空");
    const unlocked = spawnSync(
      "security",
      ["unlock-keychain", "-p", password, keychain],
      { cwd, encoding: "utf8" },
    );
    if (unlocked.error || unlocked.status !== 0)
      throw Error("无法使用 passwordFile 解锁本地签名钥匙串");
  }
  let listed;
  try {
    listed = capture("security", [
      "find-identity",
      "-p",
      "codesigning",
      keychain,
    ]);
  } catch {
    throw Error(`无法读取签名钥匙串 ${keychain}；请先解锁并确认路径`);
  }
  const identities = [
    ...listed.matchAll(/\)\s+([0-9A-F]{40})\s+"([^"]+)"/g),
  ].map((match) => ({ sha1: match[1], name: match[2] }));
  const matches = identities.filter(
    (item) =>
      item.sha1.toLowerCase() === identity.toLowerCase() ||
      item.name === identity,
  );
  if (matches.length !== 1)
    throw Error(
      `指定钥匙串中没有唯一匹配的代码签名身份“${identity}”；请运行 security find-identity -p codesigning ${keychain}`,
    );
  const selected = matches[0];
  const pem = capture("security", ["find-certificate", "-a", "-p", keychain]);
  const certificates =
    pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  const certificate = certificates
    .map((value) => new X509Certificate(value))
    .find(
      (value) =>
        value.fingerprint.replaceAll(":", "").toLowerCase() ===
        selected.sha1.toLowerCase(),
    );
  if (!certificate) throw Error("无法从指定钥匙串读取所选签名证书");
  return {
    identity: selected.sha1,
    authority: selected.name,
    keychain,
    certificateSha256: certificate.fingerprint256
      .replaceAll(":", "")
      .toLowerCase(),
  };
}
const signing = await signingConfiguration();
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
      signing: {
        type: "self-signed-local",
        certificateSha256: signing.certificateSha256,
      },
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
    signing: {
      type: "self-signed-local",
      identity: signing.authority,
      certificateSha256: signing.certificateSha256,
    },
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
      identity: signing.identity,
      keychain: signing.keychain,
      // The dedicated local certificate is intentionally not a system trust root.
      // Exact certificate extraction and strict verification below validate output.
      identityValidation: false,
      preAutoEntitlements: false,
      gatekeeperAssess: false,
      optionsForFile: () => ({
        entitlements,
        hardenedRuntime: false,
        timestamp: "none",
      }),
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
  const certificatePrefix = join(temporary, "signed-certificate-");
  capture(
    "codesign",
    ["-d", `--extract-certificates=${certificatePrefix}`, app],
    "combined",
  );
  const signedCertificateSha256 = digest(
    await readFile(certificatePrefix + "0"),
  );
  if (signedCertificateSha256 !== signing.certificateSha256)
    throw Error("安装包实际签名证书与所选稳定身份不一致");
  const signatureDetails = capture(
    "codesign",
    ["-d", "--verbose=4", app],
    "combined",
  );
  const cdhash = signatureDetails.match(/^CDHash=(\w+)$/m)?.[1];
  const requirementOutput = capture("codesign", ["-d", "-r-", app], "combined");
  const designatedRequirement = requirementOutput
    .match(/^designated => (.+)$/m)?.[1]
    ?.trim();
  if (
    !cdhash ||
    !designatedRequirement ||
    !designatedRequirement.includes('identifier "work.ydev.ytriple"') ||
    !["root", "leaf"].some((position) => designatedRequirement.includes(
      `certificate ${position} = H"${signing.identity.toLowerCase()}"`,
    ))
  )
    throw Error("无法读取安装包签名标识");
  const imageRoot = join(temporary, "image");
  await mkdir(imageRoot);
  await cp(app, join(imageRoot, "ytriple.app"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await symlink("/Applications", join(imageRoot, "Applications"));
  await writeFile(
    join(imageRoot, "安装说明.txt"),
    `ytriple ${pkg.version} · Apple Silicon\n\n将 ytriple.app 拖到 Applications 后打开。升级前从设置备份工作空间，完全退出应用后替换应用本身，数据保留在 ~/Library/Application Support/ytriple/desktop-v1。旧版父目录不自动迁移。\n\n此包为本机开发验证版本，采用本机固定的自签名代码签名身份，未完成 Apple 公证，不作为已通过公网分发验收的版本。不需要降低 macOS 安全设置。首次从旧 ad-hoc 包替换时，钥匙串可能要求一次迁移授权。\n\n构建：${buildId}\n`,
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
    signing: {
      ...manifest.signing,
      cdhash,
      designatedRequirement,
    },
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
        signing: output.signing,
        notarized: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
