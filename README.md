# Redundant Headers Review Package

This folder is self-contained. It includes the review interface, the original question packages, the cleaned question packages, and the CSV reports.

## Folder Contents

- `interface/` - React/Vite review UI.
- `data/output/original-packages/` - original question ZIP packages before cleanup.
- `data/output/structure/` - cleaned question ZIP packages organized by subject and grade, plus `manifest.json`.
- `data/output/packages/` - flat cleaned question ZIP packages.
- `data/csv/` - CSV reports and original input CSV.
- `scripts/` - scripts used to scan, fix, and build the review structure.

## GitHub Review Page

You can publish only the review UI on GitHub Pages instead of moving the whole tool.

1. Build the review bundle locally:

```bash
python3 scripts/package_review_bundle.py
```

This creates `data/output/review-bundle.zip` with:
- `structure/manifest.json`
- cleaned question ZIP files under `structure/<subject>/<grade>/`

2. Deploy the page:

- Push this repo to GitHub
- Open **Settings → Pages**
- Under **Build and deployment**, set **Source** to **GitHub Actions**
- Push to `main` or re-run the **Deploy Review Page** workflow from the Actions tab

If deploy fails with `404 Ensure GitHub Pages has been enabled`, Pages is not enabled yet. Enable it from:
https://github.com/Eslam250-x3/Redundunt-Qs-Headers/settings/pages

Or from the terminal after `gh auth login`:

```bash
gh api repos/Eslam250-x3/Redundunt-Qs-Headers/pages -X POST -f build_type=workflow
```

- The workflow in `.github/workflows/deploy-review-page.yml` builds `interface/` and publishes it

3. Review flow on the hosted page:

- Open the GitHub Pages URL
- Upload `review-bundle.zip`
- Choose subject and grade
- Load questions
- **Before** comes from S3: `https://s3.us-east-1.amazonaws.com/qms.nagwa.com/packages/{question_id}.zip`
- **After** comes from the uploaded review ZIP

You only upload the cleaned output bundle. Original packages stay on S3.

## Run The Interface

Open a terminal in this folder, then run:

```bash
cd interface
npm install
npm run dev
```

Open:

```text
http://localhost:4000
```

Use Review mode, select a subject and grade, then load questions. Each question is shown as Before and After side by side.

## Main CSV Files

- `data/csv/redundant_headers_report.csv` - detected redundant headers with subject, grade, part number, and phrase removed.
- `data/csv/fixed_packages_summary.csv` - status for each cleaned package.
- `data/csv/question-report-20260607-080241-ff3e558a120a4ede80aed7a3bc1b4be4.csv` - original input question report.

