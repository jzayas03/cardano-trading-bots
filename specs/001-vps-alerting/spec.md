# Feature Specification: VPS Alerting — dead-man's switch and failure notifications

**Feature Branch**: `feat/vps-alerting` (spec directory `001-vps-alerting`)

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "VPS alerting: a dead-man's switch and failure notifications for the
Cardano paper-trading VPS. Today the watchdog (every 15 min) writes its verdict only to a log file;
its non-zero exit reaches nobody. No failure hooks on any unit, no webhook, no external check. On
2026-09-16 the three paper runs were stopped for over an hour and a session that had been approved
to run the cutover stalled for 11 hours, and nothing on the box could have told the founder either.
The founder's recurring bug class is silent drift: crons and runners failing open for days. The
feature: the existing watch command reports to an external dead-man's switch when healthy and to a
failure endpoint when not, so an alert reaches the founder's phone when the box, the network, the
timer, the collector, a paper run, the backup, or the check itself dies or degrades; plus unit-level
failure hooks so a crash-loop or a failed backup alerts immediately rather than at the next
15-minute tick. Constraints: 2 GB box already at ~825 MB available with four paper runs; no PHI; no
secrets in the repo (the reporting URL is a secret in the environment file); must be verifiable on
the real box, not only in a harness; the founder decides the provider and the escalation policy."

## Why this exists

The project's own history is the argument. The runbook says "this project has a documented history
of green deploy jobs that deployed nothing." The M1 report found a watchdog that "ran 15 times today
and never fired." The M3 report (2026-09-16) records a week in which the only restart was unplanned
and a cutover approved at 00:45 UTC that did not execute until 11:24 UTC, with every process on the
box healthy-looking from the inside the whole time. The failure mode is never a crash the founder
sees; it is a box that goes quiet, or keeps writing the wrong thing, for days.

An alert is only worth having if its absence is also a signal. That is what a dead-man's switch
adds over a log line: something **off** the box expects to hear from it on a schedule, and speaks
up when it does not. Everything else in this spec is about making the message that arrives useful,
and making sure it arrives when it should and not when it should not.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The box goes silent and the founder finds out (Priority: P1)

The founder is away from the machine. The VPS reboots and a unit does not come back, or the
network drops, or the watchdog timer stops firing, or the watchdog itself starts crashing before it
can report. Within a bounded time the founder's phone shows an alert saying the paper-trading box
has gone silent since a stated time.

**Why this priority**: This is the one failure class that no on-box mechanism can ever report,
because the mechanism is what failed. It covers the 2026-09-16 stall and every "cron failing open
for days" incident in the founder's history. If only this story ships, the project has observability
it did not have before.

**Independent Test**: Stop the watchdog timer on the real box and do nothing else. The alert must
arrive within the silence bound. Start the timer again; a recovery notice must arrive. Both are
recorded in the runbook with timestamps.

**Acceptance Scenarios**:

1. **Given** the watchdog reports healthy on every cycle, **When** the timer is stopped, **Then** an
   alert naming the box and the time of the last report reaches the founder's phone within the
   silence bound, with no action on the box.
2. **Given** an alert is open for silence, **When** the watchdog reports healthy again, **Then** a
   recovery notice arrives and the alert is closed, without the founder having to acknowledge it.
3. **Given** the box loses network entirely, **When** the silence bound elapses, **Then** the alert
   arrives exactly as in scenario 1 — the mechanism that decides "silent" lives off the box.
4. **Given** the watchdog process itself fails before reporting (crash, bad config, missing
   dependency), **When** two cycles pass, **Then** this is indistinguishable from silence and alerts
   the same way.

---

### User Story 2 - A check fails and the alert says which one (Priority: P2)

The watchdog runs, finds something wrong — a stale collector tick, a paper run whose heartbeat is
old, a run marked running with no process, disk low, quota pace at STOP, a backup older than its
window — and exits non-zero as it does today. Today that verdict goes to a log file. After this
feature, the same cycle sends a failure report whose text is the watchdog's own verdict lines, so the
founder reads what failed on the phone without logging in.

**Why this priority**: The dead-man's switch says "silent"; this says "why", and it says it at the
next cycle instead of the next time someone opens a terminal. It reuses a verdict the project has
already invested in, with its documented failure signatures.

**Independent Test**: Stop one paper unit on the real box and wait one watchdog cycle. A failure
alert arrives containing the watchdog's verdict lines naming that run. Start the unit; the next
healthy cycle sends recovery.

**Acceptance Scenarios**:

1. **Given** all checks healthy, **When** one paper unit is stopped, **Then** the next watchdog
   cycle sends a failure report and the alert text contains the failing check's name and detail.
2. **Given** a failure alert is open, **When** the cause is fixed and the next cycle is healthy,
   **Then** a recovery notice arrives and the alert is closed.
3. **Given** the watchdog produces only warnings and no failures, **When** the cycle completes,
   **Then** it reports healthy; warnings do not page the founder (they remain in the log and the
   dashboard).
4. **Given** a failure report is sent, **Then** its text contains no secret, no connection string,
   no key, and nothing that identifies a person; it may contain run ids, unit names, counts and
   timestamps.

---

### User Story 3 - A unit dies and the alert is immediate (Priority: P3)

A paper unit crash-loops until the restart limit stops it; the collector exits with an error; the
nightly backup fails. Each of these is a discrete event with a known unit name. After this feature,
the failing unit itself sends an alert at the moment it fails, naming the unit and the failure,
instead of waiting up to 15 minutes for the watchdog to notice the consequence.

**Why this priority**: The watchdog cycle is a ceiling on detection time, not a floor. A unit
failure is known to the system the instant it happens; a backup failure otherwise surfaces only when
the watchdog's "newest backup age" check crosses its bound, which is measured in hours. This story
is lower priority than the first two only because the watchdog would eventually catch most of these.

**Independent Test**: Make one paper unit fail on the real box (a bad argument, or a forced
non-zero exit) so its restart limit is reached. An alert naming that unit arrives within two minutes
of the final failure. Repeat for the backup unit with a forced failure.

**Acceptance Scenarios**:

1. **Given** a paper unit that fails on start, **When** its restart limit is reached, **Then** an
   alert naming the unit and "start limit hit" arrives within two minutes.
2. **Given** the backup unit fails, **When** it exits non-zero, **Then** an alert naming the backup
   and the exit status arrives within two minutes, without waiting for the watchdog's age check.
3. **Given** the collector unit exits non-zero and is restarted by the service manager,
   **When** this happens repeatedly within the restart window, **Then** exactly one alert per
   restart-limit event is sent, not one per restart.

---

### User Story 4 - Planned maintenance does not page anyone (Priority: P4)

The founder is about to run a cutover: stop the runs, rotate a password, deploy, start new runs.
Every one of those steps is, from the watchdog's point of view, a failure. Before starting, the
founder declares maintenance for a stated duration; during it, failure reports and unit alerts are
suppressed, silence is still detected (the box must keep reporting "in maintenance, alive"), and
when the window ends or is ended early, normal alerting resumes and says so.

**Why this priority**: Without this, the first cutover after shipping the feature trains the
founder to ignore alerts, which is worse than having none. It is P4 because a cutover is rare and
the founder can tolerate a known burst of alerts once; it is in scope because the runbook already
has a cutover and this feature makes that runbook page.

**Independent Test**: Declare maintenance on the real box, stop all paper units, wait two watchdog
cycles: no failure alert. End maintenance with the units still stopped: the next cycle alerts.

**Acceptance Scenarios**:

1. **Given** maintenance is declared for N minutes, **When** paper units are stopped and the
   watchdog runs, **Then** no failure alert is sent and the dead-man's switch still receives a
   healthy-in-maintenance report each cycle.
2. **Given** maintenance is declared, **When** the box goes fully silent, **Then** the silence alert
   still fires — maintenance never suppresses the dead-man's switch.
3. **Given** maintenance was declared for N minutes, **When** N minutes pass, **Then** alerting
   resumes automatically and a notice says maintenance ended; a forgotten maintenance flag cannot
   silence the box indefinitely.

---

### User Story 5 - The founder can prove it works, on the box, on demand (Priority: P5)

Every mechanism above is verified on the real VPS, not in a harness, before it is trusted, and can
be re-verified any time with a single command that sends a test alert and reports whether the
external service accepted it. The runbook gains a drill section with the exact steps and the
expected arrival times, and the first execution of each drill is recorded with timestamps.

**Why this priority**: The project's rule since #122 and #127: a script that has never completed
on the box it was written for is untested, whatever its harness says. An alerting system that has
never alerted is the same thing.

**Independent Test**: Run the self-test command on the real box; the founder's phone shows a test
alert within one minute and the command's output says the service accepted the report.

**Acceptance Scenarios**:

1. **Given** the feature is deployed, **When** the founder runs the self-test, **Then** a clearly
   labelled test alert arrives within one minute and the command exits zero.
2. **Given** the reporting URL is wrong or the service rejects it, **When** the self-test runs,
   **Then** it exits non-zero with the service's response, and the deploy runbook treats that as a
   blocking failure.
3. **Given** the drills in the runbook, **When** each is executed for the first time, **Then** the
   observed arrival time of each alert is recorded next to the expected bound.

---

### Edge Cases

- **The alerting service itself is down.** The box cannot report; the service cannot alert. The
  founder must accept that one external dependency, choose one with a published uptime record, and
  the self-test must distinguish "box could not reach service" from "service rejected report".
- **Alert storms.** A flapping check (healthy, failed, healthy, failed) must not send an alert per
  flip. One alert on transition to failed, one recovery on transition to healthy, and a rate limit
  on repeats of the same open alert.
- **The reporting URL is a secret.** It lives only in the environment file, is never logged, never
  appears in a process list, never in a commit; the spec's checklist and the repo's existing secret
  hygiene apply. If it leaks, rotating it is a one-line change and the self-test proves the new one.
- **Maintenance flag left set.** It expires by itself; there is no permanent silence mode.
- **Silence during maintenance.** Detected and alerted; maintenance suppresses failure content, not
  liveness.
- **The box's clock is wrong.** Timestamps in alerts are the service's receive time, not the box's;
  the box's own timestamps are included as data.
- **Memory.** The box has roughly 825 MB available with four paper runs on 2 GB. The feature adds
  no long-running process; it runs inside the existing watchdog cycle and inside unit failure
  handlers, each short-lived.
- **Warnings versus failures.** The watchdog already distinguishes them. A cycle with warnings only
  is healthy for the dead-man's switch; warnings appear in the report body so a reader sees them,
  but they never page.
- **The first cycle after deploy.** The service's expectation of a schedule begins with the first
  report; the deploy runbook sends the first report (the self-test) before declaring the deploy done.
- **Two boxes reporting to one check.** Not supported; one check per box, named for the box.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On every scheduled watchdog cycle that ends healthy, the box MUST report "alive" to an
  external service that expects the report on that schedule.
- **FR-002**: When the external service has not received an "alive" report for longer than the
  silence bound, it MUST deliver an alert to the founder's phone naming the box and the time of the
  last report, with no action required on the box.
- **FR-003**: The silence bound MUST be configurable and MUST default to two watchdog periods plus a
  grace of five minutes (35 minutes at the current 15-minute period).
- **FR-004**: On every watchdog cycle that ends with at least one failure, the box MUST send a
  failure report whose body is the watchdog's verdict lines, and the founder MUST receive an alert
  containing that body.
- **FR-005**: A cycle that ends with warnings only MUST count as healthy for FR-001 and MUST include
  the warning lines in the report body without paging.
- **FR-006**: Alerts MUST be sent on transition (healthy to failed, failed to healthy), not on every
  cycle; a repeat of an already-open failure MUST be rate-limited to at most one reminder per hour.
- **FR-007**: When a failure alert is open and a subsequent cycle is healthy, the founder MUST
  receive a recovery notice and the alert MUST close without acknowledgement.
- **FR-008**: Each paper unit, the collector unit and the backup unit MUST send an alert naming the
  unit and the failure at the moment the unit's restart limit is reached, or at the moment a
  one-shot unit exits non-zero, within two minutes.
- **FR-009**: The founder MUST be able to declare maintenance for a stated duration, during which
  failure reports (FR-004) and unit alerts (FR-008) are suppressed while liveness reports (FR-001)
  continue; maintenance MUST expire on its own and MUST announce its start and end.
- **FR-010**: Maintenance MUST NOT suppress the silence alert (FR-002).
- **FR-011**: The founder MUST be able to run a single self-test command on the box that sends a
  clearly labelled test alert and exits zero only if the service confirmed receipt; a deploy is not
  complete until the self-test has passed.
- **FR-012**: No report or alert body MAY contain a secret, a connection string, a key, a token, or
  information identifying a person. Run ids, unit names, counts, ages and timestamps are permitted.
- **FR-013**: The reporting credential MUST live only in the environment file on the box, MUST never
  be written to any log or process list, and MUST be rotatable by editing that file and re-running
  the self-test.
- **FR-014**: The feature MUST add no long-running process to the box; all reporting runs within the
  existing watchdog cycle or within a unit's failure handler and completes within seconds.
- **FR-015**: A failure to reach the external service during a report MUST be logged on the box with
  the reason and MUST NOT change the watchdog's exit status or the unit's own behaviour.
- **FR-016**: The runbook MUST gain a drill section covering silence, failure, unit failure,
  maintenance and self-test, each with the expected arrival bound, and each drill MUST be executed
  once on the real box with the observed times recorded before the feature is declared done.
- **FR-017**: The alert channel and escalation policy MUST be [NEEDS CLARIFICATION: provider and
  channel — a hosted dead-man's-switch service with phone push, a self-hosted push server, or e-mail
  only; and escalation — push only, or push then repeat, and whether quiet hours apply].

### Key Entities

- **Check**: the external service's expectation of one box's schedule; has a period, a grace, a
  state (up, down, paused), the time of the last report, and a unique reporting credential.
- **Report**: one message from the box to the check; kind (alive, fail, start-of-maintenance,
  end-of-maintenance, test), a timestamp, and a body of verdict lines with no secrets.
- **Alert**: a notification delivered to the founder; kind (silence, failure, unit failure, recovery,
  maintenance, test), the box, the time, the body; opened on a transition, closed on recovery.
- **Maintenance window**: a declared interval during which failure and unit alerts are suppressed;
  has a start, a duration, and an announcement at each end.
- **Unit failure event**: the identity of a service unit and the reason it stopped (start limit hit,
  non-zero exit) at the moment it happened.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When the box stops reporting for any reason, the founder's phone shows a silence alert
  within 35 minutes of the last healthy report, verified on the real box by stopping the watchdog
  timer.
- **SC-002**: When a watchdog check fails, the founder's phone shows the failing check's name and
  detail within one watchdog period (15 minutes) of the failure, verified by stopping one paper unit.
- **SC-003**: When a unit reaches its restart limit or the backup fails, an alert naming the unit
  arrives within two minutes, verified by forcing each on the real box.
- **SC-004**: During a declared maintenance window with every paper unit stopped, zero failure or
  unit alerts are delivered across at least two watchdog periods, and the silence alert still fires
  if the timer is also stopped.
- **SC-005**: A flapping check produces at most one failure alert and one recovery per transition,
  and at most one reminder per hour while open, verified with a forced alternating failure.
- **SC-006**: The self-test delivers a labelled test alert within one minute and exits zero; with a
  deliberately wrong credential it exits non-zero within one minute naming the reason.
- **SC-007**: A search of the repository, the box's logs and the alert history for the reporting
  credential finds it only in the environment file.
- **SC-008**: Available memory on the box after the feature is within 20 MB of before, measured
  with the same four paper runs and collector active.
- **SC-009**: Every drill in FR-016 has a recorded first execution with observed times, and the M3
  cutover's "approved at 00:45, executed at 11:24" gap could not recur unnoticed: a stopped run
  now pages within one watchdog period.

## Assumptions

- The founder is the only recipient; there is no on-call rotation and no second person to escalate
  to. The escalation question (FR-017) is about repetition and quiet hours, not about people.
- The existing watchdog's verdict format and its exit code convention (non-zero on any failure,
  warnings do not fail) are stable and are the source of truth for "healthy" and "failed".
- The 15-minute watchdog period stays; the feature does not shorten it. A tighter bound for unit
  failures comes from unit-level hooks (FR-008), not from a faster watchdog.
- "Phone" means a push notification or an e-mail the founder's phone displays; the spec does not
  require an app.
- One external service is acceptable as a dependency, on the reasoning that a dead-man's switch by
  definition cannot live on the thing it watches; the founder chooses it (FR-017) and its uptime
  record is part of that choice.
- Outbound network from the box to the chosen service is permitted by the existing firewall; the
  firewall closes inbound only.
- The dashboard remains the place to read detail; alerts are for being told, not for diagnosis.
- The backup unit's own success/failure signal is trustworthy for FR-008; verifying the remote copy
  is already part of that unit and out of scope here.
- The feature is verified on the real box (FR-016) because the 2026-09-16 rotation script proved
  twice that a harness passing says nothing about the box; the harness, if any, is in addition.
