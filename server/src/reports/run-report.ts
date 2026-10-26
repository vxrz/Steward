import { ReportWriter, type CellInput, type Tone } from './pdf/engine.js';
import { translator, type MsgKey, type Translator } from './i18n.js';
import { PRODUCT, chrome, langTag, statusTone, type BrandingInput } from './common.js';
import { personLabel, type ManualStepModel, type Person, type RunReportModel } from './model.js';

export interface RenderResult {
  pdf: Buffer;
  /** All strings drawn (for tests and diagnostics) */
  texts: string[];
}

export async function renderRunReport(
  m: RunReportModel,
  contentHash: string,
  brand: BrandingInput,
  o: { images?: { id: string; data: Buffer }[]; compress?: boolean } = {},
): Promise<RenderResult> {
  const tr = translator(m.lang, m.timeZone);
  const { t } = tr;
  const footerHash = m.integrity.sealedHash ?? m.integrity.currentHash;
  const tags: { text: string; tone: Tone }[] = [];
  if (m.run.dryRun) tags.push({ text: t('dryRunTag'), tone: 'warning' });
  if (m.interim) tags.push({ text: t('interimTag'), tone: 'info' });

  const w = new ReportWriter(
    {
      title: `${t('runReport')}: ${m.process.name}`,
      author: m.generatedBy.displayName,
      subject: `${t('runReport')} ${m.run.id} – ${m.process.name} v${m.process.version} (${tr.v('status', m.run.status)})`,
      keywords: [PRODUCT.split(' ')[0]!, t('runReport'), m.process.name, m.run.id, m.run.status, ...(m.run.dryRun ? ['dry run'] : [])],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(m.lang),
      createdAt: new Date(m.generatedAt),
      custom: {
        reportId: m.reportId,
        reportKind: 'run',
        reportVersion: String(m.version),
        runId: m.run.id,
        processId: m.process.id,
        processVersion: String(m.process.version),
        definitionHash: m.process.definitionHash,
        protocolHash: m.integrity.currentHash,
        sealedProtocolHash: m.integrity.sealedHash ?? '',
        contentHash,
        runStatus: m.run.status,
        dryRun: String(m.run.dryRun),
        interim: String(m.interim),
        classification: m.classification,
        generatedBy: m.generatedBy.username,
        generatedAt: m.generatedAt,
      },
    },
    chrome(tr, brand, {
      shortTitle: `${t('runReport')} · ${m.process.name}`,
      classification: m.classification,
      tags,
      lines: () => [
        t('footerRun', { runId: m.run.id, date: tr.dateTime(m.generatedAt), user: personLabel(m.generatedBy), reportId: m.reportId }),
        t('footerHash', { hash: footerHash }) + (m.integrity.sealedHash ? '' : ` (${t('notSealed')})`),
        t('footerVerify', { reportId: m.reportId }),
      ],
    }),
    { accent: brand.branding.accentColor, compress: o.compress },
  );

  w.cover({
    title: t('runReport'),
    subtitle: m.process.name,
    meta: [t('generatedWith', { product: PRODUCT }), t('reportNo', { id: m.reportId }), t('version', { n: m.version }), tr.dateTime(m.generatedAt)],
  });

  // ---------- prominent banners ----------
  if (m.sample) w.banner(t('sampleNote'), '', 'info');
  if (m.run.dryRun) w.banner(t('dryRunTitle'), t('dryRunBody'), 'warning');
  if (m.interim) w.banner(t('interimTitle'), t('interimBody', { status: tr.v('status', m.run.status) }), 'info');
  if (m.integrity.intact === false) w.banner(t('modifiedTitle'), t('modifiedBody'), 'danger');
  if (m.run.status === 'failed') w.banner(t('failedTitle'), m.run.error ?? '', 'danger');
  if (m.run.status === 'cancelled') w.banner(t('cancelledTitle'), '', 'warning');

  // ---------- summary ----------
  let n = 0;
  const section = (title: string) => w.section(`${++n}. ${title}`);
  section(t('summary'));
  const trig =
    tr.v('trigger', m.run.trigger) +
    (m.run.triggerName ? ` – ${m.run.triggerName}` : '') +
    (m.run.scheduleName ? ` – ${m.run.scheduleName}` : '') +
    (m.run.parentRunId ? ` – ${t('parentRun')} ${m.run.parentRunId}` : '');
  w.keyValues([
    { label: t('process'), value: m.process.name },
    { label: t('processVersion'), value: String(m.process.version) },
    { label: t('runId'), value: m.run.id, mono: true },
    { label: t('status'), value: tr.v('status', m.run.status), tone: statusTone(m.run.status) },
    { label: t('trigger'), value: trig },
    { label: t('startedBy'), value: personLabel(m.run.actor) },
    { label: t('started'), value: tr.dateTime(m.run.startedAt) },
    { label: t('finished'), value: m.run.finishedAt ? tr.dateTime(m.run.finishedAt) : t('notFinished') },
    { label: t('duration'), value: tr.duration(m.run.durationMs) },
    { label: t('dryRun'), value: m.run.dryRun ? t('yes') : t('no'), tone: m.run.dryRun ? 'warning' : 'default' },
    { label: t('definitionHash'), value: m.process.definitionHash, mono: true, span: 2 },
  ]);
  if (m.process.description) {
    w.subheading(t('processDescription'));
    w.markdown(m.process.description.length > 1500 ? m.process.description.slice(0, 1500) + ' …' : m.process.description);
  }
  w.subheading(t('connections'));
  w.table(
    [
      { header: t('slot'), width: 1.4, mono: true },
      { header: t('platform'), width: 3 },
      { header: t('kind'), width: 2, mono: true },
      { header: t('environment'), width: 1.6 },
    ],
    m.connections.map((c) => [c.slot, c.platformName, c.kind ?? '–', c.environment ?? '–']),
    { empty: t('none') },
  );
  w.subheading(t('inputs'));
  w.table(
    [
      { header: t('input'), width: 2 },
      { header: t('value'), width: 6, mono: true },
    ],
    m.inputs.map((i) => [i.label ? `${i.label} (${i.name})` : i.name, i.value || '–']),
    { empty: t('none') },
  );

  w.subheading(t('atAGlance'));
  const s = m.run.stats;
  const completed = m.decisions.filter((d) => d.status === 'completed').length;
  w.stats([
    { label: t('statSteps'), value: String(s.steps) },
    { label: t('statFailedSteps'), value: String(s.failedSteps), tone: s.failedSteps ? 'danger' : 'default' },
    { label: t('statChanges'), value: String(s.writes) },
    { label: t('statSimulated'), value: String(s.skippedWrites), tone: s.skippedWrites ? 'warning' : 'default' },
    { label: t('statChecksPassed'), value: String(s.checksPassed), tone: s.checksPassed ? 'success' : 'default' },
    { label: t('statChecksFailed'), value: String(s.checksFailed), tone: s.checksFailed ? 'danger' : 'default' },
    { label: t('statDecisions'), value: `${completed}/${m.decisions.length}` },
  ]);

  // ---------- what was done ----------
  section(t('whatWasDone'));
  w.paragraph(t('stepsIntro'), { tone: 'muted', size: 8 });
  const runDay = tr.date(m.run.startedAt);
  const when = (iso: string | null) => (iso && tr.date(iso) !== runDay ? `${tr.date(iso)} ${tr.time(iso)}` : tr.time(iso));
  w.table(
    [
      { header: t('time'), width: 1.15 },
      { header: t('step'), width: 3.2 },
      { header: t('type'), width: 1.15, mono: true },
      { header: t('status'), width: 1.35 },
      { header: t('result'), width: 4.2 },
    ],
    m.steps.map((st): CellInput[] => [
      when(st.startedAt),
      { text: st.name, indent: st.depth },
      st.type,
      { text: tr.v('status', st.status), tone: statusTone(st.status) },
      { text: st.result, tone: st.failed ? 'danger' : 'default' },
    ]),
    { empty: t('none') },
  );
  if (m.stepsOmitted) w.paragraph(t('stepsTruncated', { n: m.stepsOmitted }), { tone: 'muted', size: 8 });

  // ---------- changes ----------
  section(t('changes'));
  w.paragraph(t('changesIntro') + (m.run.dryRun ? ' ' + t('changesIntroDry') : ''), { tone: 'muted', size: 8 });
  w.table(
    [
      { header: t('time'), width: 1.15 },
      { header: t('step'), width: 2.3 },
      { header: t('method'), width: 1, mono: true },
      { header: t('request'), width: 4.2, mono: true },
      { header: t('result'), width: 2.4 },
    ],
    m.writes.map((x): CellInput[] => [
      when(x.startedAt),
      x.name,
      x.method,
      x.url,
      x.status === 'dryrun'
        ? { text: t('notExecuted'), tone: 'warning' }
        : {
            text: `${x.httpStatus ? `HTTP ${x.httpStatus} · ` : ''}${tr.v('status', x.status)}${x.status === 'failed' && x.result ? ` – ${x.result}` : ''}`,
            tone: statusTone(x.status),
          },
    ]),
    { empty: t('noChanges') },
  );

  // ---------- decisions ----------
  section(t('decisions'));
  if (!m.decisions.length) w.paragraph(t('noDecisions'), { tone: 'muted' });
  for (const d of m.decisions) {
    w.subheading(`${d.mode === 'approve' ? t('decisionApprove') : t('decisionSelect')}: ${d.title}`);
    const outcome =
      d.status === 'open'
        ? t('openDecision')
        : d.status === 'cancelled'
          ? t('cancelledDecision')
          : d.mode === 'approve'
            ? d.approved
              ? t('approved')
              : t('rejected')
            : `${d.approved === false ? t('rejected') + ' · ' : ''}${t('selectedOf', { n: d.selectedCount, total: d.total })}`;
    const outcomeTone: Tone = d.status !== 'completed' ? 'info' : d.approved === false ? 'danger' : 'success';
    const items: Parameters<typeof w.keyValues>[0] = [
      { label: t('outcome'), value: outcome, tone: outcomeTone },
      { label: t('decidedBy'), value: personLabel(d.decidedBy) },
      { label: t('decidedAt'), value: tr.dateTime(d.decidedAt) },
      { label: t('assignedTo'), value: d.assignees.length ? d.assignees.join(', ') : t('anyone') },
    ];
    if (d.fourEyes)
      items.push({
        label: t('fourEyes'),
        value: d.decidedBy
          ? t('fourEyesOk', { decider: personLabel(d.decidedBy), starter: personLabel(d.startedBy) })
          : t('fourEyesOpen', { starter: personLabel(d.startedBy) }),
        span: 2,
      });
    items.push({ label: t('decisionComment'), value: d.comment ?? '–', span: 2 });
    w.keyValues(items);
    if (d.instructions) {
      w.markdown(d.instructions.length > 1200 ? d.instructions.slice(0, 1200) + ' …' : d.instructions);
    }
    if (d.mode === 'select' && (d.items.length || d.total)) {
      const cols = d.columns.slice(0, 6);
      w.table(
        [{ header: t('selected'), width: 1 }, ...(cols.length ? cols : [t('item')]).map((c) => ({ header: c, width: 8 / Math.max(1, cols.length) }))],
        d.items.map((i): CellInput[] => [
          i.selected === null ? '–' : i.selected ? { text: '✓', tone: 'success', bold: true } : { text: '–', tone: 'muted' },
          ...i.cells.slice(0, Math.max(1, cols.length)),
        ]),
        { empty: t('none') },
      );
      if (d.itemsOmitted) w.paragraph(t('itemsTruncated', { n: d.itemsOmitted }), { tone: 'muted', size: 8 });
    }
  }

  // ---------- manual steps ----------
  if (m.manualSteps.length) {
    section(t('manualSteps'));
    w.paragraph(t('manualStepsIntro'), { tone: 'muted', size: 8 });
    for (const st of m.manualSteps) manualStep(w, tr, st, o.images ?? []);
  }

  // ---------- checks ----------
  section(t('checks'));
  if (!m.checks.length) w.paragraph(t('noChecks'), { tone: 'muted' });
  else
    w.table(
      [
        { header: t('result'), width: 1.3 },
        { header: t('check'), width: 3 },
        { header: t('severity'), width: 1.2 },
        { header: t('message'), width: 5 },
      ],
      m.checks.map((c): CellInput[] => [
        { text: c.passed ? t('passed') : t('failed'), tone: c.passed ? 'success' : 'danger', bold: true },
        c.name,
        tr.v('severity', c.severity),
        c.message,
      ]),
    );

  // ---------- results authored by the process ----------
  if (m.sections.length) {
    section(t('processReports'));
    for (const r of m.sections) {
      w.subheading(r.title);
      if (r.text) w.markdown(r.text);
      if (r.columns.length || r.rows.length) {
        const cols = r.columns.length ? r.columns : (r.rows[0] ?? []).map((_, i) => `#${i + 1}`);
        w.table(
          cols.map((c) => ({ header: c, width: 1 })),
          r.rows,
          { empty: t('noRows') },
        );
        if (r.rowsOmitted) w.paragraph(t('itemsTruncated', { n: r.rowsOmitted }), { tone: 'muted', size: 8 });
      }
    }
  }

  // ---------- evidence ----------
  section(t('evidence'));
  if (!m.evidence.length) w.paragraph(t('noEvidence'), { tone: 'muted' });
  else {
    w.table(
      [
        { header: t('file'), width: 2.4 },
        { header: t('step'), width: 1.8, mono: true },
        { header: 'SHA-256', width: 4.4, mono: true },
        { header: t('size'), width: 1, align: 'right' },
        { header: t('recorded'), width: 1.6 },
      ],
      m.evidence.map((e) => [e.name, e.stepKey, e.sha256, tr.bytes(e.size), when(e.createdAt)]),
    );
    const imgs = (o.images ?? [])
      .map((img) => ({ img, e: m.evidence.find((e) => e.id === img.id) }))
      .filter((x) => x.e)
      .map(({ img, e }) => ({ data: img.data, caption: `${e!.name} · ${e!.stepKey} · SHA-256 ${e!.sha256.slice(0, 16)}…` }));
    if (imgs.length) w.images(imgs);
  }

  // ---------- errors ----------
  section(t('errors'));
  if (!m.errors.length) w.paragraph(t('noErrors'), { tone: 'muted' });
  else
    w.table(
      [
        { header: t('time'), width: 1.2 },
        { header: t('step'), width: 2.4 },
        { header: t('message'), width: 6.4 },
      ],
      m.errors.map((e): CellInput[] => [when(e.at), e.where || t('runError'), { text: e.message, tone: 'danger' }]),
    );

  // ---------- comments ----------
  section(t('comments'));
  w.subheading(t('reviewerComment'));
  if (m.comment) {
    w.keyValues([{ label: t('reviewerCommentBy', { user: personLabel(m.generatedBy), date: tr.dateTime(m.generatedAt) }), value: m.comment, span: 2 }]);
  } else w.paragraph(t('noReviewerComment'), { tone: 'muted' });
  w.subheading(t('decisionComments'));
  const commented = m.decisions.filter((d) => d.comment);
  if (!commented.length) w.paragraph(t('noDecisionComments'), { tone: 'muted' });
  else
    w.table(
      [
        { header: t('decisions'), width: 3 },
        { header: t('decidedBy'), width: 2.2 },
        { header: t('decidedAt'), width: 1.8 },
        { header: t('decisionComment'), width: 5 },
      ],
      commented.map((d) => [d.title, personLabel(d.decidedBy), tr.dateTime(d.decidedAt), d.comment!]),
    );

  // ---------- integrity ----------
  section(t('integrity'));
  w.keyValues([
    {
      label: t('integrityStatus'),
      value: m.integrity.intact === null ? t('notSealed') : m.integrity.intact ? t('intact') : t('modified'),
      tone: m.integrity.intact === null ? 'info' : m.integrity.intact ? 'success' : 'danger',
      span: 2,
    },
    { label: t('sealedHash'), value: m.integrity.sealedHash ?? '–', mono: true, span: 2 },
    ...(m.integrity.importedFrom
      ? [{ label: t('sealVerifiedAgainst'), value: t('importedHistoryOf', { fingerprint: m.integrity.importedFrom }), span: 2 as const }]
      : []),
    { label: t('currentHash'), value: m.integrity.currentHash, mono: true, span: 2 },
    { label: t('contentHash'), value: contentHash, mono: true, span: 2 },
    { label: t('reportId'), value: m.reportId, mono: true },
    { label: t('runId'), value: m.run.id, mono: true },
  ]);
  w.subheading(t('howToVerify'));
  w.paragraph(t('verify1', { reportId: m.reportId }), { size: 8.5 });
  w.paragraph(t('verify2'), { size: 8.5 });
  w.paragraph(t('verify3'), { size: 8.5 });
  w.subheading(t('auditTrail'));
  w.paragraph(t('auditIntro'), { tone: 'muted', size: 8 });
  w.table(
    [
      { header: t('seq'), width: 0.7, align: 'right' },
      { header: t('time'), width: 2 },
      { header: t('actor'), width: 1.3 },
      { header: t('action'), width: 1.9, mono: true },
      { header: t('summary'), width: 4.2 },
      { header: t('hash'), width: 1.9, mono: true },
    ],
    m.audit.map((a) => [String(a.seq), tr.dateTime(a.ts), a.actor, a.action, a.summary, a.hash.slice(0, 16) + '…']),
    { size: 7.2 },
  );
  if (m.auditOmitted) w.paragraph(t('auditTruncated', { n: m.auditOmitted }), { tone: 'muted', size: 8 });

  // ---------- sign-off ----------
  signOff(w, tr, m, `${++n}. ${t('signoff')}`);

  const pdf = await w.finish();
  return { pdf, texts: w.texts };
}

function manualStep(w: ReportWriter, tr: Translator, st: ManualStepModel, images: { id: string; data: Buffer }[]): void {
  const { t } = tr;
  w.subheading(`${t('manualStep')}: ${st.title}`);
  const outcome =
    st.status === 'cancelled'
      ? t('cancelledDecision')
      : st.status === 'completed'
        ? st.verificationApproved === false
          ? t('manualRejected')
          : st.verificationApproved
            ? t('manualVerified')
            : t('manualDone')
        : st.stage === 'verify'
          ? t('manualWaitingVerification')
          : t('manualOpen');
  const tone: Tone = st.verificationApproved === false ? 'danger' : st.status === 'completed' ? 'success' : 'info';
  const reasons = st.verificationReasons.map((r) => t(`reason_${r}` as MsgKey)).join(', ');
  const who = st.verifiers.length ? st.verifiers.join(', ') : t('anyone');
  const items: Parameters<typeof w.keyValues>[0] = [
    { label: t('outcome'), value: outcome, tone, span: 2 },
    { label: t('completedBy'), value: personLabel(st.completedBy) },
    { label: t('enteredAt'), value: tr.dateTime(st.completedAt) },
  ];
  if (st.doneAt) {
    items.push({ label: t('doneAtStated'), value: tr.dateTime(st.doneAt), tone: 'warning' });
    items.push({ label: t('doneAtReason'), value: st.doneAtReason ?? '–' });
  }
  items.push({ label: t('verification'), value: st.verificationRequired ? t('verificationNeeded', { reasons }) : t('verificationNotNeeded'), span: 2 });
  if (st.verificationRequired) {
    items.push({ label: t('mayVerify'), value: t(st.notRunStarter ? 'mayVerifyNotStarter' : 'mayVerifyNotCompleter', { who }), span: 2 });
    items.push({ label: st.verificationApproved === false ? t('rejectedBy') : t('verifiedBy'), value: personLabel(st.verifiedBy) });
    items.push({ label: st.verificationApproved === false ? t('rejectedAt') : t('verifiedAt'), value: tr.dateTime(st.verifiedAt) });
    if (st.verificationComment) items.push({ label: t('verificationComment'), value: st.verificationComment, span: 2 });
  }
  items.push({ label: t('decisionComment'), value: st.comment ?? '–', span: 2 });
  w.keyValues(items);
  if (st.instructions) w.markdown(st.instructions.length > 3000 ? st.instructions.slice(0, 3000) + ' …' : st.instructions);

  if (st.checklist.length) {
    w.paragraph(st.checklistAllRequired ? t('checklistAllRequired') : t('checklist'), { bold: true, size: 8.5 });
    w.table(
      [
        { header: t('ticked'), width: 1 },
        { header: t('item'), width: 9 },
      ],
      st.checklist.map((c): CellInput[] => [
        c.checked === null ? '–' : c.checked ? { text: '✓', tone: 'success', bold: true } : { text: t('no'), tone: 'danger', bold: true },
        c.item,
      ]),
    );
  }
  if (st.fields.length) {
    w.paragraph(t('fieldsTitle'), { bold: true, size: 8.5 });
    w.table(
      [
        { header: t('field'), width: 3 },
        { header: t('value'), width: 5.4 },
        { header: '', width: 1.6 },
      ],
      st.fields.map((f): CellInput[] => [
        f.label,
        f.notAvailable ? { text: t('notAvailableValue', { reason: f.notAvailable }), tone: 'warning' } : f.value || '–',
        { text: f.required ? t('required') : t('optional'), tone: 'muted' },
      ]),
    );
  }
  if (st.notAvailable.length) {
    w.paragraph(t('notAvailableTitle'), { bold: true, size: 8.5 });
    w.table(
      [
        { header: t('what'), width: 3 },
        { header: t('reason'), width: 7 },
      ],
      st.notAvailable.map((n): CellInput[] => [n.what === 'evidence' ? t('evidenceTarget') : n.what, { text: n.reason, tone: 'warning' }]),
    );
  }
  w.paragraph(t('evidenceFiles'), { bold: true, size: 8.5 });
  if (st.evidenceMode === 'off' && !st.evidence.length) w.paragraph(t('evidenceOff'), { tone: 'muted', size: 8 });
  else if (!st.evidence.length) w.paragraph(t('evidenceNone'), { tone: 'muted', size: 8 });
  else {
    w.table(
      [
        { header: t('file'), width: 2.6 },
        { header: 'SHA-256', width: 4.4, mono: true },
        { header: t('size'), width: 1, align: 'right' },
        { header: t('addedBy'), width: 2 },
      ],
      st.evidence.map((e) => [e.filename, e.sha256, tr.bytes(e.size), `${personLabel(e.uploadedBy)} · ${tr.dateTime(e.uploadedAt)}`]),
    );
    const thumbs = st.evidence
      .map((e) => ({ e, img: images.find((i) => i.id === e.id) }))
      .filter((x) => x.img)
      .map(({ e, img }) => ({ data: img!.data, caption: `${e.filename} · SHA-256 ${e.sha256.slice(0, 16)}…` }));
    if (thumbs.length) w.images(thumbs);
  }
  if (st.returned.length) {
    w.paragraph(t('returnedTitle'), { bold: true, size: 8.5 });
    w.table(
      [
        { header: t('returnedEntry'), width: 2.6 },
        { header: t('rejectedBy'), width: 2.6 },
        { header: t('reason'), width: 2.6 },
        { header: t('evidenceFiles'), width: 2.6 },
      ],
      st.returned.map((r) => [
        `${personLabel(r.completedBy)} · ${tr.dateTime(r.completedAt)}`,
        `${personLabel(r.rejectedBy)} · ${tr.dateTime(r.rejectedAt)}`,
        r.comment || '–',
        r.evidence || '–',
      ]),
    );
  }
}

export function signOff(w: ReportWriter, tr: Translator, m: { generatedBy: Person; generatedAt: string; reportId: string }, title: string): void {
  const { t } = tr;
  w.ensure(270);
  w.section(title);
  w.paragraph(t('signoffIntro'), { tone: 'muted', size: 8 });
  w.signatureBlocks(
    [
      {
        title: t('preparedBy'),
        name: personLabel(m.generatedBy),
        date: tr.date(m.generatedAt),
        fieldName: 'Signature_PreparedBy',
        fieldHint: `${t('preparedBy')} – ${m.reportId}`,
      },
      { title: t('reviewedBy'), fieldName: 'Signature_ReviewedBy', fieldHint: `${t('reviewedBy')} – ${m.reportId}` },
      { title: t('approvedBy'), fieldName: 'Signature_ApprovedBy', fieldHint: `${t('approvedBy')} – ${m.reportId}` },
    ],
    { name: t('name'), role: t('role'), date: t('date'), signature: t('signature'), digital: t('digitalSignature') },
  );
}
