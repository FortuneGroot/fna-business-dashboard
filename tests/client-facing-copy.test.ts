import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { sanitizeClientFacingCopy, syncWaitingNote } from "../src/lib/ui/sync-copy";
import { CLIENT_FORBIDDEN_RENDER_TERMS } from "./helpers/forbidden-terms";
import emails from "../src/content/emails.json";
import sms from "../src/content/sms.json";
import alerts from "../src/content/alerts.json";

const ROOT = join(process.cwd(), "src");

const KNOWN_ROUTES = new Set([
  "/dashboard",
  "/inbox",
  "/contacts",
  "/pipeline",
  "/calendar",
  "/tasks",
  "/automations",
  "/marketing",
  "/reviews",
  "/payments",
  "/reporting",
  "/settings",
  "/help",
  "/support",
  "/library",
  "/training",
  "/onboarding",
  "/privacy",
  "/terms",
  "/login",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("client-facing copy hygiene", () => {
  it("syncWaitingNote avoids subject-verb grammar bugs", () => {
    const note = syncWaitingNote("contacts");
    assert.equal(/No contacts has\b/i.test(note), false);
    assert.match(note, /Nothing received for contacts yet/i);
  });

  it("library headings never expose EMAIL-/SMS-/ALERT- template IDs", () => {
    const text = readFileSync(join(ROOT, "app", "(protected)", "library", "page.tsx"), "utf8");
    const visible = text
      .replace(/key=\{[^}]+\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.match(visible, /clientFacingTitle/);
    assert.equal(/<h3[^>]*>\{[esa]\.id\}/.test(visible), false);
  });

  it("sanitizeClientFacingCopy strips CRM merge tokens", () => {
    const raw =
      "Hello [[CV:Business Name]] book [[CV:Booking URL]] at [[APPT:Start]] {{CLIENT_BUSINESS_NAME}}";
    const clean = sanitizeClientFacingCopy(raw);
    assert.equal(clean.includes("[[CV:"), false);
    assert.equal(clean.includes("[[APPT:"), false);
    assert.equal(clean.includes("{{"), false);
    assert.match(clean, /\[Business Name\]/);
  });

  it("library content is clean after sanitization", () => {
    const blobs = [
      ...emails.map((e) => `${e.subject}\n${e.body}`),
      ...sms.map((s) => s.text),
      ...alerts.map((a) => a.body),
    ].map(sanitizeClientFacingCopy);
    for (const term of CLIENT_FORBIDDEN_RENDER_TERMS) {
      for (const blob of blobs) {
        assert.equal(
          blob.includes(term),
          false,
          `sanitized library still contains forbidden term: ${term}`
        );
      }
    }
  });

  it("protected UI sources contain no forbidden render terms", () => {
    const files = [
      ...walk(join(ROOT, "app", "(protected)")),
      ...walk(join(ROOT, "components")),
      ...walk(join(ROOT, "app", "login")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const term of CLIENT_FORBIDDEN_RENDER_TERMS) {
        if (code.includes(term)) {
          offenders.push(`${relative(process.cwd(), file)} :: ${term}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("internal hrefs on protected pages and chrome resolve to known routes", () => {
    const files = [
      ...walk(join(ROOT, "app", "(protected)")),
      join(ROOT, "components", "Sidebar.tsx"),
      join(ROOT, "components", "Chrome.tsx"),
      join(ROOT, "components", "PlaceholderSurface.tsx"),
      join(ROOT, "components", "ui.tsx"),
      join(ROOT, "app", "(protected)", "dashboard", "page.tsx"),
    ];
    const missing: string[] = [];
    const hrefRe = /(?:href)=\{?["'](\/[^"'?#]+)/g;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      const re = new RegExp(hrefRe.source, "g");
      while ((m = re.exec(text))) {
        const href = m[1];
        if (href.startsWith("/api/")) continue;
        if (href.startsWith("/#")) continue;
        if (!KNOWN_ROUTES.has(href)) {
          missing.push(`${relative(process.cwd(), file)} -> ${href}`);
        }
      }
    }
    assert.deepEqual(missing, [], missing.join("\n"));
  });

  it("protected UI sources contain no preview hosts or NEXT_PUBLIC privileged env", () => {
    const files = [
      ...walk(join(ROOT, "app", "(protected)")),
      ...walk(join(ROOT, "components")),
      join(ROOT, "app", "login", "page.tsx"),
    ];
    for (const file of files) {
      const text = stripComments(readFileSync(file, "utf8"));
      assert.equal(/vercel\.app/i.test(text), false, `preview host in ${relative(ROOT, file)}`);
      assert.equal(
        /NEXT_PUBLIC_(SUPABASE|AUTH|GHL|SERVICE)/i.test(text),
        false,
        `public privileged env in ${relative(ROOT, file)}`
      );
    }
  });
});
