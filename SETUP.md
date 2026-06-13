# Photo Map App — セットアップガイド

撮影した写真を地図上で管理・共有するウェブアプリです。

## 構成

- **地図**: MapLibre GL JS（OpenStreetMapタイル、無料）
- **メタデータ**: Google Sheets
- **写真保存**: サーバーローカル（uploads/ + thumbnails/）
- **バックエンド**: Node.js + Express

---

## 1. 前提条件

- Node.js v18 以上
- Google アカウント
- Google Cloud Console へのアクセス

---

## 2. Google Sheets API の設定

### 2-1. Google Cloud プロジェクトの作成

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. 新しいプロジェクトを作成（例: `photo-map-app`）
3. 左メニュー → **APIとサービス** → **ライブラリ**
4. 「Google Sheets API」を検索して **有効にする**

### 2-2. サービスアカウントの作成

1. **APIとサービス** → **認証情報** → **認証情報を作成** → **サービスアカウント**
2. 名前を入力（例: `photo-map-sheets`）→ 作成
3. 作成したサービスアカウントをクリック → **キー** タブ → **鍵を追加** → **JSON**
4. ダウンロードしたJSONファイルを `credentials/service-account.json` として配置

```
credentials/
└── service-account.json   ← ここに置く（Gitには含まれません）
```

### 2-3. Google スプレッドシートの作成と共有

1. [Google スプレッドシート](https://sheets.google.com/) で新規シートを作成
2. シート名を **Photos** に変更（デフォルトの「シート1」から変更）
3. URLから スプレッドシートID をコピー  
   例: `https://docs.google.com/spreadsheets/d/【ここがID】/edit`
4. **共有** ボタン → サービスアカウントのメールアドレスを追加（編集者権限）  
   メールアドレスは `credentials/service-account.json` 内の `client_email` フィールドに記載

---

## 3. 環境変数の設定

`.env.example` をコピーして `.env` を作成:

```bash
cp .env.example .env
```

`.env` を編集:

```
GOOGLE_SHEET_ID=your_spreadsheet_id_here
PORT=3000
```

---

## 4. インストール・起動

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開く。

開発時（ファイル変更で自動再起動）:
```bash
npm run dev
```

---

## 5. テスト写真の追加

アプリ起動後、ブラウザ右下の **「＋ 写真を追加」** ボタンから写真を追加できます。

### 手動で追加する場合（例: nusantara.jpg）

1. フルサイズ写真を `uploads/nusantara.jpg` に配置
2. サムネイル（300px幅）を `thumbnails/nusantara.jpg` に配置  
   ImageMagick を使う場合:
   ```bash
   convert uploads/nusantara.jpg -resize 300x thumbnails/nusantara.jpg
   ```
3. アプリの「＋ 写真を追加」から通常通り入力して保存、または Google Sheets に直接行を追加

---

## 6. カテゴリー一覧

| カテゴリー | 用途 |
|---|---|
| お客様 | 顧客との写真 |
| 政府・当局関係者 | 政府・行政関係者との写真 |
| 内部 | 社内・内部向け |
| プライベート | 個人的な写真 |
| その他 | 上記に当てはまらないもの |

---

## 7. Google Sheets のデータ構造

アプリが自動でヘッダー行を作成します:

| A: id | B: filename | C: thumbnail | D: date | E: address | F: category | G: comment | H: lat | I: lng |
|---|---|---|---|---|---|---|---|---|

---

## 8. Cloudflare へのデプロイ

このアプリは Node.js サーバーが必要なため、**Cloudflare Workers** を使ってデプロイします。  
写真は **Cloudflare R2**（転送費用ゼロ）に保存します。

### 8-1. 前提条件

- ローカル PC に Node.js・npm がインストール済み
- Cloudflare アカウント（https://dash.cloudflare.com）

### 8-2. リポジトリをローカルにクローン

```bash
git clone https://github.com/nobunby-max/photo-map-app
cd photo-map-app
npm install
```

### 8-3. Wrangler CLI のインストールとログイン

```bash
npm install -g wrangler
wrangler login
```

ブラウザが開いて Cloudflare の認証ページが表示されます。  
**パスワードをターミナルやチャットに入力する必要はありません。**

### 8-4. Cloudflare R2 バケットの作成

```bash
wrangler r2 bucket create photo-map-uploads
wrangler r2 bucket create photo-map-thumbnails
```

### 8-5. wrangler.toml の作成

プロジェクトルートに `wrangler.toml` を作成:

```toml
name = "photo-map-app"
main = "worker.js"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "photo-map-uploads"

[[r2_buckets]]
binding = "THUMBNAILS"
bucket_name = "photo-map-thumbnails"

[vars]
GOOGLE_SHEET_ID = "your_spreadsheet_id_here"
```

### 8-6. シークレット（サービスアカウントJSON）の登録

Google サービスアカウントの JSON 内容を Cloudflare のシークレットとして登録します：

```bash
# credentials/service-account.json の内容をそのまま貼り付け
wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

### 8-7. デプロイ

```bash
wrangler deploy
```

デプロイ完了後、以下のような URL が表示されます：

```
https://photo-map-app.your-subdomain.workers.dev
```

### 8-8. カスタムドメインの設定（任意）

Cloudflare Dashboard → Workers & Pages → photo-map-app → **カスタムドメイン** から独自ドメインを設定できます。

### 8-9. GitHub との自動デプロイ連携（推奨）

GitHub リポジトリと連携すると `main` ブランチへのプッシュで自動デプロイされます：

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Connect to Git**
2. GitHub リポジトリを選択
3. ビルドコマンド: `npm install`、出力ディレクトリ: `public`

---

## 9. 注意事項

- `credentials/`, `uploads/`, `thumbnails/`, `.env` は `.gitignore` に含まれており、Gitには保存されません
- **パスワードや認証情報をチャットやコードに記載しないでください**（wrangler secret コマンドを使用）
- 写真が増えた場合は Cloudflare R2 が自動でスケールします（10GB まで無料）
- R2 の料金目安: 保存 $0.015/GB/月、転送費用ゼロ
