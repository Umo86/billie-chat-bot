ALTER TABLE "bots" ADD COLUMN "contact_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "flags" integer DEFAULT 0 NOT NULL;