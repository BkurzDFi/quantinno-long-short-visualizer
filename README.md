# Quantinno Tax-Neutral Transition Planner

A local, dependency-free dashboard for explaining a concentrated-stock
transition in plain English: how much gain needs to be offset, how much tax may
be due if the client sells now, and how long a Quantinno-style DEALS Exchange
managed account may take to generate enough losses to support tax-neutral
diversification.

## Run locally

From this folder:

```sh
./start.sh
```

(`start.sh` finds a Node binary even if `node` is not on your PATH; you can
also run `node server.js` directly if it is.)

Then open:

```text
http://localhost:4173
```

## Finnhub prices (auto-populated)

You have two options for providing your key:

```sh
FINNHUB_API_KEY=your_key_here node server.js
```

Or paste your key into the in-app `Finnhub API Key` field in the positions
panel and click `Save Key`.

Once a key is configured:

- Prices auto-refresh on page load.
- Prices auto-refresh when you change a ticker or add a new ticker.
- You can still use `Refresh Prices` manually at any time.

The browser calls the local `/api/quotes` endpoint, and the server calls
Finnhub.

## Notes

- This tool uses transparent, editable assumptions rather than actual Quantinno
  performance data or product terms.
- Strategy lineup (Core / Overlay / Exchange), gross exposure menu (130/30
  default through 225/125), benchmark elections, Portfolio Margin rules
  ($3M minimum, Options Level 3, 145/45 Reg-T cap), and the Onboarding Steps
  tab are modeled on Quantinno's DEALS Portal setup and Schwab onboarding
  process in general terms; firm-specific identifiers (e.g. manager account
  numbers) are placeholders, not real values.
- Management fee and net financing spread are editable assumptions included in
  the analysis (fees panel, metrics, narrative, and multi-year table); they are
  not Quantinno's fee schedule. Schwab financing follows the firm's negotiated
  rate, partially offset by the Short-Interest Rebate Program (SIRP).
- The loss-generation assumptions are illustrative and should be replaced with
  client-specific tax analysis when available.
- Live prices come from Finnhub when a key is provided either in-app or via
  `FINNHUB_API_KEY`.
- Results are hypothetical and for educational planning conversations.
- The first version is static HTML/CSS/JS so it can run locally without npm.
