const { chromium } = require("/home/saf/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core");
const out = process.argv[2];
const scratch = process.env.KIROCREW_SCRATCH;
(async () => {
  const ext = "/home/saf/Projects/pinfield";
  const ctx = await chromium.launchPersistentContext(scratch + "/prof-shots", {
    executablePath: "/home/saf/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
    headless: true, viewport: { width: 1280, height: 800 },
    args: ["--headless=new", "--disable-extensions-except=" + ext, "--load-extension=" + ext],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto("https://www.pinterest.com/search/pins/?q=scandinavian%20interior", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000);
  await page.screenshot({ path: out + "/1-field.png" });
  // an open pin in the grid
  await page.mouse.click(640, 380); await page.waitForTimeout(3000);
  await page.mouse.move(20, 400);
  await page.waitForTimeout(500);
  await page.screenshot({ path: out + "/3-open-pin.png" });
  await page.keyboard.press("Escape"); await page.waitForTimeout(1200);
  // zoomed out
  await page.mouse.move(640, 400);
  for (let i = 0; i < 6; i++) { await page.keyboard.down("Control"); await page.mouse.wheel(0, 250); await page.keyboard.up("Control"); await page.waitForTimeout(120); }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: out + "/2-zoomed-out.png" });
  // explore
  await page.locator('pinfield-root [data-a="explore"]').click(); await page.waitForTimeout(6000);
  await page.screenshot({ path: out + "/4-explore.png" });
  await ctx.close();
})();
