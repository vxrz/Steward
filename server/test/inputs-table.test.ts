import { describe, expect, it } from 'vitest';
import { parseTableCsv, readTableCsv, type InputDef } from '@sm/shared';
import { coerceInputs } from '../src/engine/inputs.js';

/**
 * Table inputs (`type: table`): CSV text with a header row – or, with declared columns, without one (the fields in the
 * column order). A required table that reads no rows is refused when the run starts.
 */

const COLUMNS = ['email', 'givenName', 'familyName', 'bundle'];
const users: InputDef = { name: 'users', label: 'Users (CSV)', type: 'table', columns: COLUMNS, required: true };

describe('table inputs', () => {
  it('a header row names the columns', () => {
    expect(parseTableCsv('email,givenName,familyName,bundle\nnew.operator@example.com,New,Operator,Engineer\n', COLUMNS)).toEqual([
      { email: 'new.operator@example.com', givenName: 'New', familyName: 'Operator', bundle: 'Engineer' },
    ]);
    // a header with only some of the columns, in another order
    expect(parseTableCsv('familyName,email\nOperator,new.operator@example.com', COLUMNS)).toEqual([
      { familyName: 'Operator', email: 'new.operator@example.com' },
    ]);
  });

  it('a header in another case takes the declared spelling', () => {
    const r = readTableCsv(' EMAIL , GivenName,FAMILYNAME\nnew.operator@example.com,New,Operator', COLUMNS);
    expect(r).toEqual({ headerless: false, rows: [{ email: 'new.operator@example.com', givenName: 'New', familyName: 'Operator' }] });
  });

  it('without a header row (the first line names no column): every line is data, by position', () => {
    const r = readTableCsv('new.operator@example.com,New,Operator\nsecond.user@example.com,Second,User,Viewer,extra field', COLUMNS);
    expect(r.headerless).toBe(true);
    expect(r.rows).toEqual([
      // a missing field is empty, an extra one ignored
      { email: 'new.operator@example.com', givenName: 'New', familyName: 'Operator', bundle: '' },
      { email: 'second.user@example.com', givenName: 'Second', familyName: 'User', bundle: 'Viewer' },
    ]);
    // a single line without a header is one row (not a header with no rows)
    expect(parseTableCsv('new.operator@example.com,New,Operator', COLUMNS)).toHaveLength(1);
    // without declared columns the first line stays the header
    expect(parseTableCsv('new.operator@example.com,New,Operator')).toEqual([]);
  });

  it('semicolons and tabs, quoted fields, blank lines and a BOM', () => {
    expect(parseTableCsv('\uFEFFnew.operator@example.com;"Operator; New";Operator\n\n', COLUMNS)).toEqual([
      { email: 'new.operator@example.com', givenName: 'Operator; New', familyName: 'Operator', bundle: '' },
    ]);
    expect(parseTableCsv('email\tgivenName\nnew.operator@example.com\tNew\r\nsecond.user@example.com\tSecond', COLUMNS)).toEqual([
      { email: 'new.operator@example.com', givenName: 'New' },
      { email: 'second.user@example.com', givenName: 'Second' },
    ]);
    expect(parseTableCsv('second.user@example.com\tSecond\tUser', COLUMNS)[0]).toMatchObject({ email: 'second.user@example.com', familyName: 'User' });
  });

  it('a required table that reads no rows is refused at start; an optional one is empty', () => {
    expect(coerceInputs([users], { users: 'new.operator@example.com,New,Operator' }).users).toHaveLength(1);
    const refused = (v: unknown) => {
      try {
        coerceInputs([users], { users: v });
      } catch (e) {
        return { status: (e as { statusCode?: number }).statusCode, message: (e as Error).message, code: (e as { code?: string }).code };
      }
      return null;
    };
    expect(refused('email,givenName,familyName,bundle\n')).toEqual({ status: 400, message: 'Users (CSV) has no rows', code: 'INPUT_TABLE_EMPTY' });
    expect(refused('Email;GivenName\n\n')).toMatchObject({ message: 'Users (CSV) has no rows' });
    expect(refused([])).toMatchObject({ status: 400 });
    expect(refused('')).toMatchObject({ status: 400, message: 'Input "Users (CSV)" is required' });
    expect(coerceInputs([{ ...users, required: false }], { users: 'email\n' }).users).toEqual([]);
    // a single-node debug run (lenient) reads what it gets
    expect(coerceInputs([users], { users: 'email\n' }, true).users).toEqual([]);
  });
});
