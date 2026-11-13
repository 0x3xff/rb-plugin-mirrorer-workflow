#!/usr/bin/env node
/**
 * Roblox plugin mirror / updater.
 *
 * For every asset listed in plugins.json:
 *   1. confirms the authenticated account owns it,
 *   2. downloads the asset (.rbxm / .rbxmx) through assetdelivery,
 *   3. writes it into the repo only when its bytes actually changed,
 *   4. records name / hash / size / timestamps in plugins.lock.json.
 *
 * Assets the account does not own are reported and skipped, unless
 * ACQUIRE_FREE=1 and the asset currently costs nothing, in which case the
 * Creator Store "Get" request is sent first and ownership re-checked.
 *
 * Node.js 18+, no npm packages.
 *
 * Env:
 *   ROBLOSECURITY     .ROBLOSECURITY cookie value          (required)
 *   PLUGINS_FILE      manifest path       (default plugins.json)
 *   LOCK_FILE         lock path           (default plugins.lock.json)
 *   OUT_DIR           download folder     (default plugins)
 *   ASSET_IDS         extra comma/space separated asset IDs to include
 *   ACQUIRE_FREE=1    buy not-owned assets that are free
 *   DRY_RUN=1         check and report, write nothing
 *   BASE_DELAY_MS     minimum pause between requests (default 1200)
 *   DISCORD_WEBHOOK   optional webhook for the run summary
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const COOKIE = (process.env.ROBLOSECURITY || "").trim();
const PLUGINS_FILE = process.env.PLUGINS_FILE || "plugins.json";
const LOCK_FILE = process.env.LOCK_FILE || "plugins.lock.json";
const OUT_DIR = process.env.OUT_DIR || "plugins";
const EXTRA_IDS = (process.env.ASSET_IDS || "").split(/[\s,;]+/).filter((s) => /^\d+$/.test(s));
const ACQUIRE_FREE = process.env.ACQUIRE_FREE === "1" || process.env.ACQUIRE_FREE === "true";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const BASE_DELAY_MS = Number(process.env.BASE_DELAY_MS || 1200);
const WEBHOOK = (process.env.DISCORD_WEBHOOK || "").trim();

const DETAILS_URL = "https://apis.roblox.com/toolbox-service/v1/items/details";
const PURCHASE_URL = "https://apis.roblox.com/marketplace-fiat-service/v1/product/purchase";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0";

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));
const storeUrl = (id) => `https://create.roblox.com/store/asset/${id}`;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };

/* ------------------------------------------------------------------ */
/* HTTP layer: throttling, CSRF handshake, 429/5xx backoff             */
/* ------------------------------------------------------------------ */

let csrf = "";
let delayMs = BASE_DELAY_MS;
let pauseUntil = 0;

async function waitTurn() {
  await sleep(Math.max(0, pauseUntil - Date.now()) + jitter(delayMs));
}

async function api(url, { method = "GET", body, headers = {}, auth = true, maxRetries = 6, binary = false } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitTurn();

    const h = { "User-Agent": UA, Accept: "*/*", ...headers };
    if (auth && COOKIE) h.Cookie = `.ROBLOSECURITY=${COOKIE}`;
    if (method !== "GET") {
      h["x-csrf-token"] = csrf;
      h.Origin = "https://create.roblox.com";
      h.Referer = "https://create.roblox.com/";
    }

    let res;
    try {
      res = await fetch(url, { method, headers: h, body });
    } catch (e) {
      const wait = Math.min(60_000, 2000 * 2 ** attempt);
      log(`Network error (${e.message}); retrying in ${Math.round(wait / 1000)}s`);
      pauseUntil = Date.now() + wait;
      continue;
    }

    // The first state-changing call (or a stale token) answers 403 + a fresh token.
    const newToken = res.headers.get("x-csrf-token");
    if (res.status === 403 && newToken && newToken !== csrf) {
      csrf = newToken;
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(120_000, 3000 * 2 ** attempt);
      if (res.status === 429) delayMs = Math.min(30_000, delayMs * 2);
      pauseUntil = Date.now() + wait + jitter(500);
      log(`HTTP ${res.status} from ${new URL(url).pathname}; pausing ${Math.round(wait / 1000)}s`);
      continue;
    }

    delayMs = Math.max(BASE_DELAY_MS, delayMs * 0.9);
    if (binary) {
      return { status: res.status, ok: res.ok, buffer: Buffer.from(await res.arrayBuffer()) };
    }
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, json: tryParse(text) };
  }
  throw new Error(`gave up after repeated failures: ${url}`);
}

/* ------------------------------------------------------------------ */
/* Roblox operations                                                   */
/* ------------------------------------------------------------------ */

async function whoAmI() {
  const r = await api("https://users.roblox.com/v1/users/authenticated");
  if (!r.ok || !r.json?.id) {
    throw new Error(`cookie rejected (HTTP ${r.status}) - is the ROBLOSECURITY secret still valid?`);
  }
  return r.json;
}

async function itemDetails(assetId) {
  const r = await api(`${DETAILS_URL}?assetIds=${assetId}`);
  const item = r.json?.data?.[0];
  if (!r.ok || !item) return null;
  const fp = item.fiatProduct;
  const q = fp?.purchasePrice?.quantity;
  const amount = q ? q.significand * Math.pow(10, q.exponent) : 0;
  return {
    name: item.asset?.name || null,
    creator: item.creator?.name || null,
    updatedUtc: item.asset?.updatedUtc || item.asset?.updated || null,
    free: !fp || fp.isFree === true || amount === 0,
    price: fp ? `${amount} ${fp.purchasePrice?.currencyCode || "USD"}` : "free",
  };
}

// true / false / null (unknown)
async function isOwned(userId, assetId) {
  const r = await api(`https://inventory.roblox.com/v1/users/${userId}/items/Asset/${assetId}/is-owned`);
  if (!r.ok) return null;
  return r.json === true;
}

async function purchase(assetId) {
  const body = JSON.stringify({
    productKey: {
      productNamespace: "PRODUCT_NAMESPACE_CREATOR_MARKETPLACE_ASSET",
      productType: "PRODUCT_TYPE_PLUGIN",
      productTargetId: String(assetId),
    },
    // Pinned to 0: Roblox rejects the request if the asset is not actually free.
    expectedPrice: { currencyCode: "USD", quantity: { significand: 0, exponent: 0 } },
  });
  return api(PURCHASE_URL, { method: "POST", body, headers: { "Content-Type": "application/json" } });
}

// Owned plugin as an rbxm/rbxmx Buffer.
async function downloadAsset(assetId) {
  const r = await api(`https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`, { binary: true });
  let buf = r.buffer;
  if (!r.ok) {
    throw new Error(`download HTTP ${r.status}: ${buf.toString("utf8", 0, 160).replace(/\s+/g, " ")}`);
  }
  // Small JSON pointers to the CDN copy sometimes come back instead of the file.
  if (buf.length < 2000 && buf[0] === 0x7b) {
    const loc = tryParse(buf.toString("utf8"))?.location;
    if (!loc) throw new Error(`unexpected JSON response: ${buf.toString("utf8").slice(0, 160)}`);
    const res = await fetch(loc, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`CDN HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (buf.toString("latin1", 0, 7) !== "<roblox") {
    throw new Error("response is not an rbxm/rbxmx file");
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* Repo files                                                          */
/* ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// Accepts  ["123", 456]  or  [{ id, name? }]  or  { plugins: [...] }
function loadManifest() {
  const raw = readJson(PLUGINS_FILE, null);
  if (!raw && EXTRA_IDS.length === 0) {
    throw new Error(`no assets to check: ${PLUGINS_FILE} is missing or unreadable and ASSET_IDS is empty`);
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.plugins) ? raw.plugins : [];
  const out = new Map();
  for (const entry of list) {
    const e = typeof entry === "object" && entry !== null ? entry : { id: entry };
    const id = String(e.id ?? "").trim();
    if (!/^\d+$/.test(id)) {
      log(`Skipping manifest entry without a numeric id: ${JSON.stringify(entry)}`);
      continue;
    }
    out.set(id, { id, name: e.name ? String(e.name) : null });
  }
  for (const id of EXTRA_IDS) if (!out.has(id)) out.set(id, { id, name: null });
  if (out.size === 0) throw new Error("no valid asset IDs found");
  return [...out.values()];
}

const slug = (s) =>
  String(s || "plugin").normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plugin";

// Binary rbxm starts with "<roblox!", the XML form with "<roblox ...>".
const extFor = (buf) => (buf.toString("latin1", 0, 8) === "<roblox!" ? ".rbxm" : ".rbxmx");

function writeOutput(relPath, buf) {
  const full = path.join(process.cwd(), relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
}

function removeOutput(relPath) {
  try { fs.unlinkSync(path.join(process.cwd(), relPath)); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const results = [];
let hardFailures = 0;

async function handle(entry, me, lock) {
  const id = entry.id;
  const prev = lock.plugins[id] || null;
  const details = await itemDetails(id);
  const name = details?.name || entry.name || prev?.name || `asset-${id}`;
  const record = { id, name, status: "", note: "" };

  let owned = await isOwned(me.id, id);

  if (owned === false && ACQUIRE_FREE && !DRY_RUN && details?.free) {
    log(`not owned, free -> sending Get request | ${name} (${id})`);
    const r = await purchase(id);
    if (r.ok || /already\s*(owned|purchased)/i.test(r.text || "")) {
      owned = true;
      record.note = "acquired this run";
    } else {
      record.status = "purchase-failed";
      record.note = `HTTP ${r.status}: ${(r.text || "").slice(0, 120).replace(/\s+/g, " ")}`;
      log(`PURCHASE FAILED | ${name} (${id}) ${record.note}`);
      hardFailures++;
      results.push(record);
      return;
    }
  }

  if (owned === null) {
    record.status = "ownership-unknown";
    record.note = "inventory API did not answer; left untouched";
    log(`UNKNOWN | ${name} (${id}) - ownership check failed`);
    hardFailures++;
    results.push(record);
    return;
  }

  if (owned === false) {
    record.status = "not-owned";
    record.note = details ? `price ${details.price}` : "";
    log(`not owned | ${name} (${id}) ${record.note}`);
    results.push(record);
    return;
  }

  let buf;
  try {
    buf = await downloadAsset(id);
  } catch (e) {
    record.status = "download-failed";
    record.note = String(e.message).slice(0, 160);
    log(`DOWNLOAD FAILED | ${name} (${id}) ${record.note}`);
    hardFailures++;
    results.push(record);
    return;
  }

  const hash = sha256(buf);
  const file = path.posix.join(OUT_DIR, `${slug(name)}-${id}${extFor(buf)}`);
  const unchanged = !!prev && prev.sha256 === hash && prev.file === file && fs.existsSync(file);

  record.file = file;
  record.size = buf.length;
  record.sha256 = hash;

  if (unchanged) {
    record.status = "unchanged";
    log(`unchanged | ${name} (${id}) ${(buf.length / 1024).toFixed(1)} KB`);
  } else if (DRY_RUN) {
    record.status = prev ? "would-update" : "would-add";
    log(`${record.status} | ${name} (${id}) ${(buf.length / 1024).toFixed(1)} KB`);
  } else {
    if (prev?.file && prev.file !== file && removeOutput(prev.file)) {
      log(`renamed | ${prev.file} -> ${file}`);
    }
    writeOutput(file, buf);
    record.status = prev ? "updated" : "added";
    log(`${record.status.toUpperCase()} | ${name} (${id}) -> ${file} (${(buf.length / 1024).toFixed(1)} KB)`);
  }

  if (!DRY_RUN) {
    lock.plugins[id] = {
      id,
      name,
      creator: details?.creator || prev?.creator || null,
      file,
      size: buf.length,
      sha256: hash,
      assetUpdatedUtc: details?.updatedUtc || prev?.assetUpdatedUtc || null,
      firstSeen: prev?.firstSeen || new Date().toISOString(),
      lastChanged: unchanged ? prev.lastChanged : new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      storeUrl: storeUrl(id),
    };
  }
  results.push(record);
}

function writeSummary(me) {
  const changed = results.filter((r) => r.status === "added" || r.status === "updated");
  const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const headline = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" | ") || "nothing checked";

  const rows = results.map(
    (r) =>
      `| ${String(r.name).replace(/\|/g, "\\|").slice(0, 60)} | [${r.id}](${storeUrl(r.id)}) | ${r.status} | ${
        r.size ? (r.size / 1024).toFixed(1) + " KB" : ""
      } | ${(r.note || "").replace(/\|/g, "\\|")} |`
  );
  const md = [
    `## Plugin update${DRY_RUN ? " (dry run)" : ""}`,
    ``,
    `Account **${me.name}** (${me.id}) - ${headline}`,
    ``,
    `| Plugin | Asset | Status | Size | Note |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
  ].join("\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch {}
  }
  if (process.env.GITHUB_OUTPUT) {
    const title = changed.length
      ? `Update ${changed.length} plugin${changed.length === 1 ? "" : "s"}: ` +
        changed.map((r) => r.name).join(", ").slice(0, 120)
      : "No plugin changes";
    try {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `changed=${changed.length > 0 && !DRY_RUN}\n` +
          `changed_count=${changed.length}\n` +
          `failures=${hardFailures}\n` +
          `commit_title=${title.replace(/[\r\n]+/g, " ")}\n`
      );
    } catch {}
  }
  return { headline, changed };
}

async function postWebhook(content) {
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Plugin Updater",
        content: content.slice(0, 1900),
        allowed_mentions: { parse: [] },
      }),
    });
  } catch (e) {
    log(`Webhook post failed: ${e.message}`);
  }
}

async function main() {
  if (!COOKIE) {
    console.error("ROBLOSECURITY is empty. Add it as a repository secret and pass it to this step.");
    process.exit(1);
  }

  const entries = loadManifest();
  const lock = readJson(LOCK_FILE, null) || { updatedAt: null, plugins: {} };
  if (!lock.plugins || typeof lock.plugins !== "object") lock.plugins = {};

  const me = await whoAmI();
  log(`Logged in as ${me.name} (${me.id})`);
  log(
    `${entries.length} asset(s) to check | mode: ${DRY_RUN ? "DRY RUN" : "write"} | ` +
      `acquire free: ${ACQUIRE_FREE ? "on" : "off"}`
  );

  for (const entry of entries) {
    try {
      await handle(entry, me, lock);
    } catch (e) {
      hardFailures++;
      log(`ERROR on ${entry.id}: ${e.message}`);
      results.push({
        id: entry.id,
        name: entry.name || `asset-${entry.id}`,
        status: "error",
        note: String(e.message).slice(0, 160),
      });
    }
  }

  if (!DRY_RUN) {
    lock.updatedAt = new Date().toISOString();
    lock.account = { id: me.id, name: me.name };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + "\n");
  }

  const { headline, changed } = writeSummary(me);
  log(`Done: ${headline}`);

  if (changed.length || hardFailures) {
    await postWebhook(
      [
        changed.length ? `**${changed.length} plugin file(s) changed**` : `**${hardFailures} problem(s)**`,
        ...results
          .filter((r) => !["unchanged", "not-owned"].includes(r.status))
          .map((r) => `- \`${r.status}\` [${r.name}](${storeUrl(r.id)})${r.note ? ` - ${r.note}` : ""}`),
      ].join("\n")
    );
  }

  // Files and the lock are already on disk, so the commit step can still run.
  if (hardFailures) process.exit(2);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
