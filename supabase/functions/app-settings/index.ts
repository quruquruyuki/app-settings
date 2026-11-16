// 共通設定（app_settings）の管理ページ用 Edge Function
// action: list（一覧） / update（1件更新） / refresh_fx（ドル円を今すぐ取り直す） / check_models（新しいモデルを今すぐ確認）
// ログインした ALLOWED_EMAIL のアカウントだけが使える。書き込みはこの関数（service role）経由のみ
// 使うシークレット: ALLOWED_EMAIL（他のアプリと共用）

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

// ログイン中のユーザーが ALLOWED_EMAIL 本人かを確かめる
async function isAllowedUser(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: ANON } });
  if (!r.ok) return false;
  const u = await r.json();
  const allowed = (Deno.env.get("ALLOWED_EMAIL") ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  return !!u.email && allowed.includes(String(u.email).toLowerCase());
}

// 値のチェック（打ち間違いで各アプリが止まらないように）
function validate(app: string, key: string, value: unknown): string | null {
  if (app === "global" && key === "usd_jpy") {
    return typeof value === "number" && value > 50 && value < 500 ? null : "ドル円は 50〜500 の数字にしてください";
  }
  if (app === "global" && key === "prices") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "料金表の形式が正しくありません";
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.endsWith("_per_min")) { if (typeof v !== "number" || v < 0) return `${k} は 0 以上の数字にしてください`; continue; }
      const p = v as Record<string, unknown>;
      if (!p || typeof p !== "object" || typeof p.in !== "number" || typeof p.out !== "number") return `${k} には in と out の数字が必要です`;
    }
    return null;
  }
  if (key.endsWith("model") || key.endsWith("model_hq")) {
    return typeof value === "string" && /^[A-Za-z0-9._:\-]{2,80}$/.test(value.trim()) ? null : "モデル名は英数字と . _ - : だけで書いてください";
  }
  return "この項目はここからは変更できません";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ対応" }, 405);
  if (!(await isAllowedUser(req))) return json({ error: "ログインし直してください" }, 401);
  try {
    const body = await req.json().catch(() => ({}));

    if (body.action === "list") {
      const r = await rest("app_settings?select=app,key,value,note,updated_at&order=app.asc,key.asc");
      if (!r.ok) throw new Error(`読み込めませんでした (${r.status})`);
      return json({ settings: await r.json() });
    }

    if (body.action === "update") {
      const app = String(body.app ?? ""), key = String(body.key ?? "");
      const value = typeof body.value === "string" ? body.value.trim() : body.value;
      const bad = validate(app, key, value);
      if (bad) return json({ error: bad }, 400);
      const q = `app_settings?app=eq.${encodeURIComponent(app)}&key=eq.${encodeURIComponent(key)}`;
      const r = await rest(q, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
      });
      const rows = r.ok ? await r.json() : [];
      if (!r.ok) throw new Error(`保存できませんでした (${r.status})`);
      if (!rows.length) return json({ error: "その項目は登録されていません" }, 404); // 新しい項目はここからは作らない
      return json({ setting: rows[0] });
    }

    if (body.action === "refresh_fx") {
      const r = await fetch(`${SB_URL}/functions/v1/update-fx`, { method: "POST", body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `取り直せませんでした (${r.status})`);
      return json(d);
    }

    if (body.action === "check_models") {
      const r = await fetch(`${SB_URL}/functions/v1/check-models`, { method: "POST", body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `確認できませんでした (${r.status})`);
      return json(d);
    }

    return json({ error: "不明な処理" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
