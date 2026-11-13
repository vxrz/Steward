import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';

test.use({ storageState: authFile('admin') });

/**
 * Dialogs with a form (web/src/components/FormModal.tsx): closed, they give the focus back to the button that opened
 * them (WCAG 2.4.3), and what was entered is not lost without asking – Esc, the ✕ and Cancel ask "Discard your
 * changes?" first, a click outside does nothing then. Shown with the New supplier dialog.
 */
test('a form dialog returns the focus to its opener and asks before discarding what was entered', async ({ page }) => {
  await page.goto('/suppliers');
  await expect(page.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();
  const opener = page.getByRole('main').getByRole('button', { name: 'New supplier' });
  const dialog = page.getByRole('dialog', { name: 'New supplier' });
  const discard = page.getByRole('dialog', { name: 'Discard your changes?' });

  // nothing entered: Esc closes at once, the focus is back on the button (not on the page's body)
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // something typed: Esc asks; keeping on editing keeps the text
  await page.keyboard.press('Enter');
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Invented Discard AG');
  await page.keyboard.press('Escape');
  await expect(discard).toBeVisible();
  await expect(discard).toContainText('What you entered in this dialog is not saved.');
  await expectAccessible(page, 'discard changes prompt');
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(discard).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Invented Discard AG');

  // Cancel asks as well; Discard closes and returns the focus
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // with something entered, a click outside keeps the dialog open (nothing entered: it closes)
  await page.keyboard.press('Enter');
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Invented Outside AG');
  await page.mouse.click(5, 450);
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Invented Outside AG');
  await expect(discard).toBeHidden();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Invented Discard AG')).toHaveCount(0);
});

/**
 * Dialogs that are not FormModals – most of them are mounted only while open, so Mantine cannot give the focus back –
 * return it as well (web/src/focusReturn.ts, WCAG 2.4.3). Shown with the New service dialog (Esc and Cancel).
 */
test('every dialog gives the focus back to the control that opened it', async ({ page }) => {
  await page.goto('/services');
  await expect(page.getByRole('heading', { name: 'Services', level: 1 })).toBeVisible();
  const opener = page.getByRole('main').getByRole('button', { name: 'New service' });
  const dialog = page.getByRole('dialog', { name: 'New service' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
