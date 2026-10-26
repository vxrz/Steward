import { describe, expect, it } from 'vitest';
import { BRAND, REPORT_ACCENT_MIN_CONTRAST, REPORT_BRANDING_DEFAULTS, contrastRatio, reportAccentNotes } from '@sm/shared';

/** Readability of the report accent colour (Settings → Report branding), like the theme's contrast notes. */
describe('report accent colour readability', () => {
  it('has no note for the default, the offered swatches and dark colours', () => {
    expect(REPORT_BRANDING_DEFAULTS.accentColor).toBe(BRAND.color);
    for (const c of [REPORT_BRANDING_DEFAULTS.accentColor, '#1c7ed6', '#0b7285', '#2f9e44', '#e8590c', '#c2410c', '#862e9c', '#343a40'])
      expect(reportAccentNotes(c), c).toEqual([]);
  });

  it('warns when lines and bars would barely stand out from the white page', () => {
    const notes = reportAccentNotes('#ffe066');
    expect(notes.map((n) => n.kind)).toEqual(['graphics']);
    expect(notes[0]!.ratio).toBeCloseTo(contrastRatio('#ffe066', '#ffffff'), 5);
    expect(notes[0]!.ratio).toBeLessThan(REPORT_ACCENT_MIN_CONTRAST);
    // just above the line: no note
    expect(reportAccentNotes('#2f9e44')).toEqual([]);
  });

  it('ignores an invalid colour (the form shows its own error)', () => {
    expect(reportAccentNotes('blue')).toEqual([]);
    expect(reportAccentNotes('#12345')).toEqual([]);
  });
});
