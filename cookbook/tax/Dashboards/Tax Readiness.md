---
type: dashboard
dashboard: tax
sheet: Tax 2026
missing: Tax Missing
stale_hours: 26280
cards:
  - label: Income YTD
    bind: "{{Tax 2026.income_ytd}}"
    format: eur
    emph: true
  - label: Profit YTD
    bind: "{{Tax 2026.profit_ytd}}"
    format: eur
    emph: true
  - label: Business expenses
    bind: "{{Tax 2026.expenses_ytd}}"
    format: eur
  - label: Equipment
    bind: "{{Tax 2026.equipment_ytd}}"
    format: eur
  - label: Home office
    bind: "{{Tax 2026.home_office_ytd}}"
    format: eur
  - label: Rental
    bind: "{{Tax 2026.rental_ytd}}"
    format: eur
  - label: Partnership
    bind: "{{Tax 2026.partnership_ytd}}"
    format: eur
  - label: Threshold headroom
    bind: "{{Tax 2026.threshold_headroom}}"
    format: eur
  - label: Documents
    bind: "{{Tax 2026.documents}}"
    format: number
created: 2026-08-03
---
How ready the year is to hand over. Totals come from [[Tax 2026]], the
checklist of receipts still owed from the exported [[Tax Missing]] snapshot —
the books stay canonical and the app only reads them. The head's Print action
turns this into the page you hand to whoever does the filing.

The cards are ordinary `cards:` bindings: swap the labels and summaries for
whatever your own filing is judged on, and mark at most two `emph: true`. The
`stale_hours:` here is deliberately long so this shipped sample still reads as
trustworthy months after it was written — a real board wants days, not years.
