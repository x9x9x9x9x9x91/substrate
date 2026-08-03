---
type: dashboard
dashboard: metrics
cards:
- label: Notes written
  bind: '{{Vault 2025.notes_total}}'
  format: number
  emph: true
- label: Words added
  bind: '{{Vault 2025.words_total}}'
  format: number
  emph: true
- label: Database rows
  bind: '{{Vault 2025.rows_total}}'
  format: number
- label: Busiest month
  bind: '{{Vault 2025.busiest}}'
created: 2026-08-03
---
The year, as the vault saw it — cards over [[Vault 2025]], charts underneath.
The head's Print action turns the pane into the shareable PDF.

```chart
source: {{Vault 2025}}
x: month
y: sum:notes_created
kind: bar
title: Notes per month
```

```chart
source: {{Vault 2025}}
x: month
y: sum:words_added
kind: line
title: Words added
```
