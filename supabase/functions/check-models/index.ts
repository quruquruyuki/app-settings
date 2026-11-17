// AIモデルの新しい版を探す Edge Function（pg_cron から週1回。管理ページの「今すぐ確認」からも呼ばれる）
// - Anthropic / OpenAI / Google の「使えるモデルの一覧」（無料）を取り、共通設定のモデルと比べる
// - 同じ系統でより新しい版があれば「候補」として記録するだけ（切り替えは管理ページでボタンを押したとき）
// - 使っているモデルが一覧から消えた（提供終了）ときだけ、止まらないように一番新しい候補へ自動で切り替える
// 結果は app_settings の system / model_check に保存する
// 使うシークレット: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY（ないものはその会社だけ確認しない）

const norm = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, "");
function env(name: string): string {
  for (const [k, v] of Object.entries(Deno.env.toObject())) if (norm(k) === norm(name)) return v.trim().replace(/^["']|["']$/g, "").trim();
  return "";
}
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Provider = "anthropic" | "openai" | "google";
const providerOf = (m: string): Provider | null =>
  m.startsWith("claude-") ? "anthropic" : m.startsWith("gemini-") ? "google" : /^(gpt-|o\d|whisper)/.test(m) ? "openai" : null;

// ── 各社のモデル一覧 ──
async function listModels(p: Provider): Promise<string[]> {
  if (p === "anthropic") {
    const key = env("ANTHROPIC_API_KEY"); if (!key) throw new Error("ANTHROPIC_API_KEY なし");
    const ids: string[] = []; let after = "";
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${after}` : ""}`,
        { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      if (!r.ok) throw new Error(`Anthropic ${r.status}`);
      const d = await r.json();
      ids.push(...(d.data ?? []).map((x: any) => String(x.id)));
      if (!d.has_more) break; after = d.last_id;
    }
    return ids;
  }
  if (p === "openai") {
    const key = env("OPENAI_API_KEY"); if (!key) throw new Error("OPENAI_API_KEY なし");
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    return ((await r.json()).data ?? []).map((x: any) => String(x.id));
  }
  const key = env("GEMINI_API_KEY"); if (!key) throw new Error("GEMINI_API_KEY なし");
  const ids: string[] = []; let token = "";
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${token}` : ""}`,
      { headers: { "x-goog-api-key": key } });
    if (!r.ok) throw new Error(`Google ${r.status}`);
    const d = await r.json();
    ids.push(...(d.models ?? []).map((x: any) => String(x.name).replace(/^models\//, "")));
    if (!d.nextPageToken) break; token = d.nextPageToken;
  }
  return ids;
}

// ── 「系統」と「版」に分ける ──
// claude-sonnet-5-5 → 系統 claude-sonnet ／ 版 [5,5]、gemini-3.5-flash → gemini-flash ／ [3,5]、gpt-6-luna → gpt-luna ／ [6]
// 日付つきのスナップショット（20260805、2025-12-15 など）は候補にしない
function parse(id: string) {
  const parts = id.split("-");
  if (parts.some((t) => /^\d{6,}$/.test(t))) return null;
  if (/-\d{4}-\d{2}-\d{2}$/.test(id)) return null; // gpt-4o-mini-tts-2025-12-15 のような日付つきの固定版も候補にしない
  const nums: number[] = [], words: string[] = [];
  for (const t of parts) {
    if (/^\d+(\.\d+)*$/.test(t)) nums.push(...t.split(".").map(Number));
    else words.push(t);
  }
  return { family: words.join("-"), version: nums };
}
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};


// ── 料金表にない新しいモデルの単価を、公式の料金ページから調べる（AIのウェブ検索。単価のないモデルが出たときだけ・1回数円）──
// 結果は「候補」。出典のリンクを付けて管理ページに出し、反映ボタンを押したときに料金表へ入る
async function lookupPrice(model: string): Promise<Record<string, unknown> | null> {
  const key = env("ANTHROPIC_API_KEY"); if (!key) return null;
  const site = model.startsWith("claude-") ? "Anthropic（docs.claude.com / anthropic.com）"
    : model.startsWith("gemini-") ? "Google（ai.google.dev）" : "OpenAI（openai.com / platform.openai.com）";
  const prompt = `API model "${model}" の公式の料金を、${site} の料金ページで調べてください。
次のJSONだけを返してください（前後に文章を付けない）。見つからない・確信がないときは {"found": false}。
- トークン課金なら {"found": true, "type": "tokens", "in": 入力の米ドル/100万トークン, "out": 出力の米ドル/100万トークン, "ain": 音声入力の米ドル/100万トークン（あれば。なければ null）, "url": "参考にした公式ページのURL"}
- 音声の分課金なら {"found": true, "type": "per_min", "usd": 1分あたりの米ドル, "url": "参考にした公式ページのURL"}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-5-5", max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const seen = new Set<string>();
    for (const b of d.content ?? []) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const x of b.content) if (x.url) seen.add(x.url);
    const text = (d.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
    const x = JSON.parse(m[0]);
    if (!x.found) return null;
    const url = typeof x.url === "string" && seen.has(x.url) ? x.url : null; // 実際に見たページだけを出典にする
    const ok = (n: unknown) => typeof n === "number" && n >= 0 && n < 1000;
    if (x.type === "per_min" && ok(x.usd) && x.usd < 1) return { type: "per_min", usd: x.usd, url };
    if (x.type === "tokens" && ok(x.in) && ok(x.out)) return { type: "tokens", in: x.in, out: x.out, ain: ok(x.ain) ? x.ain : null, url };
  } catch (e) { console.error("lookupPrice", model, e); }
  return null;
}

Deno.serve(async () => {
  const r = await rest("app_settings?select=app,key,value&or=(key.like.*model,key.like.*model_hq)");
  if (!r.ok) return json({ error: `設定を読めません (${r.status})` }, 500);
  const settings = (await r.json()) as { app: string; key: string; value: string }[];
  const prices = await rest("app_settings?select=value&app=eq.global&key=eq.prices").then((x) => x.json()).then((x) => x?.[0]?.value ?? {}).catch(() => ({}));

  const prev = await rest("app_settings?select=value&app=eq.system&key=eq.model_check").then((x) => x.json()).then((x) => x?.[0]?.value ?? {}).catch(() => ({}));
  const priceCache: Record<string, unknown> = {};
  for (const it of prev.items ?? []) for (const [k, v] of Object.entries(it.suggestedPrices ?? {})) if (v) priceCache[k] = v;

  // 使っている会社の一覧だけ取る
  const lists: Partial<Record<Provider, string[]>> = {};
  const errors: string[] = [];
  for (const p of new Set(settings.map((s) => providerOf(String(s.value))).filter(Boolean)) as Set<Provider>) {
    try { lists[p] = await listModels(p); } catch (e) { errors.push(String((e as Error).message ?? e)); }
  }

  const items = [];
  for (const s of settings) {
    const current = String(s.value);
    const p = providerOf(current);
    const list = p ? lists[p] : undefined;
    if (!p || !list) continue;
    const me = parse(current);
    const candidates = me
      ? [...new Set(list)]
        .map((id) => ({ id, v: parse(id) }))
        .filter((x) => x.v && x.v.family === me.family && newer(x.v.version, me.version))
        .sort((a, b) => (newer(a.v!.version, b.v!.version) ? -1 : 1))
        .slice(0, 3).map((x) => x.id)
      : [];
    // 一覧が十分に取れているのに今のモデルが無い＝提供終了とみなす
    const retired = list.length > 10 && !list.includes(current);
    let status = candidates.length ? "update" : "ok";
    let switchedTo: string | null = null;
    if (retired && candidates.length) {
      switchedTo = candidates[0];
      await rest(`app_settings?app=eq.${encodeURIComponent(s.app)}&key=eq.${encodeURIComponent(s.key)}`, {
        method: "PATCH", body: JSON.stringify({ value: switchedTo, updated_at: new Date().toISOString() }),
      });
      status = "switched";
    } else if (retired) status = "retired";
    if (status === "ok") continue;
    const noPrice = (m: string | undefined) => !!m && !(m in prices) && !(`${m}_per_min` in prices);
    // 料金表にない候補は単価を調べる（前回の確認で調べ済みなら使い回す）
    const suggestedPrices: Record<string, unknown> = {};
    for (const c of candidates.filter(noPrice)) {
      suggestedPrices[c] = c in priceCache ? priceCache[c] : (priceCache[c] = await lookupPrice(c));
    }
    items.push({ app: s.app, key: s.key, current, candidates, status, switchedTo, suggestedPrices });
  }

  const result = { checked_at: new Date().toISOString(), items, errors };
  await rest("app_settings", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ app: "system", key: "model_check", value: result, note: "モデルの新しい版の確認結果（check-models が週1回更新）", updated_at: result.checked_at }),
  });
  return json(result);
});
