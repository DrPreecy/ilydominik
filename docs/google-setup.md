# Google Cloud & Firebase Setup Guide

A simple, click-by-click guide to set up the free Google services for CWS.

---

## What you need
- A regular Google account (e.g. `@gmail.com`).
- Cost: **€0 (Free)**. You do **not** need to enter a credit card for Stage 1.

---

## Step 1 — Create your Firebase project

1. Open [console.firebase.google.com](https://console.firebase.google.com) in your web browser.
2. Click **Add project** (or **Create a project**).
3. Enter a project name, for example: `cws-workspace` (or any name you like starting with `cws-`).
4. Click **Continue**.
5. When asked about Google Analytics: toggle it **OFF** (we do not need tracking and share less data).
6. Click **Create project** and wait a few seconds until it says "Your new project is ready".
7. Click **Continue** to enter your new project dashboard.

---

## Step 2 — Turn on Google Sign-In (Authentication)

1. In the left-hand sidebar menu, click **Build**, then click **Authentication**.
2. Click the **Get started** button.
3. Under the "Sign-in providers" tab, click on **Google**.
4. Switch the toggle at the top right to **Enable**.
5. Under "Support email for project", select your own email address from the dropdown.
6. Click **Save**.

---

## Step 3 — Create your Firestore database

1. In the left-hand sidebar menu under **Build**, click **Firestore Database**.
2. Click the **Create database** button.
3. For security rules, select **Start in production mode** (this keeps your database secure).
4. Click **Next**.
5. For the Cloud Firestore location, select **eur3 (europe-west)** or **europe-west3 (Frankfurt)**.
6. Click **Create** and wait a moment for the database to provision.

---

## Step 4 — Register your web app

1. At the top of the left sidebar, click the ⚙️ gear icon next to "Project Overview", then choose **Project settings**.
2. Scroll down to the "Your apps" section and click the **Web icon `</>`**.
3. Under "App nickname", type `cws-dashboard`.
4. Leave the checkbox for "Also set up Firebase Hosting" unchecked for now.
5. Click **Register app**.
6. Firebase will show a code block with `const firebaseConfig = { ... }`.
7. You can copy the values below for reference (these are public identifiers, not secret keys):

```javascript
// Paste your public config here for reference when ready:
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "...",
  appId: "..."
};
```

8. Click **Continue to console**.

---

## Step 5 — Get your free Gemini API key & save it on your computer

> ⚠️ **Important:** Never share this API key, paste it into chat, or put it in any git files.

1. Open [aistudio.google.com](https://aistudio.google.com) in your browser.
2. Sign in with the same Google account.
3. Click the blue **Get API key** button on the left menu.
4. Click **Create API key**.
5. Select your existing Google Cloud / Firebase project (the one you named in Step 1) and confirm.
6. Copy your generated key to your clipboard.
7. Save it safely in your Windows user environment variables:
   - Press the **Windows Key**, type `env`, and select **Edit environment variables for your account**.
   - In the top box ("User variables for <your name>"), click **New...**.
   - For **Variable name**, enter: `GEMINI_API_KEY`
   - For **Variable value**, paste your Gemini API key.
   - Click **OK**, then click **OK** again to close the window.

To verify later in PowerShell:
```powershell
echo $env:GEMINI_API_KEY
```
(It should print your key in your private terminal.)

---

## Step 6 — (Stage 2, Optional Later) Budget alerts & Google AI Pro credits

This is optional and only needed when you want to use paid cloud functions or higher quotas:
1. Open the [Google Cloud Console Billing](https://console.cloud.google.com/billing).
2. Link a payment card.
3. Go to **Budgets & alerts** → Create a budget of **€1** with threshold alerts at 50%, 90%, and 100%.
4. If you have Google AI Pro, claim your $10/month credit at [developers.google.com/program/my-benefits](https://developers.google.com/program/my-benefits).

---

## Step 7 — Install Firebase command line tools

In your terminal / PowerShell:
1. Install the tools globally:
   ```bash
   npm i -g firebase-tools
   ```
2. Log in with your Google account:
   ```bash
   firebase login
   ```
   (A browser window will open asking you to allow Firebase CLI access with your Google account.)

---

## Verification Checklist

You are completely set up when:
- [ ] You see your project in [console.firebase.google.com](https://console.firebase.google.com).
- [ ] In the Firebase console, **Authentication** shows Google enabled.
- [ ] In the Firebase console, **Firestore Database** is created.
- [ ] Running `echo $env:GEMINI_API_KEY` in a new PowerShell window prints your key.
- [ ] Running `firebase projects:list` in your terminal lists your project.
