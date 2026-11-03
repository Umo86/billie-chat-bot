ALTER TABLE "email_threads" ADD COLUMN "sent_outcome" text;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "sent_text" text;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "sent_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "learning" jsonb;