# Setup: sandbox keys, local LLM, webhooks and the public repo

This guide is written for Windows 10/11 with PowerShell. macOS and Linux work the same way; use `cp` instead of `Copy-Item`.
Nothing here needs a live PayPal account or real money. **Use sandbox credentials only and never commit `.env`.**

## 0. Prerequisites

| Tool | Version | Get it |
|---|---|---|
| Node.js | 20 LTS (`.nvmrc` says 20) | https://nodejs.org (LTS installer) or `nvm-windows` |
| Git | any recent | https://git-scm.com/download/win |
| Ollama (optional) | latest | https://ollama.com/download |

`better-sqlite3` ships prebuilt binaries for Node 20 on Windows x64, so `npm ci` normally needs no compiler. If it fails with a `node-gyp` error, install "Visual Studio Build Tools" with the "Desktop development with C++" workload and run `npm ci` again.

```powershell
cd path\to\payguard
npm ci
npm run dev:mock      # offline demo, no keys: http://localhost:3000
```

## 1. Sandbox Client ID and Secret

1. Open https://developer.paypal.com/dashboard/ and log in with your PayPal account.
2. Go to **Apps & Credentials**. Make sure the toggle at the top says **Sandbox**, not Live.
3. Click **Create App**. Name it `PayGuard Agent`, choose type **Merchant**, and pick a sandbox business account (the default one is fine). Click **Create App**.
4. On the app page, copy:
   - **Client ID**: shown in full.
   - **Secret key 1**: click the eye or copy icon next to it.
5. Under the app's features, keep the defaults. Make sure **Transaction search** and **Disputes** are ticked if you want those read tools to work.

## 2. Fill `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Set only these values and leave the rest as they are:

```
PAYPAL_CLIENT_ID=<your sandbox client id>
PAYPAL_CLIENT_SECRET=<your sandbox secret>
PAYPAL_ENV=sandbox
PAYGUARD_MOCK=
```

`.env` is in `.gitignore`. Do not paste the values anywhere else: not into an issue, a screenshot, the video or a commit.

## 3. Smoke tests

```powershell
npm run smoke:oauth
npm run smoke:order
```

- `smoke:oauth` prints `token ok, expires_in=..., app_id=...`. It never prints the token.
- `smoke:order` creates a $1.00 USD sandbox order and prints the order id and an approve link. You can open the link and pay with a **sandbox personal** account (Dashboard → Testing Tools → Sandbox Accounts).

If either fails with 401, the id or secret was copied with a space or belongs to the Live tab.

## 4. Local LLM with Ollama

1. Install Ollama from https://ollama.com/download. It runs in the background on `http://localhost:11434`.
2. Pull a small model that supports tool calling:
   ```powershell
   ollama pull qwen2.5:7b      # about 4.7 GB, works well with tools; needs about 8 GB of free RAM
   # lighter fallback for low-memory laptops:
   ollama pull llama3.2:3b     # about 2 GB, less accurate
   ```
3. Add to `.env`:
   ```
   LLM_BASE_URL=http://localhost:11434/v1
   LLM_MODEL=qwen2.5:7b
   LLM_API_KEY=
   ```
   `LLM_API_KEY` can stay empty for Ollama. For a hosted OpenAI-compatible provider, put its key here (in `.env` only).
4. Start the app with `npm run dev`, then open http://localhost:3000/api/health. You should see `"mode":"sandbox"`, `"paypalConfigured":true` and `"llm":"openai-compatible"`.

If the model answers without calling a tool, try `qwen2.5:7b` instead of a smaller model. The policy guard keeps wrong tool choices safe either way.

## 5. Webhook id (optional)

Webhooks let PayGuard see captures and refunds that happen outside the app. PayPal must reach your machine over https, so you need a tunnel:

1. Start the app with `npm run dev`.
2. In a second terminal, start a tunnel to port 3000, for example:
   ```powershell
   cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
   ```
   Copy the `https://...` URL it prints.
3. In the Dashboard, open your app and find **Sandbox Webhooks** → **Add Webhook**.
   - URL: `https://<your-tunnel-host>/api/webhooks/paypal`
   - Events: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`
4. Save, copy the **Webhook ID**, and set `PAYPAL_WEBHOOK_ID=<id>` in `.env`. Then restart `npm run dev`.
5. Trigger a real sandbox event, for example by paying the order from `npm run smoke:order` or by refunding from the chat. Then check the **Audit** page for a `webhook` row.

The tunnel URL changes each time with a free tunnel, so update the webhook URL in the Dashboard when it changes. Events from the Dashboard's webhook simulator may fail signature verification; real sandbox events are the reliable test.

## 6. Public GitHub repository

The hackathon needs a **public** repo with a visible open-source license. `LICENSE` (Apache-2.0) and `NOTICE` are already in the project.

### What stays private

`_private/` holds the planning prompts, the Devpost draft, the video script, the Arabic brief, the rules-compliance checklist and the saved copy of the rules. It is in `.gitignore`, so it is never pushed. Keep it that way:

- the submission must be in English;
- those files are internal notes, and one of them contains your sandbox account email.

Arabic stays in the repo only where it is product content: UI strings in `src/i18n/*.json` and Arabic test inputs in `eval/`, `seed/` and `test/fixtures/`.

### Create and push

1. On https://github.com/new:
   - name it `payguard-agent`;
   - choose **Public**;
   - do **not** add a README, .gitignore or license (they already exist).
   Click **Create repository**.
2. In PowerShell, in the project folder:
   ```powershell
   git init
   git add .
   git status            # check the list before committing
   ```
   The list must **not** contain `.env`, `_private/`, `node_modules/`, `.next/` or any `*.db` file. A quick check:
   ```powershell
   git ls-files | Select-String -Pattern "\.env$|_private|\.db$|node_modules"
   ```
   This should print nothing.
3. Commit. Commit messages use the `S<n>: <title>` format. Slices 1 to 14 were built before the repo existed, so make **one honest initial commit** instead of inventing a fake history:
   ```powershell
   git commit -m "S14: PayGuard Agent initial public version (slices S1-S14, see TASKS.md)"
   git branch -M main
   git remote add origin https://github.com/<your-username>/payguard-agent.git
   git push -u origin main
   ```
   Future work goes in commits like `S15: hosted demo` and `S16: video and Devpost links`.
4. On the repo page, click the gear icon next to **About**:
   - add a one-line description and the topics `paypal`, `ai-agent` and `hackathon`;
   - confirm that **Apache-2.0** shows in the sidebar.
5. Optional: run `npm run secretscan` once more before every push.

### Before you submit on Devpost

- [ ] `npm run check`, `npm run build` and `npm run eval` pass on your machine.
- [ ] The repo is public, shows the Apache-2.0 license, and has no `.env` or `_private/`.
- [ ] The video is under 3 minutes, in English (or with English subtitles), shows no secrets or Dashboard credentials, and is uploaded to YouTube.
- [ ] The Devpost form has the repo URL, the video URL and the PayPal tools used.
