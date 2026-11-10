CREATE TYPE "public"."answer_length" AS ENUM('short', 'normal', 'detailed');--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "launcher_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "answer_length" "answer_length" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "use_name" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "avoid_words" text DEFAULT '' NOT NULL;