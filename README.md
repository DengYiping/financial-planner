# Personal Finance Tracker and Planner

Skeleton app for tracking spending, planning budgets, and preparing for statement ingestion from multiple banks.

Built with:
- Next.js (App Router)
- TypeScript
- Tailwind CSS
- pnpm

## Getting Started

Install dependencies and start the dev server:

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Current Scope (V1)

- Dashboard skeleton with summary cards, budget planner, upcoming bills, and recent transaction table
- Placeholder intake cards for:
  - Revolut CSV imports
  - AIB CSV imports
- No login/authentication yet (intentional for this version)

## Planned Next Steps

1. Parse Revolut CSV and map into a normalized transaction model.
2. Parse AIB CSV and map into the same normalized model.
3. Power dashboard cards/charts from imported data instead of sample placeholders.
4. Add authentication and user storage once import and planning flows are stable.

## Useful Commands

```bash
pnpm dev
pnpm lint
pnpm test
pnpm build
```

## Project Structure

```text
src/
  app/
    layout.tsx
    page.tsx
  components/
    dashboard/
      budget-bar.tsx
      section-shell.tsx
      summary-card.tsx
```

You can expand this structure when CSV parser modules are added.
