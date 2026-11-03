ALTER TABLE "exhibitor_codes" ALTER COLUMN "exhibitor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "signed_in_email" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "signed_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exhibitor_codes" ADD COLUMN "email_hash" text;--> statement-breakpoint
ALTER TABLE "exhibitor_lists" ADD COLUMN "hidden_columns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "sending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;