export const REJECT_LABEL = {
  invalid_code: 'invalid code',
  expired: 'expired',
  wrong_event: 'wrong event',
  revoked: 'revoked',
  already_used: 'already used',
} as const;

export type RejectReason = keyof typeof REJECT_LABEL;

export type ScanResult =
  | { result: 'admit'; ticket_id: string; guest_name: string; event_id: string }
  | { result: 'reject'; reason: RejectReason };

export function formatScanResult(result: ScanResult): string {
  if (result.result === 'admit') return `ADMIT ${result.guest_name}`;
  return `REJECTED: ${REJECT_LABEL[result.reason]}`;
}
