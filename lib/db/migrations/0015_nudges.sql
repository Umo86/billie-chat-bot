ALTER TABLE "settings" ADD COLUMN "nudge_after_hours" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "escalate_after_hours" integer DEFAULT 8 NOT NULL;