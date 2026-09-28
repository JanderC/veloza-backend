import Decimal from "decimal.js";

export type CurrencyCode = "USD" | "EUR" | "COP" | "VES";

export interface Money {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
}

export function createMoney(amount: Decimal.Value, currency: CurrencyCode): Money {
  return { amount: new Decimal(amount), currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`No se pueden sumar montos de distinta moneda: ${a.currency} y ${b.currency}`);
  }
  return createMoney(a.amount.plus(b.amount), a.currency);
}

export function convertMoney(money: Money, targetCurrency: CurrencyCode, rate: Decimal.Value): Money {
  return createMoney(money.amount.mul(new Decimal(rate)), targetCurrency);
}

export function toSqlNumeric(money: Money): string {
  return money.amount.toFixed(4);
}