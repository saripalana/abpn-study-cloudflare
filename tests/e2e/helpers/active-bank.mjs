import { expect } from "@playwright/test";

const SELECTED_BANK_KEY = "abpn-study:selected-bank";

export async function selectActiveBank(page, bankId) {
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: SELECTED_BANK_KEY, value: bankId },
  );
  await page.reload();
  await expectActiveBank(page, bankId);
}

export async function expectActiveBank(page, bankId) {
  await expect(page.locator("#app")).toHaveAttribute("data-active-bank-id", bankId);
}
