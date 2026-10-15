# Anna & Nazar

Private love website for two. Frontend: React (GitHub Pages). Backend: FastAPI + PostgreSQL.

## Deploy
1. Create a free Postgres on Neon (neon.tech), copy the connection string.
2. Create a Web Service on Render from this repo (render.yaml is included). Set env vars: DATABASE_URL, JWT_SECRET, NAZAR_PASSWORD, ANNA_PASSWORD, FRONTEND_ORIGIN=https://hudaynazar250406.github.io
3. In GitHub: Settings > Pages > Source = GitHub Actions. Settings > Secrets and variables > Actions > Variables: VITE_API_URL = your Render URL.
4. Push to main - the site builds automatically.

## Local run
backend: `cd backend && pip install -r requirements.txt && uvicorn main:app --reload`
frontend: `cd frontend && npm install && npm run dev`
