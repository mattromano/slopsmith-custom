import { test, expect } from '@playwright/test';

test('check for console errors', async ({ page }) => {
  const errors: string[] = [];
  const logs: string[] = [];
  
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });
  
  page.on('pageerror', error => {
    errors.push(`PAGE ERROR: ${error.message}\n${error.stack}`);
  });
  
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  
  // Wait for JS to load
  await page.waitForTimeout(3000);
  
  console.log('=== Console Errors ===');
  errors.forEach(e => console.log(e));
  console.log('=== All Logs ===');
  logs.forEach(l => console.log(l));
  
  // Assert no unexpected errors
  const allowedErrors = ['favicon.ico'];  // benign 404s and known noise
  const unexpected = errors.filter(e => !allowedErrors.some(a => e.includes(a)));
  console.log('Unexpected errors:', unexpected);
  expect(unexpected).toEqual([]);
});
