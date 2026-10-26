# Manual steps and manual procedures

Many service procedures are done by people: on site, by phone, in another tool. A **manual step** documents such work in a Steward run, with the same run protocol PDF and audit chain as automated steps. A **manual procedure** is a process made of manual steps only.

A manual step is a _User task_ node in mode **manual**. The run waits at the step until it is done – and, if needed, until a second person has verified it.

## What a manual step asks for

| Part               | What it is                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instructions**   | Markdown (headings, lists, bold, links, tables). Templates like `{{ inputs.device }}` work. HTML is never interpreted: `<script>` stays text, in the web app and in the PDF. |
| **Checklist**      | Fixed items to tick, written as plain text. With _All items required_ the step can only be completed when every item is ticked.                                              |
| **Fields**         | Text, number, date and time, link (`http`/`https`), ticket reference. Each field is _off_, _optional_ or _required_, with a label and a hint. At most 20 fields.             |
| **Evidence files** | Screenshots, exports, photos: _off_, _optional_ (the default) or _required_. Up to 20 files of 20 MB each.                                                                   |
| **Second person**  | _Verified by a second person_: someone else checks the step before the run continues (see below).                                                                            |
| **After-the-fact** | How far before the run's start a "done at" time may be (0–30 days, default 0).                                                                                               |

A ticket field takes the ticket number, for example `INC0012345`. When a ticket reference with that number is documented under _Tickets_, the entry links to it.

The step's output (`saveAs`) holds what was entered: `checklist`, `fields` (by field id), `notAvailable`, `doneAt`, `evidence` (name, size, SHA-256), `completedBy`, `verifiedBy` and more. Later steps can use it, for example `{{ vars.replace.fields.newSerial }}`.

## Doing a manual step

1. Open _My tasks_ (or the run). The step shows its instructions, checklist, fields and evidence files.
2. Tick the checklist, fill in the fields and add the evidence files. You can remove a file again until you complete the step.
3. Something required is not available? Tick _not available_ next to the field (or the evidence) and say why. The step then always needs the second-person verification.
4. Done earlier, outside Steward? Switch on _Done earlier – enter it after the fact_, enter when it was done and why it is entered afterwards. See below.
5. Click _Complete step_.

Who may do the step: the step's _Who may decide_ list (users, teams, roles), otherwise everyone allowed to run or approve the process. The _four-eyes_ setting (the person who started the run may not decide) works as for approvals. Only that person adds or removes evidence files.

## Second-person verification (maker–checker)

When a step needs it, the person who completed it (A) cannot continue the run alone. A second person (B) checks what A entered and the evidence:

- **Confirm verification** – the run continues.
- **Send back** (with a comment, the default) – the step goes back to A. A sees the comment, corrects the entry and completes the step again. Earlier entries and their evidence files stay in the protocol.
- **Reject** (with a comment, when the step's _When the verifier rejects_ is _Fail the run_) – the run fails.

Rules, checked on the server:

- B is never A – also not under a former name from a moved instance (identity aliases, see [MIGRATION.md](MIGRATION.md)).
- With _Not the person who started the run either_, B is not the run starter.
- _Who may verify_ (users, teams, roles) restricts B. The list is strict: administrators are not added. Empty = everyone allowed to run or approve the process.
- A step is always verified when something required was _not available_ or when it was entered after the fact – whatever the step's settings.
- A step sent back 25 times fails the run.

The start page tile _Waiting for you_, _My tasks → Mine_ and the daily summary include steps you may verify. The verifiers get a notification (_Verification needed_); A gets one when the step is sent back. Both use the notification event `task.assigned`.

## After-the-fact entries

For work done outside Steward, the person records **done at** with a reason. Steward stores both times: the stated _done at_ and when it was entered.

- The stated time may not be in the future.
- It may not be before the run started, unless the step allows back-dating: _Allow a "done at" time up to N days before the run started_ (at most 30 days).
- Such an entry always needs the second-person verification.

## Manual procedures

- _Processes → New manual procedure_ creates a process of three manual steps (prepare, carry out, check) to fill in.
- _Processes → From template_ has the example _Industrial Edge – Replace an Edge device on site (manual procedure)_ (`examples/processes/85-manual-edge-device-replacement.yaml`).
- Mixed processes work as before: automated steps with manual checkpoints in between. The run waits at each one.

In YAML:

```yaml
steps:
  - id: replace
    type: userTask
    mode: manual
    title: 'Replace {{ inputs.device }}'
    instructions: |
      Power the device off, swap it and onboard the new one.
    checklist: [Old device removed, New device onboarded]
    checklistAllRequired: true
    fields:
      - { id: newSerial, type: text, label: Serial number of the new device, use: required }
      - { id: change, type: ticket, label: Change ticket }
    evidence: required # off | optional (default) | required
    verification:
      required: true
      verifiers: [role:approver] # optional; empty = run or approve rights
      notRunStarter: true # optional
      onReject: return # return (default) | fail
    backdateDays: 2 # optional, 0–30
```

Existing user tasks (`select`, `approve`) are unchanged.

## Records and evidence

- **Run protocol PDF:** a section _Manual steps_ shows, per step, the instructions, the checklist with its ticks, the fields, the evidence files (name, size, SHA-256; PNG and JPEG images as small thumbnails), who completed it and when, the stated _done at_ time with its reason, who verified it and when, the _not available_ reasons and the entries that were sent back.
- **Protocol seal:** the protocol hash covers the entries, the verifications and the evidence files of manual steps (runs without manual steps hash as before).
- **Audit log:** `task.completed` (with the checklist, the fields and the _not available_ reasons), `task.backdated`, `task.evidence_added`, `task.evidence_removed`, `task.verified`, `task.verification_rejected`.
- **Public API:** `GET /api/v1/tasks/{taskId}` has a `manual` object (checklist, fields, evidence files with SHA-256, who completed and verified it); tasks and run decisions have `mode: manual` and a `stage` (`work`, `verify`, `done`).

## Evidence files

Evidence files are stored like record attachments ([RECORDS.md](RECORDS.md)):

- Allowed types: PDF, PNG, JPEG, GIF, WebP, e-mail (`.eml`, `.msg`), Office and OpenDocument files, text, Markdown and CSV. The content must match the extension.
- Files are written once, read-only, below `<data>/artifacts/<run id>/evidence/`, with their SHA-256. A file changed on disk is refused at download.
- Downloads are always attachments (`Content-Disposition: attachment`, a sandbox CSP, `nosniff`): a file is never shown as a page.
- Whoever may see the run may download them. Only the person working on the step adds or removes them, and only until the step is completed.
- They are deleted with their run by the retention cleanup and move with the run in a migration package (checked again on import).
