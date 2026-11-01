/** Drimvox's own skills for the craft around code (docs/specs/catalog.md, asked for): each a SKILL.md. */

export const SECURITY = `---
name: security-review
description: "When building or reviewing anything with accounts, payments, uploads, forms or an API: check it against the OWASP Top 10 and fix what is found"
---

# Security review (OWASP Top 10)

Go through the project as an attacker would, then fix and prove each finding with a test.

## Where to look first

1. **Access control** — every route, API call, WebSocket message and file URL checks *who* asks, on the server.
   Try someone else's id in the URL (\`/orders/124\` instead of \`/orders/123\`): it must be refused.
2. **Injection** — SQL only through parameters or the ORM; never build queries, shell commands or HTML from user input
   by joining strings. Look for \`exec\`, \`eval\`, \`child_process\`, raw SQL, \`dangerouslySetInnerHTML\`, \`v-html\`.
3. **Authentication** — passwords hashed with bcrypt/argon2 (never plain, MD5 or SHA-1); sessions in httpOnly, Secure,
   SameSite cookies; sign-in rate-limited; tokens expire; "forgot password" does not tell whether the email exists.
4. **Secrets** — no keys in the code or git history; \`.env\` in \`.gitignore\`; secrets read from the environment.
5. **Uploads** — check type and size on the server, store outside the web root with generated names, never run them.
6. **XSS and CSRF** — output escaped by the framework; a Content-Security-Policy; state-changing requests need a CSRF
   token or SameSite cookies; no secrets in localStorage.
7. **Dependencies** — run the ecosystem's audit (\`npm audit\`, \`pip-audit\`) and update what is vulnerable.
8. **Errors and logs** — no stack traces or SQL to users; no passwords or tokens in logs.
9. **SSRF** — a server that fetches URLs given by users refuses local and private addresses.
10. **Configuration** — debug off in production, security headers (HSTS, X-Content-Type-Options, frame-ancestors).

## How to report

For each problem: where (file and line), what an attacker does, how bad (high / medium / low), the fix. Fix the high
ones, add a test that proves the hole is closed (the request without rights gets 401/403), run the tests.
`;

export const SEO = `---
name: seo-performance
description: "When a site must be found in search and load fast: titles and meta, structure, sitemap, Core Web Vitals, images and caching"
---

# Search and speed

## Search (SEO)

- Each page: a unique \`<title>\` (50–60 characters, the main words first) and \`<meta name="description">\` (120–160).
- One \`<h1>\` per page with what the page is about; headings in order (h2, h3), not for looks.
- Real text in the HTML: content rendered on the server or prebuilt (SSG/SSR); a page that is empty without
  JavaScript is barely indexed.
- Clean addresses (\`/services/implants\`, not \`/page?id=7\`), \`<link rel="canonical">\`, \`lang\` on \`<html>\`.
- \`robots.txt\` and \`sitemap.xml\`; Open Graph tags (\`og:title\`, \`og:image\`) for links shared in messengers.
- Structured data (JSON-LD schema.org) where it fits: Organization, LocalBusiness, Product, FAQ, Article.
- Images with meaningful \`alt\`; links with words, not "click here".

## Speed (Core Web Vitals)

- **LCP** under 2.5 s: the main picture preloaded, sized, in WebP/AVIF; fonts with \`font-display: swap\`, preloaded.
- **CLS** under 0.1: width and height on every image and video; room kept for banners and embeds.
- **INP** under 200 ms: little JavaScript on the first load, heavy parts loaded later, no long tasks.
- Images resized to the size shown (\`srcset\`, \`sizes\`), lazy below the fold (\`loading="lazy"\`).
- Compression (gzip/brotli), caching headers for static files, a CDN when the audience is wide.
- Measure, don't guess: load the page with the browser's performance tool (browser_performance), fix the biggest
  item, measure again. Check on a phone width with a slow network too.
`;

export const ACCESSIBILITY = `---
name: accessibility
description: "When an interface must work for everyone: keyboard, screen readers, contrast, forms and focus (WCAG 2.2 AA)"
---

# Accessibility (WCAG 2.2 AA)

- **Keyboard**: everything clickable is reachable with Tab and works with Enter/Space; the focus is always visible;
  menus and dialogs close with Escape; focus goes into a dialog and back after it.
- **Semantics**: real \`<button>\`, \`<a href>\`, \`<label>\`, \`<nav>\`, \`<main>\` instead of clickable \`<div>\`s;
  headings in order; lists as lists. ARIA only when HTML has no element for it.
- **Names**: every control has a name a screen reader says: the label of a field, the text of a button, \`aria-label\`
  for icon buttons, \`alt\` for meaningful images (\`alt=""\` for decoration).
- **Contrast**: 4.5:1 for text, 3:1 for large text and for controls' borders and icons; never colour alone to say
  something (an error also has text or an icon).
- **Forms**: labels on the fields, errors said in words next to the field and announced (\`aria-live\` or
  \`aria-describedby\`), required fields marked.
- **Targets**: at least 24×24 px (44×44 on touch); space between them.
- **Motion**: respect \`prefers-reduced-motion\`; nothing flashes more than three times a second; no autoplay with sound.
- **Zoom**: works at 200% and on a 320 px wide screen without sideways scrolling.

Check: go through the main scenario with the keyboard only; run the browser's audit (browser_audit); look at the page
with a screen reader's eyes (the accessibility tree) for unnamed controls.
`;

export const NEXTJS = `---
name: nextjs
description: "When the project is built with Next.js (App Router): structure, server and client components, data, routes, deployment"
---

# Next.js (App Router)

- Structure: \`app/\` with \`page.tsx\`, \`layout.tsx\`, \`loading.tsx\`, \`error.tsx\`, \`not-found.tsx\` per route; shared
  UI in \`components/\`, server code in \`lib/\`. Read \`next.config\` and \`package.json\` for the version first: APIs
  change between majors.
- **Server components by default**; \`"use client"\` only where there is state, effects or browser APIs, as low in
  the tree as possible. Never import server-only code (database, secrets) into a client component.
- **Data**: fetch in server components or route handlers (\`app/api/.../route.ts\`); mutations through Server Actions
  with validation (zod) and \`revalidatePath\` / \`revalidateTag\` after. Say how each fetch is cached.
- **Metadata**: \`export const metadata\` or \`generateMetadata\` for titles, descriptions, Open Graph.
- **Images and fonts**: \`next/image\` with sizes; \`next/font\` instead of font links.
- **Env**: secrets without the \`NEXT_PUBLIC_\` prefix; only \`NEXT_PUBLIC_*\` reaches the browser.
- **Auth**: check the session in server code and middleware, not only by hiding buttons.
- Run \`npm run build\` before saying it is done: it catches type errors and server/client mistakes that \`dev\` hides.
`;

export const FASTAPI = `---
name: fastapi
description: "When the project is a Python API with FastAPI: structure, models, validation, database, auth, tests"
---

# FastAPI

- Structure: \`app/main.py\` (the app), \`app/routers/\` (one router per area), \`app/schemas.py\` (Pydantic models),
  \`app/models.py\` (database), \`app/deps.py\` (dependencies: the session, the current user), \`tests/\`.
- **Pydantic models** for every request and response (\`response_model\`): the API validates input and never leaks
  fields like password hashes.
- **Database**: SQLAlchemy 2 (or SQLModel) with a session per request through a dependency; migrations with Alembic,
  never \`create_all\` in production.
- **Async**: \`async def\` only with async libraries (asyncpg, httpx); blocking calls in plain \`def\` endpoints.
- **Auth**: OAuth2 password flow with JWT or sessions; passwords hashed with bcrypt/argon2 (passlib or pwdlib); the
  current user as a dependency; check ownership of every object, not only that someone is signed in.
- **Errors**: \`HTTPException\` with clear details; a handler for validation errors in the user's language if needed.
- **Settings**: \`pydantic-settings\` reading the environment and \`.env\`; secrets never in code.
- **CORS** only for the front end's real origins.
- **Tests**: \`pytest\` with \`TestClient\` (or httpx AsyncClient) and a test database; run them before finishing.
- Run with \`uvicorn app.main:app --reload\`; the docs at \`/docs\` show the API: check every endpoint there.
`;

export const DOCKER = `---
name: docker
description: "When a project should run in containers: a Dockerfile, docker compose with a database, development and production"
---

# Docker

Docker runs on the user's computer (Docker Desktop on Windows and macOS): check \`docker version\` first; if it is not
installed, say so and how to install it instead of failing.

## Dockerfile

- An official slim base with a version (\`node:22-alpine\`, \`python:3.12-slim\`), not \`latest\`.
- Multi-stage: build in one stage, copy only the result into a small final one.
- Copy the dependency files first and install, then the code: the install layer is cached.
- A non-root user; \`EXPOSE\` the port; \`CMD\` in JSON form; a \`HEALTHCHECK\` for servers.
- A \`.dockerignore\` (node_modules, .git, .env, build output).

## docker compose

- One service per process: the app, the database (\`postgres:16\`), Redis…; named volumes for data that must survive.
- Secrets and settings from \`.env\` (\`env_file\`), never written into compose or the image.
- \`depends_on\` with \`condition: service_healthy\` so the app waits for the database.
- For development, mount the code and run the dev server; for production, the built image.

## Working

\`docker compose up -d --build\`, then \`docker compose ps\` and \`docker compose logs -f app\` to see it start; stop with
\`docker compose down\` (add \`-v\` only when the data may go). Say in the end how to start it with one command.
`;

export const DOCS = `---
name: project-docs
description: "When a project needs a README or documentation: what it is, how to install, run, configure and deploy, written for a newcomer"
---

# README and documentation

Write for someone who has never seen the project and is in a hurry. Check every command by running it.

## README.md, in this order

1. **Name and one sentence**: what it is and for whom. A screenshot or a GIF if it has an interface.
2. **Quick start**: the shortest way from nothing to running — prerequisites with versions (Node 22, Python 3.12,
   Docker), then the commands in code blocks, one per step, copy-pasteable.
3. **Configuration**: every environment variable in a table (name, what it does, example, required or not); an
   \`.env.example\` file with the same.
4. **Usage**: the main things it does, with examples (a request and its answer for an API).
5. **Development**: how to run the tests, the linter, the structure of the folders in a few lines.
6. **Deployment**: where and how it runs in production.
7. **Troubleshooting**: the errors people actually hit and their fixes.
8. **License** and contacts if it is public.

## Style

Short sentences, active voice, the user's language. Commands exactly as typed; paths and names in backticks. No
marketing words. Keep it true: update the README in the same change as the code it describes.
`;

export const EMAIL = `---
name: email-html
description: "When a letter must look right in every mail program: transactional and marketing HTML emails, tables, inline styles, dark mode"
---

# HTML emails

Mail programs (Outlook, Gmail, Apple Mail, Yandex, Mail.ru) render HTML like it is 2005. Build for that.

- **Layout with tables** (\`<table role="presentation">\`), 600 px wide, centred; no flex, grid, floats or positioning.
- **Inline styles** on the elements (a \`<style>\` block only for media queries and dark mode); no external CSS, no
  JavaScript, no forms.
- **Fonts**: system stacks (Arial, Helvetica, sans-serif); web fonts only as an extra.
- **Images**: absolute https URLs, width and height set, \`alt\` text that makes sense when images are off; never a
  letter that is one big picture.
- **Buttons**: "bulletproof" — a table cell with a background colour and a link inside, not a picture.
- **Dark mode**: test colours on dark backgrounds; \`color-scheme\` and \`prefers-color-scheme\` styles; transparent PNG
  logos with a light outline.
- **Mobile**: one column under 600 px through a media query; text at least 14–16 px; tap targets 44 px.
- **Content**: a preheader (the hidden first line shown in the inbox), a clear subject, an unsubscribe link and the
  sender's address in marketing letters.
- **Plain text version** alongside the HTML.

Tools: MJML or React Email compile clean, tested HTML from simple markup — prefer them for anything beyond one letter.
Send yourself a test and look at it in at least Gmail and Outlook.
`;
