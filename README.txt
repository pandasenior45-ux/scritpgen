SCRIPTGEN AI — VERCEL DEPLOY

Project layout:
  public/index.html   Website UI (kept unchanged)
  api/generate.mjs    Vercel serverless API for Gemini generation
  vercel.json         Vercel routing, static output and function settings

DEPLOY WITH VERCEL CLI (recommended):
  1. Extract this ZIP.
  2. Open a terminal inside the scriptgen-ai folder.
  3. Install Node.js if it is not already installed.
  4. Run: npm install -g vercel
  5. Run: vercel login
  6. Test deploy: vercel
  7. Production deploy: vercel --prod

OR DEPLOY THROUGH GITHUB:
  1. Put the contents of this folder in a PRIVATE GitHub repository.
  2. In Vercel, select Add New > Project and import that private repository.
  3. Use the project root (the folder containing vercel.json) as Root Directory.
  4. Build command: leave empty. Output Directory is already set to public in vercel.json.
  5. Before deploying, open Vercel Project > Settings > Environment Variables.
  6. Add Name: GEMINI_API_KEY and Value: your NEW/active Gemini API key. Choose Production (and Preview
     if you will test Preview deployments). Save the variable.
  7. Deploy or redeploy the project so the variable is applied.

IMPORTANT API KEY NOTE:
  No API key is stored in this project source code or public/index.html.
  The server reads GEMINI_API_KEY only from Vercel Environment Variables.
  Do not create a .env file containing a real key inside the repository, and never
  commit API keys. If a key was previously blocked by GitHub secret scanning or shared
  in an older ZIP, rotate/revoke it in Google Cloud and set the replacement in Vercel.

FEATURES PRESERVED:
  - English, Hindi, Urdu, and Roman English (Roman Urdu) language options
  - Mandatory topic-specific strong hook in the first 3–5 seconds
  - Background generation with short polling requests and retry behavior
  - Existing styling, history, copy, download and analysis output

NOTES:
  - The frontend calls /api/generate; api/generate.mjs serves this route on Vercel.
  - Each generation request is created once; only status checks retry automatically.
  - The function's 30-second limit applies to each short API request, not the entire script
    generation, because long generation runs as a Gemini background interaction.
