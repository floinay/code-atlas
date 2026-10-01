# Taskboard

A small Express + Prisma app: users, projects and their tasks. It is the second input for
Code Atlas, and it has no event sourcing at all. On the map every domain reads
`command → table → query`, and the aggregate, event and projection lanes stay empty.

```bash
pnpm atlas serve examples/express-prisma     # from the repository root
```

Nothing has to be installed here for that: the extractor only reads the source and
`prisma/schema.prisma`.

| Path | What is in it |
| --- | --- |
| `prisma/schema.prisma` | Six models. They become the tables. |
| `src/app.ts` | Mounts one router per module under `/api`. |
| `src/modules/<name>` | A domain: `*.routes.ts` with the Express routes, `*.service.ts` with the Prisma calls. |
| `src/modules/tasks/tasks.jobs.ts` | A cron job. It becomes a worker. |
| `src/lib/mailer.ts` | Sends mail through nodemailer. It becomes an external system. |
