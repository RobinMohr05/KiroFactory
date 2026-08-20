/**
 * Diagnostic script: debugs the usage panel black screen overlay bug.
 * Run: npx tsx backend/src/tests/usage-panel-debug.ts
 *
 * Requires: QA_EMAIL and QA_PASSWORD environment variables.
 */
import puppeteer from 'puppeteer';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://kirofactory-api.orangeriver-26cd2328.germanywestcentral.azurecontainerapps.io';
const SCREENSHOT_PATH = path.resolve(__dirname, '../../../tmp/usage-debug.png');

async function main() {
  const email = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;

  if (!email || !password) {
    console.error('ERROR: QA_EMAIL and QA_PASSWORD environment variables are required.');
    process.exit(1);
  }

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Capture console errors
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.on('pageerror', (err: any) => {
    consoleErrors.push(`[PAGE ERROR] ${err?.message ?? String(err)}`);
  });

  try {
    // 1. Navigate to login page
    console.log('Navigating to login page...');
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'networkidle2', timeout: 30000 });

    // 2. Log in
    console.log('Logging in...');
    await page.type('#loginEmail', email);
    await page.type('#loginPassword', password);
    await page.click('button[type="submit"]');

    // Wait for redirect to main dashboard
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log('Login successful, current URL:', page.url());

    // Wait a moment for full render
    await new Promise(r => setTimeout(r, 2000));

    // 3. Find and click the usage/money button
    console.log('Looking for usage button...');

    // Try multiple selectors for the usage badge/button
    const usageButtonSelectors = [
      '.usage-badge',
      'button[title*="usage"]',
      'button[title*="Usage"]',
      'button[aria-label*="usage"]',
      'button[aria-label*="cost"]',
      'button[aria-label*="EUR"]',
      'button[aria-label*="credits"]',
    ];

    let usageButton = null;
    for (const sel of usageButtonSelectors) {
      usageButton = await page.$(sel);
      if (usageButton) {
        console.log(`Found usage button with selector: ${sel}`);
        break;
      }
    }

    if (!usageButton) {
      // Try to find it by text content
      usageButton = await page.evaluateHandle(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.includes('EUR') || btn.textContent?.includes('credit')) {
            return btn;
          }
        }
        return null;
      });
      if (usageButton && (usageButton as any).asElement()) {
        console.log('Found usage button by text content');
        usageButton = (usageButton as any).asElement();
      } else {
        usageButton = null;
      }
    }

    if (!usageButton) {
      console.error('ERROR: Could not find usage button!');
      // Dump all header buttons for debugging
      const headerButtons = await page.evaluate(() => {
        const btns = document.querySelectorAll('.header-actions button, .header button, header button');
        return Array.from(btns).map(b => ({
          tag: b.tagName,
          className: b.className,
          title: b.getAttribute('title'),
          ariaLabel: b.getAttribute('aria-label'),
          text: b.textContent?.trim().substring(0, 50),
          innerHTML: b.innerHTML.substring(0, 100),
        }));
      });
      console.log('Header buttons found:', JSON.stringify(headerButtons, null, 2));
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      console.log(`Screenshot saved to ${SCREENSHOT_PATH}`);
      await browser.close();
      return;
    }

    // Click the usage button
    console.log('Clicking usage button...');
    await usageButton.click();
    await new Promise(r => setTimeout(r, 2000));

    // 4. Capture the state of any overlays/modals/panels
    console.log('\n=== DOM STATE AFTER CLICKING USAGE BUTTON ===\n');

    const overlayState = await page.evaluate(() => {
      const results: any[] = [];

      // Check for any visible overlays / modals / panels
      const selectors = [
        '.modal-backdrop:not([hidden])',
        '.overlay:not([hidden])',
        '[class*="overlay"]:not([hidden])',
        '[class*="modal"]:not([hidden])',
        '[class*="usage"]',
        '[class*="panel"]',
        '#panel-usage',
        '[id*="usage"]',
        '[role="tabpanel"]:not([hidden])',
      ];

      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        elements.forEach(el => {
          const styles = window.getComputedStyle(el);
          results.push({
            selector: sel,
            tag: el.tagName,
            id: el.id,
            className: el.className,
            display: styles.display,
            visibility: styles.visibility,
            opacity: styles.opacity,
            zIndex: styles.zIndex,
            position: styles.position,
            background: styles.background?.substring(0, 100),
            backgroundColor: styles.backgroundColor,
            width: styles.width,
            height: styles.height,
            innerHTML: el.innerHTML.substring(0, 500),
            childCount: el.children.length,
          });
        });
      }

      // Also check if there's a root element and what its state is
      const root = document.getElementById('root');
      if (root) {
        results.push({
          selector: '#root',
          tag: 'DIV',
          id: 'root',
          className: root.className,
          childCount: root.children.length,
          innerHTML: root.innerHTML.substring(0, 1000),
        });
      }

      // Check if body has any overlay elements as direct children
      const bodyOverlays = document.querySelectorAll('body > [style*="position: fixed"], body > [style*="position:fixed"]');
      bodyOverlays.forEach(el => {
        const styles = window.getComputedStyle(el);
        results.push({
          selector: 'body > fixed-position',
          tag: el.tagName,
          id: el.id,
          className: el.className,
          display: styles.display,
          backgroundColor: styles.backgroundColor,
          zIndex: styles.zIndex,
          innerHTML: el.innerHTML.substring(0, 300),
        });
      });

      return results;
    });

    console.log('Overlay/modal/panel state:');
    console.log(JSON.stringify(overlayState, null, 2));

    // Also check active tab state
    const activeTabState = await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"]');
      return Array.from(tabs).map(tab => ({
        id: tab.id,
        text: tab.textContent?.trim(),
        ariaSelected: tab.getAttribute('aria-selected'),
        className: tab.className,
      }));
    });
    console.log('\nTab state:');
    console.log(JSON.stringify(activeTabState, null, 2));

    // Check all elements with high z-index
    const highZIndex = await page.evaluate(() => {
      const all = document.querySelectorAll('*');
      const results: any[] = [];
      all.forEach(el => {
        const styles = window.getComputedStyle(el);
        const z = parseInt(styles.zIndex, 10);
        if (z > 10 && styles.display !== 'none' && styles.visibility !== 'hidden') {
          results.push({
            tag: el.tagName,
            id: el.id,
            className: el.className?.substring(0, 100),
            zIndex: z,
            position: styles.position,
            backgroundColor: styles.backgroundColor,
            width: styles.width,
            height: styles.height,
          });
        }
      });
      return results.sort((a, b) => b.zIndex - a.zIndex);
    });
    console.log('\nHigh z-index elements:');
    console.log(JSON.stringify(highZIndex, null, 2));

    // Take screenshot
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log(`\nScreenshot saved to ${SCREENSHOT_PATH}`);

    // Console errors
    if (consoleErrors.length > 0) {
      console.log('\n=== CONSOLE ERRORS ===');
      consoleErrors.forEach(e => console.log(e));
    } else {
      console.log('\nNo console errors detected.');
    }

  } catch (err) {
    console.error('Script error:', err);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log(`Screenshot saved to ${SCREENSHOT_PATH}`);
  } finally {
    await browser.close();
  }
}

main();
