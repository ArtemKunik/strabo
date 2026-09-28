import { ledgerClient } from '../integration/ledger';

export function orderDomain(store: string): string {
  return ledgerClient(store);
}
