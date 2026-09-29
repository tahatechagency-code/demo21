# Deploy the web app to Vercel

This is a pnpm monorepo. Only `apps/web` (Next.js) runs on Vercel; the API and
worker run on the VPS.

1. Vercel -> Add New -> Project -> import this repo.
2. **Root Directory: `apps/web`** (Framework Preset: Next.js). Leave
   "Include source files outside of the Root Directory" enabled: the web app
   depends on `packages/*`.
3. Install/build commands come from `apps/web/vercel.json`; nothing to override.
4. Environment Variables: copy from `apps/web/.env.example`.
5. Deploy.

Backend secrets (DB, Redis, JWT, WhatsApp, Gemini...) stay on the VPS and are
not needed on Vercel.
