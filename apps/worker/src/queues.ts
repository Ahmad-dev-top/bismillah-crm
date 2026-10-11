/** Queue names and job payload shapes, shared by the worker and the scheduler. */

export const QUEUES = {
  billing: "billing",
  whatsapp: "whatsapp",
  notifications: "notifications",
  imports: "imports",
  reports: "reports",
  retry: "retry",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** The send job carries an ID and nothing else — never a phone number. */
export interface SendJob {
  notificationId: string;
}

export interface SweepJob {
  type: "TWO_DAY_REMINDER" | "FINAL_EXPIRY_WARNING";
  /** Override for backfills and tests; defaults to today in Karachi. */
  businessDate?: string;
}

export interface ImportJob {
  batchId: string;
  phase: "PARSE" | "COMMIT";
  actorId: string;
}
