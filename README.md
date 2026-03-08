# devinstein.me

Personal academic website for Devin Stein.

---

## Repo Structure

```
/
├── index.html          ← The entire site (single file)
├── img/
│   ├── headshot.jpg    ← Standard headshot (~800px wide)
│   └── headshot-hires.jpg  ← Hi-res downloadable version
├── CNAME               ← Tells GitHub Pages to use your custom domain
└── README.md
```

---

## Deployment Guide: Google Sites → GitHub Pages

### Step 1: Create the GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it anything (e.g., `devinstein.me` or `personal-site`)
3. Make it **Public** (required for free GitHub Pages)
4. Click **Create repository**

### Step 2: Upload files

**Option A — GitHub web UI (easiest, no git needed):**
1. On your new repo page, click **"uploading an existing file"**
2. Drag in: `index.html`, the `img/` folder with your headshots, and `CNAME`
3. Click **Commit changes**

**Option B — Command line (if using git):**
```bash
cd /path/to/this/folder
git init
git add .
git commit -m "Initial site"
git remote add origin https://github.com/YOUR_USERNAME/devinstein.me.git
git push -u origin main
```

### Step 3: Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages** (left sidebar)
2. Under **Source**, select **Deploy from a branch**
3. Branch: `main`, folder: `/ (root)`
4. Click **Save**
5. After ~60 seconds, your site will be live at `https://YOUR_USERNAME.github.io/devinstein.me/`

### Step 4: Point your domain (devinstein.me)

This is the one step that requires touching your domain registrar. Go to wherever you purchased `devinstein.me` (likely Google Domains, now Squarespace Domains, or Namecheap).

**Update DNS records:**

| Type  | Name | Value                    |
|-------|------|--------------------------|
| A     | @    | 185.199.108.153          |
| A     | @    | 185.199.109.153          |
| A     | @    | 185.199.110.153          |
| A     | @    | 185.199.111.153          |
| CNAME | www  | YOUR_USERNAME.github.io  |

**Then in GitHub:**
1. Repo → Settings → Pages → **Custom domain**
2. Enter: `devinstein.me`
3. Check **Enforce HTTPS** (may take a few minutes to become available)

DNS propagation can take 10 minutes to 24 hours. Usually fast.

### Step 5: Verify

- Visit `https://devinstein.me` — should show your new site
- Visit `https://www.devinstein.me` — should redirect properly
- Test on mobile

---

## Making Updates

After initial setup, updating is trivial:

**Via GitHub web UI:**
1. Navigate to `index.html` in your repo
2. Click the pencil icon (edit)
3. Make changes
4. Click **Commit changes**
5. Live in ~30 seconds

**Via command line:**
```bash
# Edit index.html locally
git add .
git commit -m "Update research section"
git push
```

---

## Checklist Before Going Live

- [ ] Replace `img/headshot.jpg` with your actual headshot
- [ ] Add `img/headshot-hires.jpg` for the download link
- [ ] Update email from `dstein2@ua.edu` to CSU address when ready
- [ ] Verify the Google Scholar and LinkedIn links work
- [ ] Update the "University Profile" link once CSU page exists
- [ ] Review both bio texts for accuracy
- [ ] Test the Copy buttons on both bios
- [ ] Check mobile layout on your phone
