# Huddle

Real-time collaborative kanban board with AI assist. (Full README is written at the end of the build.)

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres redis   # or use local Postgres 16 + Redis 7
pnpm install
pnpm db:migrate
pnpm dev                              # web on http://localhost:5173
```
