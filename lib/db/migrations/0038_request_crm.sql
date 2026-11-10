ALTER TABLE "chat_requests" ADD COLUMN "crm_status" text;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD COLUMN "crm_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD COLUMN "crm_ids" jsonb;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD COLUMN "crm_sent_at" timestamp with time zone;