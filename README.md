# PantryPal

There’s a meal in there. PantryPal is shaped around one friend’s real kitchen needs: living alone, wanting protein-rich meals, finding expiry tracking a hassle, and working with limited utensils. It helps turn food already at home into a dinner idea that fits the time and equipment on hand.

## Run locally or on Replit

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000`. Replit can run the same `npm start` command and expose port `3000` as its web preview.

## Weekend challenge context

This build is tailored to the DEV [Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/events/78), which asks for a new open-source-AI project that helps one real person. PantryPal’s person is the user's friend who lives alone, wants protein-rich meals, struggles with expiry tracking, and may have limited utensils. A DEV submission must include the `#hf26challenge` tag, a demo and code link, and an explanation of why open AI matters. The deadline is October 5, 2026 at 06:59 UTC (12:29 IST).

Copy `.env.example` to `.env` to configure integrations. Local development works without provider credentials:

- Local development without `MONGODB_URI` uses the atomic JSON store at `data/pantrypal.json`. This is a single shared kitchen profile for a demo; it is not account-isolated multi-user storage.
- Production requires `MONGODB_URI`; startup fails with a clear configuration/connection error instead of silently writing production data to local disk. On the first Atlas start, an existing local JSON state is copied into Atlas (and kept on disk as a backup) if Atlas has no PantryPal state yet. `MONGODB_DB` chooses the database. `MONGODB_CONNECT_TIMEOUT_MS` and `MONGODB_MAX_POOL_SIZE` tune the reused driver connection pool. MongoDB access is isolated in `storage.mjs`; the current no-auth prototype stores its state in one indexed document in the `app_state` collection.
- With `GOOGLE_AI_API_KEY`, recipe generation uses the configured Gemma model through Google AI Studio. Output is requested as JSON and validated before it is displayed. Quick Add uses a deterministic local parser so explicit amounts are preserved without inventing dates or quantities. If Gemma is not configured or fails, the app explains that it is showing local pantry matches.

## What works

- Natural-language Quick Add with an editable confirmation step for ingredient names, amounts, and units
- Pantry create, full edit (including purchase and expiry dates, notes, and category), delete, search, filters, and mark-used quantity updates
- Explicit use-by dates and deterministic freshness labels; missing dates stay unknown
- One-person meal ideas generated only from pantry ingredients explicitly selected for that request
- A separate Kitchen Match and Meal Efficiency Score (40% use-soon food, 30% time fit, 30% selected pantry coverage); unavailable inputs are shown as unavailable
- Structured Gemma generation when configured, with a transparent local fallback
- Recipe details, saved recipes, cook steps, an in-app timer, and meal feedback
- Cuisine and kitchen preferences, a date-first meal planner, recently-made history, and local JSON / production MongoDB Atlas persistence
- Responsive mobile bottom navigation and desktop side navigation

## Architecture and current limits

The Node HTTP backend owns data validation, freshness-state calculation, recipe provider selection, and persistence. `storage.mjs` keeps the local JSON and MongoDB Atlas implementations behind one state repository. The browser only collects choices and renders API results. Gemma never determines freshness, inventory quantities, or the match score.

This hackathon build is a single-kitchen prototype without user authentication. Mastra, Tinker, and Sentry are not configured; the settings page reports that directly. Feedback is persisted as preference signals but does not claim to fine-tune a model. The current local matcher offers flexible cooking ideas from ingredient combinations; full culinary verification, nutrition estimates, food-safety advice, notifications, and production user isolation are not implemented.

Run the API regression check with `npm test`. Tests use a temporary JSON store and do not alter the demo pantry.

See `.env.example` for the supported environment variables. Keep credentials in Replit Secrets or a local `.env` file, never in browser code or commits.
