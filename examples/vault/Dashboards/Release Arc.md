---
type: dashboard
dashboard: hub
created: 2026-08-16
---
Every release as a bar from the day recording started to the day it shipped.
A release with no `released` date yet is a dot, not a bar — [[Fern Static]] sits
where it was started and nothing is claimed about when it lands.

## The arc

```timeline
source: release
start: recording_start
end: released
label: title
group: status
```

## Shipped only

```timeline
source: release
start: recording_start
end: released
label: title
query: status:live
```
