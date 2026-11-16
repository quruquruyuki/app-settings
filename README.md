# 共通設定（app-settings）

自作アプリ（議事録・Notion Quick・酒ログ・日記）で共通に使う設定を、スマホから見て・変えるためのページです。

- AIモデル：アプリごとに、どのモデルを使うか
- 為替レート：料金表示に使う1ドル＝何円（毎朝自動更新、「今すぐ取り直す」も可）
- 料金の単価：料金表示の計算に使うモデルごとの単価

## しくみ

- 設定は Supabase（quruquruyuki's Project）の `app_settings` テーブルにある
- 各アプリの Edge Function はこのテーブルからモデルを読む（1分キャッシュ）
- このページは Edge Function `app-settings` 経由で読み書きする。ログインできるのは `ALLOWED_EMAIL` のアカウントだけ
- 変更できるのは、すでに登録されている項目だけ（新しい項目はSQLで追加する）
- ドル円は Edge Function `update-fx` が毎朝 9:07（JST）に自動更新する（pg_cron）

## ファイル

- `index.html` … 管理ページ（GitHub Pages で公開）
- `supabase/functions/app-settings/index.ts` … 読み書き用の Edge Function
