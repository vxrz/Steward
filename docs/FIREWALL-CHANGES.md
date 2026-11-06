# Firewall changes and network segments

Steward documents firewall changes in an audit-proof way – only for what needs it. Typical cases:

- **Network segments** such as shopfloor IoT VLANs or rVLANs with assets behind a firewall.
- **Systems** (servers, appliances) whose firewall a provider manages through its own change process.

Steward is **not a CMDB and not an IP address management tool**. Nothing has to be documented: systems in AWS or elsewhere need no network data at all, and a segment needs nothing but a name. Steward checks the format of what you enter (VLAN IDs, CIDR subnets, addresses) – it does not check overlaps, does not push rules to firewalls and does not read live rules from them.

What you get:

| Question an auditor asks             | Where Steward answers it                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Who asked for the change, and why?   | The firewall change (`FWC`): author, reason, risk, rule lines – frozen when it is submitted              |
| Who approved it?                     | _Approve_ by an approver who did not write it (four-eyes), with the content hash in the audit log        |
| What did the provider do?            | The provider's ticket (field and ticket reference), its confirmation as **evidence** with SHA-256        |
| Was it checked?                      | _Verify_ by someone other than the person who marked it implemented, after evidence was added            |
| Which rules are approved now?        | The **Approved firewall rules** document (`FWR`) of the segment or system: one edition per change        |
| Are the rules still needed?          | The yearly review (recertification) of that document, with reminders                                     |
| Is the trail complete and untouched? | The hash-chained audit log, the PDF of every change and edition, frozen content checked before each step |

## Network segments

A network segment is a **system** of the kind _Network segment_ (`network`) under _Catalogue → Systems_. Everything systems have works for it – owners, owning teams, environments, the CMDB link, documents, maintenance windows, _Duplicate_ – and applications can _run on_ it like on any system, so it shows on a service's _Systems_ tab.

A segment has these **optional attributes**:

| Attribute              | Format                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| VLAN ID                | 1–4094                                                                                   |
| Subnets                | CIDR notation, IPv4 or IPv6 (`10.20.30.0/24`, `2001:db8:30::/48`), up to 32; format only |
| Zone or security level | free text, e.g. an IEC 62443 zone (`Zone 2 – cell`, `SL 2`)                              |
| Site                   | free text                                                                                |
| Firewall managed by    | own team or a provider (with the provider's name)                                        |

Other kinds of systems have no attributes. A segment with systems in it can neither be deleted nor changed into another kind – take the systems out first.

**Duplicate** on a segment copies its attributes, owners (with _copy the access settings_) and the stack entered by hand – not the systems in it. Duplicating a system puts the copy into the same segments, **without** the original's addresses.

## Systems in segments

Any system can have a **network context**: on the system page, _Firewall & network → Add to segment_ names a segment the system is in, with an optional **address** (an IP address, v4 or v6, or a host name) and a note. A system is in at most 20 segments. The segment's page lists the systems in it.

Who may change the system changes its segments; adding a system to a segment needs only to see the segment. A segment or a system someone may not see (owning teams, [TEAMS.md](TEAMS.md)) is left out for them.

## The "Firewall & network" panel

The system page shows, for every system:

- the **segments** it is in, with its address and the segment's VLAN and zone; on a segment, the **systems in it**;
- the **approved firewall rules** – the `FWR` document with the edition valid now, its rules, whether the next edition is pending, its review status and the next review;
- the **firewall changes** that name the system, open ones first, with the number of rule lines, who implements them and the provider's ticket; _New firewall change_ starts one that names the system as affected;
- the **ticket references** that name the system as affected (e.g. the provider's change tickets), with _Add_.

Records that link to the system appear under _Linked from_. Everything follows the reader's rights: records, tickets and systems they may not see are left out.

## Firewall change (FWC)

A built-in document type, next to `CR`, created in every installation (also existing ones, on the first start of 0.5.0; if an installation already used the key `FWC`, it gets `FWCH`). Workflow _change_.

| Field               | Kind                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| Reason\*            | text (several lines)                                                          |
| Risk\*              | low / medium / high                                                           |
| Implemented by\*    | internal / provider                                                           |
| Provider            | text                                                                          |
| Provider ticket     | text – the provider's ticket number; add the ticket as a ticket reference too |
| Planned start / end | date and time – the maintenance window (reports list it with change windows)  |
| Rollback plan       | text (several lines)                                                          |
| Rules\*             | table, one row per rule line                                                  |

The **affected segments and systems** are links of the kind _System_ (note _affected_); a firewall change cannot be submitted without one. With the plant registry on, a change can also link to the **IEC 62443-3-2 conduit** it changes (link kind _Conduit_, [PLANT.md](PLANT.md#zones-and-conduits)); the conduit lists the changes that name it. The **rule lines** are a [table field](RECORDS.md#table-fields) with the columns _Change_ (add / remove), _Source_, _Destination_, _Protocol/port_ (`tcp/443`), _Action_ (allow / deny), _Enforced at_ (perimeter firewall, host firewall, cloud security group), _Purpose_ and _Expiry_ (a date, for temporary rules).

### Steps

```
Draft ─submit─▶ Submitted ─approve (four-eyes)─▶ Approved ─implement─▶ Implemented ─verify (second person)─▶ Verified ─close─▶ Closed
   (requested)                                       │   evidence files can be added   │
                                                     └──────────────────────────────────┘
```

| Step            | Who                                                                                         | What Steward checks and records                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Requested**   | Editors (designer, operator, administrator, the owner)                                      | Submitting freezes the content (rule lines included) and records its hash; it needs an affected segment or system                                                                                                                                                                   |
| **Approved**    | Approvers and administrators – not the owner, author, submitter or anyone who wrote content | Four-eyes; the approval names the hash the approver saw                                                                                                                                                                                                                             |
| **Implemented** | Editors                                                                                     | The comment says what was done (e.g. the provider's ticket)                                                                                                                                                                                                                         |
| **Evidence**    | Editors, while _Approved_ or _Implemented_                                                  | Files (the provider's confirmation as `.eml`/`.msg`/PDF, a rule export as CSV, a screenshot): not content – the approved content and its hash stay as they are –, each audited with its SHA-256, never removed. A link to a run (e.g. of the template below) counts as evidence too |
| **Verified**    | Editors and approvers – **not the person who marked it implemented**                        | Only with evidence (a file or a run link); the comment says how it was checked                                                                                                                                                                                                      |
| **Closed**      | Editors                                                                                     | Updates the approved rules (below); final                                                                                                                                                                                                                                           |

The record is frozen from _Submitted_ on, signed in the audit chain at every step and exportable as a PDF (with the rule lines as a table and the evidence with its hashes). A rejected change is reworked as a new revision (_Rework_).

The _verify_ step is part of the change workflow for every change type: change requests (`CR`) can be verified the same way, but for them it stays optional – a change request still closes from _Implemented_. A firewall change must be verified before it is closed.

**Before closing**, the content tab shows each affected item **against its approved rules**: per rule line whether it is a new rule, changes an approved one (same source, destination, protocol/port and enforcement point), is approved already, removes one – or removes nothing that is approved.

## Approved firewall rules (FWR)

A built-in **living document** type ([RECORDS.md](RECORDS.md#living-documents)): one document per segment or system (it links to it, note _applies to_), its table field _Approved rules_ with the rule columns and _Approved by change_. Review every 12 months.

**Closing a firewall change** applies its rule lines to the document of each affected segment and system – _add_ lines add or replace the rule with the same source, destination, protocol/port and enforcement point, _remove_ lines take it out – and **submits the next edition** (the first one is 1.0, then minor editions 1.1, 1.2, …) with the change's number and title as the change summary. An approver who did not close the change **approves the edition**: only then is it the approved state. Without a document Steward creates one (_Approved firewall rules – <system>_), owned by the teams of the change.

- If the document already waits for approval (an earlier change), the change cannot be closed until that edition is approved or rejected – the next change always shows what changes against an approved state.
- Who closes the change must be allowed to change the documents and see every affected system; otherwise Steward refuses and says why.
- The document can also be edited by hand like any living document (e.g. to record rules that existed before Steward).
- **Recertification**: the yearly review asks the review owner whether the rules are still needed (_Reviewed – no change_ or _Needs update_), with the usual reminders; rules with an expiry date are visible in the table.

An installation that does not want approved-rules documents archives the type `FWR` (_Documents → Document types_); closing then only closes the change.

## Process template: Firewall change via provider

`examples/processes/87-firewall-change-via-provider.yaml` (_Processes → From template_) runs the change as a documented manual procedure, built from steps that exist today: request → four-eyes approval → submit to the provider (ticket field) → wait for the provider's confirmation (evidence required) → an HTTP connectivity check against the `target` platform (skipped with an empty path) → verification by a second person → close. Link the run to the firewall change: it counts as its evidence, and the run protocol PDF lists every step, who did and who verified it and the SHA-256 of every evidence file ([MANUAL-STEPS.md](MANUAL-STEPS.md)). A TCP port can be watched with a monitor check of type `tcp` ([MONITORS.md](MONITORS.md)).

## Control mappings

New installations map the built-in types to ISO/IEC 27001:2022 Annex A: the firewall change to **8.20** (network security), **8.22** (segregation of networks) and **8.32** (change management), the approved rules to **8.20**, **8.21** (security of network services) and **8.22**. Existing installations map them under _Compliance → Controls_ (the control's panel → _Map_ → record type).

IEC 62443-3-3 is not built in (its text is copyrighted). To map **SR 5.1** (network segmentation) and **SR 5.2** (zone boundary protection), import a catalogue of your own (_Compliance → Controls → Import catalogue_, [COMPLIANCE.md](COMPLIANCE.md)), for example:

```yaml
key: IEC62443-3-3
name: IEC 62443-3-3 (system security requirements)
version: '2013'
description: Requirement identifiers with short topic names; add your licensed wording.
controls:
  - { ref: SR 5.1, title: network segmentation }
  - { ref: SR 5.2, title: zone boundary protection }
  - { ref: SR 5.3, title: general purpose person-to-person communication restrictions }
  - { ref: SR 5.4, title: application partitioning }
```

and map `FWC` and `FWR` to SR 5.1 and SR 5.2. The controls then show the firewall changes and the approved rules of a period as their evidence.

| Control                      | Steward evidence                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| ISO 27001 A.8.20, A.8.22     | Segments with zone and subnets; approved rules per segment; firewall changes       |
| ISO 27001 A.8.21             | Approved rules of provider-managed systems; the provider's tickets and evidence    |
| ISO 27001 A.8.32             | Firewall changes: request, four-eyes approval, implementation, verification, close |
| IEC 62443-3-3 SR 5.1, SR 5.2 | Segments (zones) and the approved rules at their boundaries (conduits)             |

## API

- Internal API: `POST /api/systems/:id/segments`, `PUT /api/systems/:id/segments/:segmentLinkId`, `DELETE /api/systems/:id/segments/:segmentLinkId` (who may change the system), `POST /api/records/:id/evidence` (multipart, editors, after the approval), `GET /api/records/:id/firewall` (the approved rules of what a change affects), `POST /api/systems/:id/duplicate`. A system's `attributes` are part of `POST`/`PUT /api/systems`.
- Public API: `GET /api/v1/systems` and `GET /api/v1/systems/:systemId` carry `attributes` and `segments`; records (`/api/v1/records`) carry the table field as a JSON string in `fields`, links of the kind `system` and attachments of the kind `evidence`.
- Audit: `system.segment_added`, `system.segment_changed`, `system.segment_removed`, `system.changed` (with the attribute changes), `record.evidence_added`, `record.verify`, and the edition entries of the approved rules.
