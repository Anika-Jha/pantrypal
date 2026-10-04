# PantryPal: There’s a meal in there.

This is a submission for the [Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01)

## What I Built

You know that feeling?

You bought curd last week because you were *definitely* going to eat healthier.

Now you're opening the fridge wondering whether the curd is still food or has started developing its own biodiversity.

Or maybe you're living alone with:

* 3 eggs
* half an onion
* some spinach
* a questionable tomato
* one pan
* and absolutely **no idea what to cook**.

And somehow, the answer is always the same five recipes you've already made a hundred times.

So I built **PantryPal**.

**PantryPal is an AI kitchen companion that looks at what you actually have and tells you what you can make before your groceries become a science experiment.**

You can quickly add what's in your pantry in plain language:

> "Bought 250g spinach and 6 eggs today."

PantryPal turns that into structured pantry items, keeps track of freshness and dates, and surfaces the things that need attention first.

Then comes the question that inspired the whole project:

### "Okay... but what can I actually cook?"

Pick the ingredients you want to use, tell PantryPal what you're working with, and it generates multiple meal ideas around your real constraints.

Want:

* something high-protein?
* something quick?
* Indian food?
* something healthy?
* one-pan only?
* microwave only?
* something different because you're bored of eating the same thing?

PantryPal works around that.

It also considers the equipment you actually have.

Because "just use the oven" isn't very helpful when your kitchen consists of one pan and an air fryer.

### The bigger idea

I didn't want to build another recipe generator.

I wanted to build something that connects:

**What I have → What needs using → What I can realistically cook → What I actually want to eat.**

The goal isn't to give you *more recipes*.

It's to make the contents of your kitchen more useful.

> **There’s a meal in there.**

---

## Demo

**Live demo:** <!-- Add deployed link -->


---

## How I Built It

The heart of PantryPal is **Gemma**, an open-weight AI model.

I'm using:

**Gemma 4 26B A4B IT**

Gemma handles the parts of the problem where language and creativity matter:

* understanding natural-language pantry entries
* turning messy descriptions into structured ingredients
* generating recipe ideas
* adapting recipes to cuisines
* suggesting substitutions
* explaining recipes

But I deliberately didn't let the model run the entire kitchen.

The deterministic application layer owns things that should be reliable:

* pantry data
* quantities
* dates
* freshness states
* equipment constraints
* time limits
* recipe validation
* recipe ranking
* Meal Efficiency Score

That gives PantryPal a useful separation:

```text
                 PantryPal
                     │
          ┌──────────┴──────────┐
          │                     │
     Deterministic          Gemma AI
       Kitchen Logic        Language + Ideas
          │                     │
   dates / quantities      parsing / recipes
   freshness / scoring    substitutions
   constraints            cuisine adaptation
          │                     │
          └──────────┬──────────┘
                     ↓
              What should I cook?
```

Recipe generation is also constrained by the user's actual kitchen.

For example:

```text
Ingredients:
eggs + tomatoes + spinach

Goal:
High protein

Maximum time:
30 minutes

Equipment available:
Stovetop + Microwave

Cuisine:
Indian
```

Gemma doesn't just get "make me a recipe."

It gets the context needed to make the result useful.

The backend then validates the generated recipes before they reach the user.

---

## Why Does Open Innovation Matter?

For something like PantryPal, an open model changes what you can build.

A closed API can certainly generate a recipe.

But the interesting part isn't generating:

> "Here's a spinach recipe."

The interesting part is building a system where the model can be deeply integrated into a product's own logic:

```text
My pantry
     ↓
My constraints
     ↓
My equipment
     ↓
My preferences
     ↓
Gemma
     ↓
Validated recipes
     ↓
My kitchen
```

Using an open-weight model gives developers much more control over how AI becomes part of the product rather than simply being a button that says "Ask AI."

It also makes experimentation possible.

I can change the prompting, validation, orchestration, model configuration, and application logic around the model instead of treating intelligence as a black box.

For PantryPal, that matters because the best answer isn't necessarily the most creative recipe.

It's the recipe that **actually works for the person standing in their kitchen right now.**

---

## Built for someone who just wants dinner.

PantryPal started with a very ordinary problem:

**"I have food. Why is deciding what to cook still so difficult?"**

Living alone makes that worse.

You buy ingredients individually, recipes assume you have twelve things you don't have, groceries get forgotten, and eventually you order the same takeout you've been trying to avoid.

PantryPal is my attempt to make the kitchen answer back.

Not:

> "Here are 10,000 recipes."

But:

> **"Here's what you have. Here's what needs using. Here's what you can make. Let's cook."**

**Your kitchen, figured out.**


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


## Security
See `.env.example` for the supported environment variables. Keep credentials in Replit Secrets or a local `.env` file, never in browser code or commits.
