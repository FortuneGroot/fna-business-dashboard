// UI-2: visual diff of every page against docs/baseline/screenshots/ for the same empty-workspace
// state. Runs only against a disposable local Supabase stack and the locally built app. Uses an
// installed or cached playwright-core plus a downloaded Chromium; when either is missing it reports
// BLOCKED (exit 2) instead of passing.
//
//   node --import tsx tests/visual/ui2-visual-parity.ts [--out <dir>]
//
// Output: one PNG screenshot and one diff PNG per page, plus report.json, in the output directory
// (default: <os tmp>/fna-ui2). Nothing is written inside the repository.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adminDb, appLogin, rpc, signUp, startApp, startStack, upgradeToAal2, type App, type Stack,
} from "../supabase-stack/stack";

const ROOT = join(__dirname, "..", "..");
const BASELINE_DIR = join(ROOT, "docs", "baseline", "screenshots");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(tmpdir(), "fna-ui2");
const VIEWPORT = { width: 1440, height: 900 };
const BUSINESS_NAME = "Fortune & Automations";
const CHANNEL_TOLERANCE = 40;

const ROUTES: Record<string, string> = {
  "00-login": "/login", "01-dashboard": "/dashboard", "02-inbox": "/inbox", "03-contacts": "/contacts",
  "04-pipeline": "/pipeline", "05-calendar": "/calendar", "06-tasks": "/tasks", "07-automations": "/automations",
  "08-marketing": "/marketing", "09-reviews": "/reviews", "10-payments": "/payments", "11-reporting": "/reporting",
  "12-settings": "/settings", "13-onboarding": "/onboarding", "14-help": "/help", "15-library": "/library",
  "16-support": "/support", "17-training": "/training", "18-privacy": "/privacy", "19-terms": "/terms",
};

/** Regions of the 1440×900 first screen that hold the shared chrome. */
const REGIONS = {
  sidebar: { x: 0, y: 0, w: 262, h: 900 },
  topbar: { x: 262, y: 0, w: 1178, h: 64 },
};

class Blocked extends Error {}

function loadPlaywright(): any {
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_CORE_PATH) candidates.push(process.env.PLAYWRIGHT_CORE_PATH);
  candidates.push(join(ROOT, "node_modules", "playwright-core"));
  const npx = join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx");
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) candidates.push(join(npx, d, "node_modules", "playwright-core"));
  }
  const req = createRequire(__filename);
  for (const dir of candidates) {
    if (existsSync(join(dir, "package.json"))) {
      try {
        return { pw: req(dir), dir };
      } catch {
        /* try the next one */
      }
    }
  }
  throw new Blocked("playwright-core is not installed or cached locally.");
}

function chromiumExecutable(): string | undefined {
  const base = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
    for (const sub of ["chrome-win64", "chrome-win"]) {
      const exe = join(base, d, sub, "chrome.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

type RegionDiff = { pixels: number; differing: number; ratio: number };
type PageResult = {
  name: string; route: string; status: number | null; baselineSize: string; currentSize: string;
  overall: RegionDiff; sidebar: RegionDiff; topbar: RegionDiff;
};

/** Decodes both PNGs in the browser and counts pixels whose largest channel delta exceeds the tolerance. */
async function diffInBrowser(page: any, baseline: Buffer, current: Buffer) {
  return page.evaluate(
    async ({ a, b, tol, regions }: { a: string; b: string; tol: number; regions: typeof REGIONS }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.max(ia.width, ib.width);
      const h = Math.max(ia.height, ib.height);
      const pixels = (img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#ff00ff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const pa = pixels(ia);
      const pb = pixels(ib);
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const octx = out.getContext("2d")!;
      const diff = octx.createImageData(w, h);
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        const delta = Math.max(Math.abs(pa[o] - pb[o]), Math.abs(pa[o + 1] - pb[o + 1]), Math.abs(pa[o + 2] - pb[o + 2]));
        const grey = Math.round((pa[o] + pa[o + 1] + pa[o + 2]) / 3);
        if (delta > tol) {
          mask[i] = 1;
          diff.data.set([255, 0, 0, 255], o);
        } else {
          diff.data.set([grey, grey, grey, 70], o);
        }
      }
      octx.putImageData(diff, 0, 0);
      const count = (r: { x: number; y: number; w: number; h: number }) => {
        let n = 0;
        let d = 0;
        for (let y = r.y; y < Math.min(r.y + r.h, h); y++) {
          for (let x = r.x; x < Math.min(r.x + r.w, w); x++) {
            n++;
            d += mask[y * w + x];
          }
        }
        return { pixels: n, differing: d, ratio: n ? d / n : 0 };
      };
      return {
        baselineSize: `${ia.width}x${ia.height}`,
        currentSize: `${ib.width}x${ib.height}`,
        overall: count({ x: 0, y: 0, w, h }),
        sidebar: count(regions.sidebar),
        topbar: count(regions.topbar),
        diffPng: out.toDataURL("image/png"),
      };
    },
    {
      a: `data:image/png;base64,${baseline.toString("base64")}`,
      b: `data:image/png;base64,${current.toString("base64")}`,
      tol: CHANNEL_TOLERANCE,
      regions: REGIONS,
    }
  );
}

async function main() {
  const { pw, dir } = loadPlaywright();
  const executablePath = chromiumExecutable();
  if (!executablePath) throw new Blocked("No downloaded Chromium found under %LOCALAPPDATA%\\ms-playwright.");
  mkdirSync(OUT, { recursive: true });
  console.log(`playwright-core: ${JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version}`);

  let stack: Stack | undefined;
  let app: App | undefined;
  let browser: any;
  try {
    stack = startStack();
    const { env } = stack;
    const run = Date.now().toString(36);
    const db = await adminDb(env);
    const platform = await signUp(env, `ui2-platform-${run}@example.test`, "UI2 Platform");
    await db.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
    await db.end();
    const platformAal2 = await upgradeToAal2(env, platform);
    const owner = await signUp(env, `ui2-owner-${run}@example.test`, "UI2 Owner");
    const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
      p_provisioning_key: `ui2-${run}`, p_name: BUSINESS_NAME, p_slug: `ui2-${run}`, p_owner_email: owner.email,
    });
    if (prov.status !== 200) throw new Error(`provisioning failed: ${prov.status}`);
    const accepted = await rpc(env, owner.token, "accept_invitation", { p_token: prov.body.invite_token });
    if (accepted.status !== 200) throw new Error(`invitation acceptance failed: ${accepted.status}`);

    app = await startApp(env);
    const cookie = await appLogin(app, owner);
    const cookies = cookie.split("; ").map((pair) => {
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), url: app!.url };
    });

    browser = await pw.chromium.launch({ executablePath, headless: true });
    const anon = await browser.newContext({ viewport: VIEWPORT });
    const authed = await browser.newContext({ viewport: VIEWPORT });
    await authed.addCookies(cookies);
    const differ = await (await browser.newContext()).newPage();
    // tsx compiles nested functions with esbuild's __name helper, which the browser page lacks.
    await differ.evaluate("window.__name = (f) => f");

    const results: PageResult[] = [];
    for (const [name, route] of Object.entries(ROUTES)) {
      const page = await (name === "00-login" ? anon : authed).newPage();
      const res = await page.goto(`${app.url}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      const shot: Buffer = await page.screenshot({ fullPage: true });
      await page.close();
      writeFileSync(join(OUT, `${name}.png`), shot);
      const d = await diffInBrowser(differ, readFileSync(join(BASELINE_DIR, `${name}.png`)), shot);
      writeFileSync(join(OUT, `${name}.diff.png`), Buffer.from(d.diffPng.split(",")[1], "base64"));
      const r: PageResult = {
        name, route, status: res?.status() ?? null, baselineSize: d.baselineSize, currentSize: d.currentSize,
        overall: d.overall, sidebar: d.sidebar, topbar: d.topbar,
      };
      results.push(r);
      const pct = (x: RegionDiff) => `${(x.ratio * 100).toFixed(2)}%`;
      console.log(`${name.padEnd(15)} ${String(r.status).padEnd(4)} base ${r.baselineSize.padEnd(10)} now ${r.currentSize.padEnd(10)} ` +
        `overall ${pct(r.overall).padStart(7)}  sidebar ${pct(r.sidebar).padStart(7)}  topbar ${pct(r.topbar).padStart(7)}`);
    }
    writeFileSync(join(OUT, "report.json"), JSON.stringify({ viewport: VIEWPORT, tolerance: CHANNEL_TOLERANCE, results }, null, 2));
    console.log(`output: ${OUT}`);
  } finally {
    await browser?.close().catch(() => undefined);
    app?.stop();
    stack?.stop();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    if (err instanceof Blocked || err?.name === "BlockedError") {
      console.log(`BLOCKED: ${err.message}`);
      process.exit(2);
    }
    console.error(`FAILED: ${err?.message ?? err}`);
    process.exit(1);
  }
);
