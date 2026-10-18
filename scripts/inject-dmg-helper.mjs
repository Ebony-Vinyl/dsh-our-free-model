// 把「绕过签名」脚本与说明注入进 Tauri 构建好的 .dmg 根目录，让用户挂载后
// 能直接双击「修复签名.command」。
//
// 关键点：Tauri 打完 dmg 会删掉中间的 .app，且 macOS 对 APFS dmg 常常忽略
// -mountpoint（会挂到 /Volumes/<卷名>）。因此这里不用 -mountpoint，而是用
// `hdiutil attach -plist` 解析出真实挂载点，从挂载的 dmg 里把 App 拷出来，
// 连同 Applications 软链和卷标一起，重新打成 UDZO dmg。任何失败都保留原始 dmg。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const repo = path.resolve(".");
const bundleDir = path.join(repo, "packages/desktop/src-tauri/target/release/bundle");
const dmgDir = path.join(bundleDir, "dmg");
const icns = path.join(repo, "packages/desktop/src-tauri/icons", "icon.icns");
const helperSrc = path.join(repo, "packages/desktop/src-tauri/helper");
const version = JSON.parse(
  fs.readFileSync(path.join(repo, "packages/desktop/package.json"), "utf8"),
).version;
const VOL = "Our Free Model";

const dmgs = fs.existsSync(dmgDir)
  ? fs.readdirSync(dmgDir).filter((f) => f.endsWith(".dmg"))
  : [];
if (dmgs.length === 0) {
  console.error("inject-dmg-helper: 未找到 .dmg，跳过");
  process.exit(0);
}
const dmg = path.join(dmgDir, dmgs[0]);
if (!fs.existsSync(icns) || !fs.existsSync(helperSrc)) {
  console.error("inject-dmg-helper: 缺 icns 或 helper 目录，跳过");
  process.exit(0);
}

const detachIfMounted = () => {
  try {
    execFileSync("hdiutil", ["detach", `/Volumes/${VOL}`, "-force"], {
      stdio: "ignore",
    });
  } catch {}
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-dmg-out-"));
const stage = path.join(tmp, "stage");
fs.mkdirSync(stage, { recursive: true });
try {
  detachIfMounted();
  // 用 -plist 拿到真实挂载点，规避 -mountpoint 被忽略的问题
  const plist = execFileSync("hdiutil", ["attach", dmg, "-nobrowse", "-plist"], {
    encoding: "utf8",
  });
  const m = plist.match(
    /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/,
  );
  const mount = m ? m[1] : null;
  if (!mount || !fs.existsSync(mount)) {
    throw new Error("无法解析 dmg 挂载点");
  }

  // 拷贝 dmg 根内容（App + Applications 软链 + 既有卷标）。注意：必须用
  // `mount/.` 结尾拷贝「内容」，path.join 会把 "." 规范化掉导致整卷被套一层。
  execFileSync("cp", ["-R", `${mount}/.`, stage]);
  // 确保拉装软链存在（Tauri 一般已带；没有就补一个）
  const appsLink = path.join(stage, "Applications");
  if (!fs.existsSync(appsLink)) {
    try { fs.symlinkSync("/Applications", appsLink); } catch {}
  }
  // 覆盖为我们的圆角卷图标
  fs.copyFileSync(icns, path.join(stage, ".VolumeIcon.icns"));
  try { execFileSync("SetFile", ["-a", "C", stage], { stdio: "ignore" }); } catch {}
  // 注入 helper（可执行）
  for (const f of fs.readdirSync(helperSrc)) {
    const dest = path.join(stage, f);
    fs.copyFileSync(path.join(helperSrc, f), dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
  }

  detachIfMounted();
  const outTmp = path.join(tmp, "out.dmg");
  execFileSync("hdiutil", [
    "create", "-volname", VOL, "-srcfolder", stage, "-ov", "-format", "UDZO", outTmp,
  ], { stdio: "ignore" });
  fs.copyFileSync(outTmp, dmg);
  console.log(`inject-dmg-helper: 已在 ${dmg} 注入 helper + 圆角卷标`);
} catch (e) {
  console.error("inject-dmg-helper: 失败，保留原始 dmg ——", e?.message ?? e);
  process.exit(0);
} finally {
  detachIfMounted();
}
