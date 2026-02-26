export function parseAmountToCents(value: string): number {
  const normalized = value.replace(/[,\s]/g, "").trim();
  if (!normalized) {
    return 0;
  }

  const sign = normalized.startsWith("-") ? -1 : 1;
  const unsigned = normalized.replace(/^[+-]/, "");
  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    return 0;
  }

  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const wholeCents = Number.parseInt(wholePart, 10) * 100;

  if (fractionPart.length === 0) {
    return sign * wholeCents;
  }

  const twoDigits = fractionPart.slice(0, 2).padEnd(2, "0");
  let fractionalCents = Number.parseInt(twoDigits, 10);

  if (fractionPart.length > 2) {
    const roundingDigit = Number.parseInt(fractionPart[2], 10);
    if (!Number.isNaN(roundingDigit) && roundingDigit >= 5) {
      fractionalCents += 1;
    }
  }

  return sign * (wholeCents + fractionalCents);
}
