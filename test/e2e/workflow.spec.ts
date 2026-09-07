/**
 * End-to-end test of the real application (spec §46).
 *
 * Drives the actual UI in a browser against a running Next.js server: enter a
 * URL, wait for the editor, select an element, remove it, undo, regenerate, and
 * download the PDF. Nothing is stubbed.
 */

import { test, expect } from '@playwright/test';
import type { Server } from 'node:http';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server';

let fixtureServer: Server;
let fixtureBaseUrl: string;

test.beforeAll(async () => {
  const started = await startFixtureServer();
  fixtureServer = started.server;
  fixtureBaseUrl = started.baseUrl;
});

test.afterAll(async () => {
  await stopFixtureServer(fixtureServer);
});

test.describe('full conversion workflow', () => {
  test('converts a page, edits it, and downloads a PDF', async ({ page }) => {
    // --- 1. URL entry -----------------------------------------------------
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /clean A4 PDF/i })).toBeVisible();

    await page.getByLabel('Web address').fill(`${fixtureBaseUrl}/article.html`);
    await page.getByRole('button', { name: 'Create PDF' }).click();

    // --- 2. Progress, then the editor -------------------------------------
    await expect(page).toHaveURL(/\/editor\//, { timeout: 90_000 });

    // Both panes must be present (§13).
    const cleanPane = page.getByLabel('Cleaned web page editor');
    const pdfPane = page.getByLabel('PDF preview');
    await expect(cleanPane).toBeVisible();
    await expect(pdfPane).toBeVisible();

    // --- 3. The cleaner's work is reported --------------------------------
    await expect(page.getByText(/ads removed/)).toBeVisible();
    await expect(page.getByText(/popups removed/)).toBeVisible();

    // --- 4. The cleaned document renders inside the sandboxed frame -------
    const frame = page.frameLocator('iframe[title="Cleaned web page"]');
    await expect(frame.locator('h1')).toContainText('Tidal Power', { timeout: 30_000 });
    // Noise must be absent from what the user sees.
    await expect(frame.getByText('Accept all cookies')).toHaveCount(0);
    await expect(frame.getByText('Subscribe to our newsletter')).toHaveCount(0);

    // --- 5. The PDF preview renders real pages ----------------------------
    await expect(pdfPane.locator('canvas.pdf-page-canvas').first()).toBeVisible({
      timeout: 60_000,
    });

    // --- 6. Select an element and remove it (§12) -------------------------
    const paragraph = frame.locator('p').filter({ hasText: 'Tidal energy has spent' }).first();
    await expect(paragraph).toBeVisible();
    await paragraph.click();

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Remove' }).click();

    // The element disappears from the editor view.
    await expect(
      page
        .frameLocator('iframe[title="Cleaned web page"]')
        .getByText('Tidal energy has spent four decades'),
    ).toHaveCount(0, { timeout: 30_000 });

    // --- 7. Undo restores it (§12) ----------------------------------------
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(
      page
        .frameLocator('iframe[title="Cleaned web page"]')
        .getByText('Tidal energy has spent four decades'),
    ).toHaveCount(1, { timeout: 30_000 });

    // --- 8. Regenerate the PDF --------------------------------------------
    await page.getByRole('button', { name: /Regenerate/ }).click();
    await expect(page.getByRole('button', { name: /Regenerate/ })).toBeEnabled({
      timeout: 90_000,
    });

    // --- 9. Download the final PDF ----------------------------------------
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download PDF' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);

    // Real, non-trivial PDF bytes.
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  test('shows a friendly error for an unreachable address', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Web address').fill('https://this-domain-does-not-exist-w2p.invalid');
    await page.getByRole('button', { name: 'Create PDF' }).click();

    const alert = page.locator('[role="alert"]').filter({ hasText: /[^\s]/ }).first();
    await expect(alert).toBeVisible({ timeout: 60_000 });
    // No stack traces or internal detail may reach the user (§28).
    await expect(alert).not.toContainText('Error:');
    await expect(alert).not.toContainText('at ');
    await expect(alert).not.toContainText('node_modules');
  });

  test('refuses dangerous URL schemes and never opens an editor session (§6)', async ({ page }) => {
    /*
     * NOTE ON COVERAGE: this suite runs the server with ALLOW_PRIVATE_TARGETS=1
     * so it can reach the loopback fixture server, which necessarily disables
     * the private-IP host policy. Testing 169.254.169.254 here would therefore
     * prove nothing about production.
     *
     * Protocol and credential checks are NOT relaxed by that flag, so they are
     * meaningful here. The full private-IP policy is covered by the unit suite
     * (src/core/url-validator) and the integration suite, both of which run
     * with production defaults.
     */
    await page.goto('/');
    await page.getByLabel('Web address').fill('file:///etc/passwd');
    await page.getByRole('button', { name: 'Create PDF' }).click();

    const alert = page.locator('[role="alert"]').filter({ hasText: /[^\s]/ }).first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(/http/i);
    // Must not have navigated to an editor session.
    await expect(page).not.toHaveURL(/\/editor\//);
  });
});
